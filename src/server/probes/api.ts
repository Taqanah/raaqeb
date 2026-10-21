/**
 * The probe API (ADR-0012), version 1: `GET /api/probe/v1/assignments` and
 * `POST /api/probe/v1/results`, behind a probe token. The token is judged
 * before anything is read but the one probe it names; an address that keeps
 * sending a wrong token is refused before any read at all, and a probe past
 * its own limit is refused too. A probe's contact is written at most every
 * 30 seconds.
 */

import { z } from "zod";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import type { LocationRequests } from "@/server/scheduler/scheduler.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { probesMax } from "@/shared/schemas/monitor.ts";
import {
  type Probe,
  type ProbeAssignments,
  type ProbeReceipt,
  type ProbeResult,
  probeResultSchema,
  probeVersionHeader,
  resultsMax,
  roundTripHeader,
} from "@/shared/schemas/probe.ts";
import { reasonNameSchema } from "@/shared/schemas/reason.ts";
import { hashProbeToken } from "./probes.ts";

/** At most this many requests a minute per probe. */
export const probeRequestsPerMinute = 120;
/** At most this many refused tokens a minute per client address. */
export const refusalsPerMinute = 10;
/** The wrong-token counts hold at most this many addresses. */
export const refusalAddressesMax = 10_000;
/** A probe's contact is written no more often than this. */
export const contactWriteMs = 30_000;

const minuteMs = 60_000;

/** The in-memory counts the limits keep. */
export interface ProbeGate {
  /** Whether the probe may make one more request at `now`; counts it. */
  readonly admit: (probeId: string, now: number) => boolean;
  /** Whether the address has sent too many wrong tokens to be heard at `now`. */
  readonly barred: (address: string, now: number) => boolean;
  /** Notes whether the probe's push was taken or refused whole. */
  readonly pushed: (probeId: string, refused: boolean) => void;
  /** Counts a wrong token from the address. */
  readonly refused: (address: string, now: number) => void;
  /** Whether the probe's latest push was refused whole. */
  readonly refusedPush: (probeId: string) => boolean;
  /** How many addresses the wrong-token counts hold now. */
  readonly tracked: () => number;
}

/** A count per key in fixed one-minute windows, holding at most `max` keys: windows past their minute go in one sweep a minute at most, and past the bound the oldest key goes first. */
function windows(max: number) {
  const counts = new Map<string, { count: number; from: number }>();
  let sweptAt = Number.NEGATIVE_INFINITY;
  const current = (key: string, now: number) => {
    const held = counts.get(key);
    return held && now - held.from < minuteMs ? held : undefined;
  };
  return {
    add: (key: string, now: number): number => {
      if (now - sweptAt >= minuteMs) {
        sweptAt = now;
        for (const [each, held] of counts) {
          if (now - held.from >= minuteMs) {
            counts.delete(each);
          }
        }
      }
      const held = current(key, now) ?? { count: 0, from: now };
      held.count += 1;
      // Written again so the key is the newest; a map keeps insertion order.
      counts.delete(key);
      counts.set(key, held);
      if (counts.size > max) {
        const oldest = counts.keys().next().value;
        if (oldest !== undefined) {
          counts.delete(oldest);
        }
      }
      return held.count;
    },
    count: (key: string, now: number) => current(key, now)?.count ?? 0,
    size: () => counts.size,
  };
}

/** An address as the wrong-token counts key it: an IPv6 address by its /64, which one host or one network holds whole. */
function addressKey(address: string): string {
  if (!address.includes(":")) {
    return address;
  }
  const [head = "", tail = ""] = address.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const groups = address.includes("::")
    ? [
        ...front,
        ...new Array(Math.max(0, 8 - front.length - back.length)).fill("0"),
        ...back,
      ]
    : front;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export function createProbeGate(): ProbeGate {
  const requests = windows(probesMax);
  const refusals = windows(refusalAddressesMax);
  const refusedPushes = new Set<string>();
  return {
    admit: (probeId, now) =>
      requests.add(probeId, now) <= probeRequestsPerMinute,
    barred: (address, now) =>
      refusals.count(addressKey(address), now) >= refusalsPerMinute,
    pushed: (probeId, refused) => {
      if (refused) {
        refusedPushes.add(probeId);
      } else {
        refusedPushes.delete(probeId);
      }
    },
    refused: (address, now) => {
      refusals.add(addressKey(address), now);
    },
    refusedPush: (probeId) => refusedPushes.has(probeId),
    tracked: () => refusals.size(),
  };
}

/** What a request of the API reaches: the open storage and its scheduler, none before onboarding chose a database. */
export interface ProbeApiContext {
  readonly gate: ProbeGate;
  readonly now: number;
  readonly scheduler:
    | Pick<LocationRequests, "assignmentsOf" | "report">
    | undefined;
  readonly storage: Pick<Storage, "probes"> | undefined;
}

const bearer = /^Bearer\s+(\S+)$/i;

const empty = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { headers, status });

const json = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...headers,
    },
  });

/** The probe the request's token names, or the answer that refuses it. */
async function probeOf(
  context: ProbeApiContext,
  request: Request
): Promise<Probe | Response> {
  const { gate, now, storage } = context;
  if (!storage) {
    return empty(404);
  }
  const address = request.headers.get(clientAddressHeader) ?? "";
  const token = bearer.exec(request.headers.get("authorization") ?? "")?.[1];
  // A lookup by the token's hash: an index on a digest says nothing about the token. A probe's own token is heard whatever its address sent before, so probes behind one address never lock each other out.
  const probe =
    token === undefined
      ? undefined
      : await storage.probes.byTokenHash(hashProbeToken(token));
  if (!probe) {
    if (gate.barred(address, now)) {
      return empty(429, { "retry-after": "60" });
    }
    gate.refused(address, now);
    return empty(401, { "www-authenticate": "Bearer" });
  }
  if (!gate.admit(probe.id, now)) {
    return empty(429, { "retry-after": "60" });
  }
  await noteContact(storage, probe, request, now);
  return probe;
}

/** Writes the probe's contact when the last one is 30 seconds old or its build changed; a failed write is logged and the request goes on. */
async function noteContact(
  storage: Pick<Storage, "probes">,
  probe: Probe,
  request: Request,
  now: number
): Promise<void> {
  const version = request.headers.get(probeVersionHeader)?.slice(0, 40);
  const said = request.headers.get(roundTripHeader);
  const roundTrip =
    said === null || said.trim() === "" ? Number.NaN : Number(said);
  if (
    probe.lastSeenAt !== undefined &&
    now - probe.lastSeenAt < contactWriteMs &&
    version === probe.version
  ) {
    return;
  }
  try {
    await storage.probes.seen(probe.id, {
      at: now,
      roundTripMs:
        Number.isInteger(roundTrip) && roundTrip >= 0 && roundTrip < 600_000
          ? roundTrip
          : undefined,
      version,
    });
  } catch (cause) {
    logError(
      `the contact of the probe ${probe.id} was not recorded: ${reasonOf(cause)}`
    );
  }
}

/** The assignments as the probe reads them, and their tag. */
function tagged(assignments: ProbeAssignments): { body: string; tag: string } {
  const body = JSON.stringify(assignments);
  return { body, tag: `"${Bun.hash(body).toString(36)}"` };
}

/** A database that does not answer is a 503, never an error out of the route. */
async function answering(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (cause) {
    logError(`the probe API could not answer: ${reasonOf(cause)}`);
    return empty(503, { "retry-after": "5" });
  }
}

/** `GET /api/probe/v1/assignments`. */
export function answerAssignments(
  context: ProbeApiContext,
  request: Request
): Promise<Response> {
  return answering(async () => {
    const probe = await probeOf(context, request);
    if (probe instanceof Response) {
      return probe;
    }
    const assignments = context.scheduler?.assignmentsOf(probe.id);
    if (!assignments) {
      return empty(503, { "retry-after": "5" });
    }
    const { body, tag } = tagged(assignments);
    if (request.headers.get("if-none-match") === tag) {
      return empty(304, { etag: tag });
    }
    return json(body, { etag: tag });
  });
}

/** The results a push carries that this install can take: up to `resultsMax`, each judged on its own, a reason it does not know read as unknown; how many it dropped. */
export function takenResults(body: unknown): {
  readonly dropped: number;
  readonly results: ProbeResult[];
} {
  const listed = pushSchema.parse(body).results;
  const results: ProbeResult[] = [];
  for (const each of listed.slice(0, resultsMax)) {
    const parsed = probeResultSchema.safeParse(withKnownReason(each));
    if (parsed.success) {
      results.push(parsed.data);
    }
  }
  return { dropped: listed.length - results.length, results };
}

const pushSchema = z.object({ results: z.array(z.unknown()) });

/** A result whose reason a newer probe named, as this install reads it: unknown, with no detail whose parameters it could not read. */
function withKnownReason(result: unknown): unknown {
  if (
    typeof result !== "object" ||
    result === null ||
    !("reason" in result) ||
    reasonNameSchema.safeParse(result.reason).success
  ) {
    return result;
  }
  const { detail: _, ...rest } = result as Record<string, unknown>;
  return { ...rest, reason: "unknown" };
}

/** `POST /api/probe/v1/results`. */
export function answerResults(
  context: ProbeApiContext,
  request: Request
): Promise<Response> {
  return answering(async () => {
    const probe = await probeOf(context, request);
    if (probe instanceof Response) {
      return probe;
    }
    const { scheduler } = context;
    const assignments = scheduler?.assignmentsOf(probe.id);
    if (!(scheduler && assignments)) {
      return empty(503, { "retry-after": "5" });
    }
    let taken: ReturnType<typeof takenResults>;
    try {
      taken = takenResults(await request.json());
    } catch {
      context.gate.pushed(probe.id, true);
      return empty(400);
    }
    context.gate.pushed(probe.id, false);
    scheduler.report(probe.id, taken.results, context.now);
    const receipt: ProbeReceipt = {
      assignments: tagged(assignments).tag,
      dropped: taken.dropped,
    };
    return json(JSON.stringify(receipt));
  });
}

/** The limits of every request the entry hands the API, held for the life of the process. */
export const probeGate = createProbeGate();

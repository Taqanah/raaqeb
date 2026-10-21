/**
 * The probe process (CONTEXT.md "Probe"; ADR-0012): `raaqeb probe`, with no
 * database and no admin area. It pulls its assignments from the install,
 * checks them on the scheduler's own rules, keeps only each monitor's latest
 * result, and pushes them back; every connection starts here. A result
 * carries its age on this process's monotonic clock, never a time of day.
 */
import type { LiveIo } from "@/server/checks/io.ts";
import { runCheck } from "@/server/checks/run.ts";
import { reasonOf } from "@/server/log.ts";
import {
  afterCheck,
  dueMonitors,
  reconcileSchedule,
  type Schedule,
  spreadFirstRuns,
} from "@/server/scheduler/schedule.ts";
import { isOrigin } from "@/shared/schemas/address.ts";
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import {
  assignmentsPath,
  type ProbeAssignment,
  type ProbeResult,
  probeAssignmentsSchema,
  probeReceiptSchema,
  probeVersionHeader,
  resultsMax,
  resultsPath,
  roundTripHeader,
} from "@/shared/schemas/probe.ts";
import { reasonName } from "@/shared/schemas/reason.ts";

/** The install's assignments are asked for again this often. */
export const pullPeriodMs = 30_000;
/** Held results are pushed at most this often. */
export const pushPeriodMs = 1000;
/** The probe looks for due checks this often. */
export const probeTickMs = 1000;
/** A request to the install gives up after this long. */
const requestTimeoutMs = 15_000;
/** A failure the probe logs is logged at most this often. */
const logPeriodMs = 60_000;

export interface ProbeOptions {
  readonly fetch: typeof fetch;
  readonly io: LiveIo;
  readonly log: (line: string) => void;
  /** A clock that never jumps, in milliseconds. */
  readonly monotonic: () => number;
  /** At most this many results a push; the protocol's limit by default. */
  readonly resultsPerPush?: number;
  /** The install's public address, an origin. */
  readonly server: string;
  readonly token: string;
  /** This build, sent with every request. */
  readonly version: string;
}

export interface ProbeProcess {
  /** Resolves once no check or request is under way; tests wait on it. */
  readonly idle: () => Promise<void>;
  /** Ticks now and then every period. */
  readonly start: () => void;
  /** Stops the timer; a check still in flight is not pushed. */
  readonly stop: () => Promise<void>;
  /** Pulls when due, starts the due checks, pushes what is held. */
  readonly tick: () => Promise<void>;
}

/** An assignment as the schedule reads it: always running, since the install sends no paused monitor. */
type Assigned = ProbeAssignment & { readonly paused: false };

/** A check's result held until the install takes it, with when it started on the monotonic clock. */
interface Held {
  readonly outcome: CheckOutcome;
  readonly startedAt: number;
  /** The monitor's change time its check ran against. */
  readonly updatedAt: number;
}

/** The time zone the schedule reads a cron expression in; a probe runs none. */
const utc = "UTC";

export function createProbe(options: ProbeOptions): ProbeProcess {
  const { io, monotonic } = options;
  const perPush = options.resultsPerPush ?? resultsMax;
  let schedule: Schedule<Assigned> | undefined;
  let tag: string | undefined;
  let pulledAt: number | undefined;
  let pushedAt: number | undefined;
  let roundTripMs: number | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Map<string, Held>();
  const inFlight = new Map<string, Promise<void>>();
  const loggedAt = new Map<string, number>();

  /** A failure, logged at most once a minute per kind. */
  function note(kind: string, line: string): void {
    const now = monotonic();
    const last = loggedAt.get(kind);
    if (last === undefined || now - last >= logPeriodMs) {
      loggedAt.set(kind, now);
      options.log(line);
    }
  }

  /** One request to the install with the token, the build and the last round trip; nothing when it did not answer. */
  async function ask(
    path: string,
    init: RequestInit
  ): Promise<Response | undefined> {
    const started = monotonic();
    try {
      const response = await options.fetch(`${options.server}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${options.token}`,
          [probeVersionHeader]: options.version,
          ...(roundTripMs !== undefined && {
            [roundTripHeader]: String(roundTripMs),
          }),
          ...init.headers,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      roundTripMs = Math.max(0, Math.round(monotonic() - started));
      if (response.status === 401) {
        note(
          "token",
          "the install refuses this probe's token (RAAQEB_PROBE_TOKEN); make a new one on its locations page"
        );
      } else if (response.status !== 200 && response.status !== 304) {
        note(
          `status ${response.status}`,
          `the install answered ${response.status} to ${path}${response.status === 429 ? ": too many requests, waiting" : ""}`
        );
      }
      return response;
    } catch (cause) {
      note(
        "reach",
        `the install at RAAQEB_PROBE_SERVER did not answer: ${reasonOf(cause)}`
      );
    }
  }

  async function pull(now: number): Promise<void> {
    pulledAt = now;
    const response = await ask(assignmentsPath, {
      headers: tag === undefined ? {} : { "if-none-match": tag },
    });
    if (response?.status !== 200) {
      return;
    }
    const parsed = probeAssignmentsSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (!parsed.success) {
      note(
        "shape",
        "the install's assignments do not fit this probe's protocol; upgrade the probe to the install's version"
      );
      return;
    }
    tag = response.headers.get("etag") ?? undefined;
    const assigned = parsed.data.monitors.map(
      (monitor): Assigned => ({ ...monitor, paused: false })
    );
    // A result held for a monitor gone, or changed since its check, says nothing of it now.
    const current = new Map(
      assigned.map((monitor) => [monitor.id, monitor.updatedAt])
    );
    for (const [id, each] of held) {
      if (current.get(id) !== each.updatedAt) {
        held.delete(id);
      }
    }
    schedule = schedule
      ? reconcileSchedule(schedule, assigned, now, utc)
      : spreadFirstRuns(assigned, now, utc);
  }

  function start(monitor: Assigned, now: number): void {
    const run = runCheck(monitor, io);
    if (!(run && schedule)) {
      return;
    }
    schedule = afterCheck(schedule, monitor.id, now, utc);
    const flight = run
      .then((outcome) => {
        // A monitor unassigned or changed while its check ran has no result to give.
        if (
          !stopped &&
          schedule?.get(monitor.id)?.monitor.updatedAt === monitor.updatedAt
        ) {
          held.set(monitor.id, {
            outcome,
            startedAt: now,
            updatedAt: monitor.updatedAt,
          });
        }
      })
      .catch((cause: unknown) => {
        note("check", `a check failed to run: ${reasonOf(cause)}`);
      })
      .finally(() => inFlight.delete(monitor.id));
    inFlight.set(monitor.id, flight);
  }

  /** Pushes what is held, no more than a push may carry at a time, until the install stops taking it. */
  async function push(now: number): Promise<void> {
    pushedAt = now;
    const all = [...held.entries()];
    for (let at = 0; at < all.length; at += perPush) {
      // biome-ignore lint/performance/noAwaitInLoops: one push after another, each the install's answer to go on
      if (!(await pushSome(all.slice(at, at + perPush), now))) {
        return;
      }
    }
  }

  /** One push; answers whether the install took it. */
  async function pushSome(
    sent: readonly [string, Held][],
    now: number
  ): Promise<boolean> {
    const results = sent.map(([, each]) => resultOf(each, now));
    const response = await ask(resultsPath, {
      body: JSON.stringify({ results }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (response?.status !== 200) {
      return false;
    }
    // What the install took, or dropped as unreadable, is not sent again; a newer result that landed while the push was out waits for the next one.
    for (const [id, each] of sent) {
      if (held.get(id) === each) {
        held.delete(id);
      }
    }
    const receipt = probeReceiptSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (receipt.success && receipt.data.dropped > 0) {
      note(
        "dropped",
        `the install dropped ${receipt.data.dropped} results it could not read; run the probe at the install's version`
      );
    }
    if (receipt.success && receipt.data.assignments !== tag) {
      // The assignments moved: pull at the next tick.
      pulledAt = undefined;
    }
    return true;
  }

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }
    const now = monotonic();
    if (pulledAt === undefined || now - pulledAt >= pullPeriodMs) {
      await pull(now);
    }
    if (schedule) {
      for (const monitor of dueMonitors(
        schedule,
        new Set(inFlight.keys()),
        now
      )) {
        start(monitor, now);
      }
    }
    if (
      held.size > 0 &&
      (pushedAt === undefined || now - pushedAt >= pushPeriodMs)
    ) {
      await push(now);
    }
  }

  function loop(): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      tick()
        .catch(() => undefined)
        .finally(loop);
    }, probeTickMs);
  }

  return {
    idle: async () => {
      await Promise.all(inFlight.values());
    },
    start: () => {
      stopped = false;
      tick()
        .catch(() => undefined)
        .finally(loop);
    },
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await Promise.all(inFlight.values());
    },
    tick,
  };
}

/** A held check as the protocol carries it: its age, never its time. */
function resultOf(each: Held, now: number): ProbeResult {
  const { check, detail } = each.outcome;
  return {
    ageMs: Math.max(0, Math.round(now - each.startedAt)),
    attempts: check.attempts,
    bytes: check.bytes,
    detail: detail && {
      assertion: detail.assertion,
      error: detail.error,
      params: detail.params,
    },
    monitorId: check.monitorId,
    reason: reasonName(check.reason) ?? "unknown",
    responseMs: check.responseMs,
    result: check.result,
    statusCode: check.statusCode,
  };
}

/** Where the probe reports and with what, from its environment. */
export type ProbeTarget =
  | { readonly ok: true; readonly server: string; readonly token: string }
  | { readonly message: string; readonly ok: false };

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `RAAQEB_PROBE_SERVER`, an origin that is https or a loopback http one, and `RAAQEB_PROBE_TOKEN`; the message names a variable, never its value. */
export function probeTarget(
  env: Readonly<Record<string, string | undefined>>
): ProbeTarget {
  const given = env.RAAQEB_PROBE_SERVER?.trim();
  if (!given) {
    return {
      message:
        "RAAQEB_PROBE_SERVER is not set: give the install's public address, as https://status.example.com",
      ok: false,
    };
  }
  const url = URL.parse(given);
  const server = url?.origin;
  if (!(url && server && isOrigin(server))) {
    return {
      message: `RAAQEB_PROBE_SERVER is not an address (${given.length} characters)`,
      ok: false,
    };
  }
  if (url.protocol !== "https:" && !loopbackHosts.has(url.hostname)) {
    return {
      message:
        "RAAQEB_PROBE_SERVER must be https: the probe token and any shared credentials would cross the network in clear",
      ok: false,
    };
  }
  const token = env.RAAQEB_PROBE_TOKEN?.trim();
  if (!token) {
    return {
      message:
        "RAAQEB_PROBE_TOKEN is not set: give the token the install's locations page showed",
      ok: false,
    };
  }
  return { ok: true, server, token };
}

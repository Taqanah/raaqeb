/**
 * Liveness: the scheduler's last tick, judged against two
 * bounds, and `GET /health` over it. The endpoint answers 200 with a small
 * JSON body when the database answers and the scheduler ticked within the
 * stale bound, 503 otherwise, and 200 during onboarding, when there is
 * nothing to tick yet and a load balancer must still let the operator in. `raaqeb health` calls the endpoint and exits 0 or
 * 1, which is what the Docker HEALTHCHECK runs.
 */

import type { Storage } from "@/server/storage/storage.ts";
import type { HealthReport } from "@/shared/schemas/health.ts";

/** What the endpoint reads of the scheduler: when it last ticked, or nothing before the first tick. */
export interface Liveness {
  readonly lastTickAt: () => number | undefined;
}

/** A tick older than this makes `/health` answer 503: two default check intervals. */
export const staleAfterMs = 120_000;

/** A tick older than this makes the process exit non-zero, so the supervisor restarts it. */
export const exitAfterMs = 300_000;

/** `ok` within the stale bound, `stale` past it, `dead` past the exit bound; no tick at all is `stale`. */
export type TickVerdict = "ok" | "stale" | "dead";

export function tickVerdict(
  lastTickAt: number | undefined,
  now: number
): TickVerdict {
  if (lastTickAt === undefined) {
    return "stale";
  }
  const since = now - lastTickAt;
  if (since >= exitAfterMs) {
    return "dead";
  }
  return since >= staleAfterMs ? "stale" : "ok";
}

/** The report now: onboarding without a storage; otherwise the database is asked one question and the last tick is judged. */
export async function healthReport(
  storage: Pick<Storage, "changeCounter"> | undefined,
  liveness: Liveness | undefined,
  now: number
): Promise<HealthReport> {
  if (!storage) {
    return { ok: true, onboarding: true };
  }
  const database = await storage.changeCounter().then(
    () => "ok" as const,
    () => "unreachable" as const
  );
  const scheduler =
    tickVerdict(liveness?.lastTickAt(), now) === "ok" ? "ok" : "stale";
  return { database, ok: database === "ok" && scheduler === "ok", scheduler };
}

/** The response for a report: 200 or 503, JSON, never cached. */
export function healthResponse(report: HealthReport): Response {
  return new Response(JSON.stringify(report), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    status: report.ok ? 200 : 503,
  });
}

const unspecified: Readonly<Record<string, string>> = {
  "0.0.0.0": "127.0.0.1",
  "::": "[::1]",
};

/** Where `raaqeb health` calls: the boot settings' port on the bind address, or the loopback address when the bind address is unspecified. */
export function healthUrl(host: string, port: number): string {
  const reached = unspecified[host] ?? host;
  const literal =
    reached.includes(":") && !reached.startsWith("[")
      ? `[${reached}]`
      : reached;
  return `http://${literal}:${port}/health`;
}

/** Calls the endpoint and answers the exit code: 0 on a 200, 1 on anything else, including no answer. */
export async function healthCommand(
  url: string,
  fetchFn: typeof fetch
): Promise<0 | 1> {
  try {
    const response = await fetchFn(url);
    return response.status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}

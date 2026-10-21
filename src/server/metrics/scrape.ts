/**
 * One scrape of `/metrics` (CONTEXT.md "Metrics endpoint"): the bearer
 * token is judged first and a refusal answers with no read of the monitors;
 * an accepted one reads the monitors, their latest checks, the certificate
 * records and the last seven days of each (the bars' read, which sums
 * today's checks in the database and holds no row per check), and renders
 * the text.
 */

import { error as logError, reasonOf } from "@/server/log.ts";
import { readMonitorDays } from "@/server/monitors/days.ts";
import { currentVersion } from "@/server/release/release.ts";
import type { BarDay } from "@/server/status/uptime.ts";
import { CheckShapeError } from "@/server/storage/checks.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { contentType, exposition, type MonitorSample } from "./exposition.ts";
import { judge } from "./token.ts";

export type ScrapeStorage = Pick<
  Storage,
  | "certificates"
  | "checks"
  | "components"
  | "maintenance"
  | "monitors"
  | "outages"
  | "settings"
>;

/** The days the uptime ratio spans, today's UTC day included. */
export const uptimeDays = 7;

/** The monitors' days for the uptime ratio; a monitor with a record this version cannot read is left out, so it has no ratio and the others keep theirs. */
async function uptimeDaysOf(
  storage: ScrapeStorage,
  monitors: readonly Monitor[],
  now: number
): Promise<Map<string, BarDay[]>> {
  let readable = monitors;
  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each attempt drops the monitor the last one named
      return await readMonitorDays(storage, readable, {
        days: uptimeDays,
        now,
      });
    } catch (thrown) {
      const rest = readable.filter(
        (monitor) =>
          !(thrown instanceof CheckShapeError) ||
          monitor.id !== thrown.monitorId
      );
      if (rest.length === readable.length) {
        throw thrown;
      }
      readable = rest;
    }
  }
}

export async function readSamples(
  storage: ScrapeStorage,
  now: number
): Promise<MonitorSample[]> {
  const [monitors, latest, certificates] = await Promise.all([
    storage.monitors.list(),
    storage.checks.latest(),
    storage.certificates.list(),
  ]);
  const days = await uptimeDaysOf(storage, monitors, now);
  const checks = new Map(latest.map((check) => [check.monitorId, check]));
  const expiries = new Map(
    certificates.map((record) => [record.monitorId, record.validTo])
  );
  return monitors.map((monitor) => {
    const check = checks.get(monitor.id);
    let downtime = 0;
    let observed = 0;
    for (const each of days.get(monitor.id) ?? []) {
      downtime += each.downtimeMs;
      observed += each.observedMs;
    }
    return {
      certificateExpiresAt: expiries.get(monitor.id),
      checkedAt: check?.startedAt,
      checkType: monitor.config.type,
      group: monitor.group ?? "",
      monitor: monitor.name,
      monitorId: monitor.id,
      paused: monitor.paused,
      responseMs: check?.responseMs,
      state: check?.result,
      uptime: observed > 0 ? 1 - downtime / observed : undefined,
    };
  });
}

/** The answer to a scrape request: 404 while the endpoint is off, 401 for a missing or wrong token, else the text. */
export async function scrape(
  storage: ScrapeStorage,
  authorization: string | null,
  now: number
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    const verdict = await judge(storage, authorization);
    if (verdict === "off") {
      return new Response(null, { headers, status: 404 });
    }
    if (verdict === "denied") {
      return new Response(null, {
        headers: { ...headers, "www-authenticate": "Bearer" },
        status: 401,
      });
    }
    return new Response(
      exposition(currentVersion, await readSamples(storage, now)),
      {
        headers: { ...headers, "content-type": contentType },
      }
    );
  } catch (thrown) {
    logError(`the metrics scrape failed: ${reasonOf(thrown)}`);
    return new Response(null, { headers, status: 503 });
  }
}

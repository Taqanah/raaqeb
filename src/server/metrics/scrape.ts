/**
 * One scrape of `/metrics` (CONTEXT.md "Metrics endpoint"): the bearer
 * token is judged first and a refusal answers with no read of the monitors;
 * an accepted one reads the monitors, their latest checks and the
 * certificate records, three queries that never touch history, and renders
 * the text. No uptime: it would read today's checks of every monitor, and
 * Prometheus derives it from `raaqeb_monitor_up` itself.
 */

import { error as logError, reasonOf } from "@/server/log.ts";
import { currentVersion } from "@/server/release/release.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { contentType, exposition, type MonitorSample } from "./exposition.ts";
import { judge } from "./token.ts";

export type ScrapeStorage = Pick<
  Storage,
  "certificates" | "checks" | "monitors" | "settings"
>;

export async function readSamples(
  storage: ScrapeStorage
): Promise<MonitorSample[]> {
  const [monitors, latest, certificates] = await Promise.all([
    storage.monitors.list(),
    storage.checks.latest(),
    storage.certificates.list(),
  ]);
  const checks = new Map(latest.map((check) => [check.monitorId, check]));
  const expiries = new Map(
    certificates.map((record) => [record.monitorId, record.validTo])
  );
  return monitors.map((monitor) => {
    const check = checks.get(monitor.id);
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
    };
  });
}

/** The answer to a scrape request: 404 while the endpoint is off, 401 for a missing or wrong token, else the text. */
export async function scrape(
  storage: ScrapeStorage,
  authorization: string | null
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
      exposition(currentVersion, await readSamples(storage)),
      {
        headers: { ...headers, "content-type": contentType },
      }
    );
  } catch (thrown) {
    logError(`the metrics scrape failed: ${reasonOf(thrown)}`);
    return new Response(null, { headers, status: 503 });
  }
}

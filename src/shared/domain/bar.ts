/**
 * The day bar's cells (CONTEXT.md "Day bar"): each UTC day
 * is coloured in steps by its uptime, on the status family:
 * 99.9% and over is operational, 99% degraded performance, 95% partial
 * outage, anything less major outage; a day with nothing observed is no
 * data. Shared, since the bar renders on the server and in the browser.
 */

import type { OverviewDay, UptimeFigure } from "@/shared/schemas/overview.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { displayedUptime } from "./uptime.ts";

/** The level a day's cell is coloured as, or nothing for a day with no data. */
export function cellLevel(
  uptime: UptimeFigure | null
): StatusLevel | undefined {
  if (!uptime) {
    return;
  }
  const { percent } = uptime;
  if (percent >= 99.9) {
    return "operational";
  }
  if (percent >= 99) {
    return "degraded_performance";
  }
  return percent >= 95 ? "partial_outage" : "major_outage";
}

/** The days a screen shows of a bar, by its width: a phone 30, a tablet 60, a wider one 90. */
const screenDays = [30, 60, 90] as const;

/** How many of a bar's last days each screen width shows, narrowest first; the widest shows the whole bar. */
export function barSpans(length: number): number[] {
  return [...screenDays.filter((days) => days < length), length];
}

/** The uptime over a bar's last `count` days, or none when nothing was observed in them. */
export function lastDaysUptime(
  days: readonly Pick<OverviewDay, "downtimeMs" | "observedMs">[],
  count: number
): UptimeFigure | undefined {
  let downtimeMs = 0;
  let observedMs = 0;
  for (const day of days.slice(-count)) {
    downtimeMs += day.downtimeMs;
    observedMs += day.observedMs;
  }
  return displayedUptime({ downtimeMs, observedMs });
}

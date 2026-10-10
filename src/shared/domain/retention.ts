/**
 * Retention (CONTEXT.md "Retention", "Day", ADR-0005): one
 * number of days bounds a monitor's check history in three tiers, raw
 * checks for the smaller of 30 days and the retention, hourly rollups for
 * the smaller of 90 days and the retention, daily rollups to the retention.
 * Every boundary is the start of a UTC day, so the nightly job keeps whole
 * days. Pure: `now` is a parameter.
 */

const dayMs = 86_400_000;

/** The raw tier's longest window in days. */
export const rawDaysMax = 30;

/** The hourly tier's longest window in days. */
export const hourlyDaysMax = 90;

/** How many days each tier keeps, for one retention. */
export interface RetentionWindows {
  readonly daily: number;
  readonly hourly: number;
  readonly raw: number;
}

/** Where each tier starts, UTC milliseconds: the history before it is past the retention and goes at the next nightly job. */
export interface RetentionBounds {
  /** Daily rollups before this go. */
  readonly daily: number;
  /** Hourly rollups before this go. */
  readonly hourly: number;
  /** Sealed days, head rows, failure details and captures before this go. */
  readonly raw: number;
}

/** The three windows of a retention in days. */
export function retentionWindows(retentionDays: number): RetentionWindows {
  return {
    daily: retentionDays,
    hourly: Math.min(hourlyDaysMax, retentionDays),
    raw: Math.min(rawDaysMax, retentionDays),
  };
}

/** The three bounds of a retention at `now`: each window's days back from the start of today, UTC, so today and that many whole days stay. */
export function retentionBounds(
  retentionDays: number,
  now: number
): RetentionBounds {
  const today = utcDayStart(now);
  const windows = retentionWindows(retentionDays);
  return {
    daily: today - windows.daily * dayMs,
    hourly: today - windows.hourly * dayMs,
    raw: today - windows.raw * dayMs,
  };
}

/** The start of the UTC day `at` falls in. */
export function utcDayStart(at: number): number {
  return Math.floor(at / dayMs) * dayMs;
}

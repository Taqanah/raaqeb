/**
 * Summing checks (CONTEXT.md "Rollup", "Sealed day", "Observed time"): the hourly and daily rollups the nightly sealing job writes
 * for one closed UTC day, and the chart's buckets from raw checks, from
 * rollups, or from both at once. Response times are of the up and degraded
 * checks only, the chart's rule: a down check's time is how long it took to
 * fail. Pure: every check and rollup is a parameter.
 */
import type { CheckResult } from "@/shared/schemas/check.ts";
import type { ResponseBucket } from "@/shared/schemas/detail.ts";
import { type Rollup, rollupSpanMs } from "@/shared/schemas/rollup.ts";
import { coverageOf, observedSpans, type Span, spansLength } from "./uptime.ts";

/** What summing reads of a check. */
export interface CheckPoint {
  readonly responseMs: number | undefined;
  readonly result: CheckResult;
  readonly startedAt: number;
}

/** One sealed day's rollups: the day's, and one per hour holding a check or observed time. */
export interface DayRollups {
  readonly daily: Rollup;
  /** Oldest first. */
  readonly hourly: readonly Rollup[];
}

/**
 * The rollups of the UTC day starting at `day`, from its checks, oldest
 * first. Observed time is read as uptime reads it, across the day's edges:
 * `before` is the monitor's last check before the day and `after` its first
 * check after it, when they exist.
 */
export function rollupsOfDay(input: {
  readonly after: number | undefined;
  readonly before: number | undefined;
  readonly checks: readonly CheckPoint[];
  readonly day: number;
  /** The spans maintenance windows covered the monitor, which leave its observed time. */
  readonly excluded: readonly Span[];
  readonly gapLimitMs: number;
  readonly monitorId: string;
}): DayRollups {
  const { checks, day, gapLimitMs, monitorId } = input;
  const times = checks.map((check) => check.startedAt);
  const observed = observedSpans(
    coverageOf(
      [
        ...(input.before === undefined ? [] : [input.before]),
        ...times,
        ...(input.after === undefined ? [] : [input.after]),
      ],
      gapLimitMs
    ),
    { from: day, to: day + rollupSpanMs.day },
    gapLimitMs,
    input.excluded
  );
  const hourly: Rollup[] = [];
  for (let at = day; at < day + rollupSpanMs.day; at += rollupSpanMs.hour) {
    const hour = { from: at, to: at + rollupSpanMs.hour };
    const inHour = checks.filter(
      (check) => check.startedAt >= hour.from && check.startedAt < hour.to
    );
    const observedMs = spansLength(clip(observed, hour));
    if (inHour.length > 0 || observedMs > 0) {
      hourly.push(rollupOf(monitorId, at, tallyOf(inHour), observedMs));
    }
  }
  return {
    daily: rollupOf(monitorId, day, tallyOf(checks), spansLength(observed)),
    hourly,
  };
}

/**
 * The chart's buckets over `[from, to)`, each `bucketMs` wide from `from`,
 * oldest first, a bucket with no check left out. Raw checks and rollups sum
 * into the same buckets; a rollup falls in the bucket its start does, and
 * its average weighs as many checks as it had up and degraded ones.
 */
export function bucketsOf(input: {
  readonly bucketMs: number;
  readonly checks: Iterable<CheckPoint>;
  readonly from: number;
  readonly rollups: Iterable<Rollup>;
  readonly to: number;
}): ResponseBucket[] {
  const { bucketMs, from, to } = input;
  const tallies = new Map<number, Tally>();
  const tallyAt = (at: number): Tally | undefined => {
    if (at < from || at >= to) {
      return;
    }
    const index = Math.floor((at - from) / bucketMs);
    let tally = tallies.get(index);
    if (!tally) {
      tally = emptyTally();
      tallies.set(index, tally);
    }
    return tally;
  };
  for (const check of input.checks) {
    const tally = tallyAt(check.startedAt);
    if (tally) {
      addCheck(tally, check);
    }
  }
  for (const rollup of input.rollups) {
    const tally = tallyAt(rollup.at);
    if (tally) {
      addRollup(tally, rollup);
    }
  }
  // An hour of rollups can hold observed time and no check; its bucket is left out like any empty one.
  return [...tallies]
    .filter(([, tally]) => tally.checks > 0)
    .toSorted(([a], [b]) => a - b)
    .map(([index, tally]) => ({
      at: from + index * bucketMs,
      averageMs: tally.timed > 0 ? tally.totalMs / tally.timed : undefined,
      checks: tally.checks,
      degraded: tally.degraded,
      down: tally.down,
      maxMs: tally.maxMs,
      minMs: tally.minMs,
    }));
}

/** Checks summed: counts, and the response times of the up and degraded ones. */
interface Tally {
  checks: number;
  degraded: number;
  down: number;
  maxMs: number | undefined;
  minMs: number | undefined;
  /** How many response times `totalMs` sums. */
  timed: number;
  totalMs: number;
}

function emptyTally(): Tally {
  return {
    checks: 0,
    degraded: 0,
    down: 0,
    maxMs: undefined,
    minMs: undefined,
    timed: 0,
    totalMs: 0,
  };
}

function addCheck(tally: Tally, check: CheckPoint): void {
  tally.checks += 1;
  if (check.result === "down") {
    tally.down += 1;
    return;
  }
  if (check.result === "degraded") {
    tally.degraded += 1;
  }
  if (check.responseMs !== undefined) {
    addTimes(tally, 1, check.responseMs, check.responseMs, check.responseMs);
  }
}

function addRollup(tally: Tally, rollup: Rollup): void {
  tally.checks += rollup.checks;
  tally.degraded += rollup.degraded;
  tally.down += rollup.failed;
  const timed = rollup.checks - rollup.failed;
  if (
    rollup.averageMs !== undefined &&
    rollup.minMs !== undefined &&
    rollup.maxMs !== undefined &&
    timed > 0
  ) {
    addTimes(
      tally,
      timed,
      rollup.averageMs * timed,
      rollup.minMs,
      rollup.maxMs
    );
  }
}

function addTimes(
  tally: Tally,
  count: number,
  totalMs: number,
  minMs: number,
  maxMs: number
): void {
  tally.timed += count;
  tally.totalMs += totalMs;
  tally.minMs =
    tally.minMs === undefined ? minMs : Math.min(tally.minMs, minMs);
  tally.maxMs =
    tally.maxMs === undefined ? maxMs : Math.max(tally.maxMs, maxMs);
}

function tallyOf(checks: readonly CheckPoint[]): Tally {
  const tally = emptyTally();
  for (const check of checks) {
    addCheck(tally, check);
  }
  return tally;
}

function rollupOf(
  monitorId: string,
  at: number,
  tally: Tally,
  observedMs: number
): Rollup {
  return {
    at,
    averageMs:
      tally.timed > 0 ? Math.round(tally.totalMs / tally.timed) : undefined,
    checks: tally.checks,
    degraded: tally.degraded,
    failed: tally.down,
    maxMs: tally.maxMs,
    minMs: tally.minMs,
    monitorId,
    observedMs,
  };
}

/** The spans cut to one span. */
function clip(spans: readonly Span[], to: Span): Span[] {
  return spans
    .map((span) => ({
      from: Math.max(span.from, to.from),
      to: Math.min(span.to, to.to),
    }))
    .filter((span) => span.from < span.to);
}

/**
 * A day's rollup summed from its hourly rollups, for a day an import
 * received as hours: the counts and observed time
 * add up, the lowest and highest are the extremes, and the average is
 * weighed by each hour's up and degraded checks.
 */
export function dailyOfHours(
  monitorId: string,
  day: number,
  hours: readonly Rollup[]
): Rollup {
  let timed = 0;
  let total = 0;
  const times: number[] = [];
  for (const hour of hours) {
    if (hour.averageMs !== undefined) {
      const weight = hour.checks - hour.failed;
      timed += weight;
      total += hour.averageMs * weight;
    }
    for (const time of [hour.minMs, hour.maxMs]) {
      if (time !== undefined) {
        times.push(time);
      }
    }
  }
  const sum = (field: "checks" | "degraded" | "failed" | "observedMs") =>
    hours.reduce((added, hour) => added + hour[field], 0);
  return {
    at: day,
    averageMs: timed === 0 ? undefined : Math.round(total / timed),
    checks: sum("checks"),
    degraded: sum("degraded"),
    failed: sum("failed"),
    maxMs: times.length === 0 ? undefined : Math.max(...times),
    minMs: times.length === 0 ? undefined : Math.min(...times),
    monitorId,
    observedMs: sum("observedMs"),
  };
}

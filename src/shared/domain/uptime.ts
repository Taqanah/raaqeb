/**
 * A monitor's uptime (CONTEXT.md "Uptime", "Downtime", "Observed time";
 * ADR-0005): one minus its downtime over its observed time inside
 * a window. Observed time is where Raaqeb had checks to judge the monitor
 * by: a check covers the span up to the next one, a gap longer than the
 * gap limit leaves the window whole, and maintenance windows are cut out.
 * Downtime is the outage time that falls inside observed time, so a gap or
 * a maintenance window never counts against the monitor. Inside the raw
 * window observed time comes from the checks; beyond it, from the observed
 * time on the hourly rollups. Displayed numbers never flatter:
 * rounded down, with more decimals until an outage shows.
 * Pure: `now` and every record are parameters.
 */

import { utcDayStart } from "./retention.ts";

/** A span of time, `from` included and `to` not, in UTC milliseconds. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** What the checks say about one monitor over a range: the first and last check, and every gap between two consecutive checks longer than the gap limit. */
export interface CheckCoverage {
  readonly first: number;
  /** Each from one check to the next, oldest first. */
  readonly gaps: readonly Span[];
  readonly last: number;
}

/** An outage as uptime reads it: open while it has no end. */
export interface OutageSpan {
  readonly endedAt: number | undefined;
  readonly startedAt: number;
}

/** The windows the monitor detail shows, each ending now. */
export const uptimeWindows = ["24h", "7d", "30d", "90d"] as const;
export type UptimeWindow = (typeof uptimeWindows)[number];

export const uptimeWindowMs: Readonly<Record<UptimeWindow, number>> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

/** How far back uptime reads the checks themselves at most (raw checks for 30 days, less with a shorter retention); older time reads the hourly rollups. */
export const rawWindowMs = 30 * 86_400_000;

/**
 * Where a monitor's uptime reads its checks rather than its hourly rollups:
 * the start of its raw window, or later, the start of the UTC day of its
 * oldest check still kept, once a size-budget delete took the raw days
 * before it and only their rollups remain; `now` with no check.
 */
export function rawFromOf(
  coverage: CheckCoverage | undefined,
  now: number,
  rawWindow: number
): number {
  if (!coverage) {
    return now;
  }
  return Math.max(now - rawWindow, utcDayStart(coverage.first));
}

/** An hourly rollup as uptime reads it: only its observed time (CONTEXT.md "Rollup"). */
export interface ObservedHour {
  /** The hour's start, UTC milliseconds. */
  readonly at: number;
  readonly observedMs: number;
}

/** One window's two durations; uptime is `1 - downtimeMs / observedMs`. */
export interface UptimeReading {
  readonly downtimeMs: number;
  readonly observedMs: number;
  readonly window: UptimeWindow;
}

/** Uptime as a screen shows it: a percentage rounded down to `decimals` places, or exactly 100 with none when there was no downtime. */
export interface DisplayedUptime {
  readonly decimals: number;
  readonly percent: number;
}

/** The coverage of check times sorted oldest first, duplicates allowed: the first, the last and every gap between two consecutive ones longer than the gap limit; nothing without a check. */
export function coverageOf(
  startedAt: Float64Array | readonly number[],
  gapLimitMs: number
): CheckCoverage | undefined {
  const [first] = startedAt;
  const last = startedAt.at(-1);
  if (first === undefined || last === undefined) {
    return;
  }
  const gaps: Span[] = [];
  for (let index = 1; index < startedAt.length; index += 1) {
    const from = startedAt[index - 1] ?? first;
    const to = startedAt[index] ?? last;
    if (to - from > gapLimitMs) {
      gaps.push({ from, to });
    }
  }
  return { first, gaps, last };
}

/**
 * The observed spans of a window: from the first check to the last, less
 * the long gaps, plus the time since the last check while it is no longer
 * than the gap limit; clipped to the window, with the excluded spans (the
 * maintenance windows covering the monitor) cut out. Sorted and disjoint.
 */
export function observedSpans(
  coverage: CheckCoverage | undefined,
  window: Span,
  gapLimitMs: number,
  excluded: readonly Span[]
): Span[] {
  if (!coverage) {
    return [];
  }
  // The time since the last check is a gap like any other: observed while short, none of it once long.
  const end =
    window.to - coverage.last <= gapLimitMs ? window.to : coverage.last;
  return without(
    without([{ from: coverage.first, to: end }], coverage.gaps),
    excluded
  )
    .map((span) => ({
      from: Math.max(span.from, window.from),
      to: Math.min(span.to, window.to),
    }))
    .filter((span) => span.from < span.to);
}

/** The spans less every hole, sorted and disjoint when the spans were. */
export function without(
  spans: readonly Span[],
  holes: readonly Span[]
): Span[] {
  return holes.reduce<Span[]>((rest, hole) => cut(rest, hole), [...spans]);
}

/** The spans less one span. */
function cut(spans: readonly Span[], hole: Span): Span[] {
  return spans.flatMap((span) => {
    if (hole.to <= span.from || hole.from >= span.to) {
      return [span];
    }
    return [
      { from: span.from, to: hole.from },
      { from: hole.to, to: span.to },
    ].filter((part) => part.from < part.to);
  });
}

/** The outage time inside the observed spans; an open outage runs to `now`. */
export function downtimeWithin(
  outages: readonly OutageSpan[],
  observed: readonly Span[],
  now: number
): number {
  let total = 0;
  for (const outage of outages) {
    const end = outage.endedAt ?? now;
    for (const span of observed) {
      total += Math.max(
        0,
        Math.min(end, span.to) - Math.max(outage.startedAt, span.from)
      );
    }
  }
  return total;
}

/** The total length of disjoint spans. */
export function spansLength(spans: readonly Span[]): number {
  return spans.reduce((sum, span) => sum + span.to - span.from, 0);
}

/**
 * Every window's reading, each ending at `now`. The part of a window from
 * `rawFrom` on reads the checks' coverage; the part before it reads the
 * hourly rollups, where an hour's downtime is its outage time capped at its
 * observed time, and an hour the window cuts counts in proportion.
 */
export function uptimeReadings(input: {
  /** The checks from one gap limit before `rawFrom` to `now`. */
  readonly coverage: CheckCoverage | undefined;
  readonly excluded: readonly Span[];
  readonly gapLimitMs: number;
  /** The hourly rollups; only the part before `rawFrom` counts. */
  readonly hours: readonly ObservedHour[];
  readonly now: number;
  readonly outages: readonly OutageSpan[];
  /** Where the checks take over from the rollups. */
  readonly rawFrom: number;
}): UptimeReading[] {
  return uptimeWindows.map((window) => {
    const from = input.now - uptimeWindowMs[window];
    const observed = observedSpans(
      input.coverage,
      { from: Math.max(from, input.rawFrom), to: input.now },
      input.gapLimitMs,
      input.excluded
    );
    const rolled = rolledUp(
      input.hours,
      { from, to: Math.min(input.rawFrom, input.now) },
      input.outages,
      input.excluded,
      input.now
    );
    return {
      downtimeMs:
        downtimeWithin(input.outages, observed, input.now) + rolled.downtimeMs,
      observedMs: spansLength(observed) + rolled.observedMs,
      window,
    };
  });
}

/** An hour's length; every hourly rollup spans one. */
const hourMs = 3_600_000;

/** The observed time and downtime the hourly rollups give a span: each hour counts the part of it inside the span, in proportion, and its downtime is its outage time there, less the excluded spans the rollup already left out of its observed time, capped at that observed time. */
function rolledUp(
  hours: readonly ObservedHour[],
  span: Span,
  outages: readonly OutageSpan[],
  excluded: readonly Span[],
  now: number
): Pick<UptimeReading, "downtimeMs" | "observedMs"> {
  let observedMs = 0;
  let downtimeMs = 0;
  for (const hour of hours) {
    const part = {
      from: Math.max(hour.at, span.from),
      to: Math.min(hour.at + hourMs, span.to),
    };
    if (part.from >= part.to) {
      continue;
    }
    // Whole milliseconds, as every reading is; the displayed figure's arithmetic is in integers.
    const observed = Math.round(
      (hour.observedMs * (part.to - part.from)) / hourMs
    );
    observedMs += observed;
    downtimeMs += Math.min(
      downtimeWithin(outages, without([part], excluded), now),
      observed
    );
  }
  return { downtimeMs, observedMs };
}

/** The fewest and most decimals a displayed uptime takes. */
const fewestDecimals = 2;
const mostDecimals = 5;

/**
 * The displayed uptime, or nothing with no observed time. With no downtime
 * it is 100 exactly; otherwise it is rounded down with the fewest decimals,
 * from 2 up to 5, at which it is not all nines, so a small outage shows how
 * small it was and a window with any downtime never reads 100%.
 */
export function displayedUptime(
  reading: Pick<UptimeReading, "downtimeMs" | "observedMs">
): DisplayedUptime | undefined {
  const { downtimeMs, observedMs } = reading;
  if (observedMs <= 0) {
    return;
  }
  if (downtimeMs <= 0) {
    return { decimals: 0, percent: 100 };
  }
  // Integer arithmetic: 90 days of milliseconds times 10^7 is past what a double holds exactly.
  const up = BigInt(Math.max(0, observedMs - downtimeMs));
  const observed = BigInt(observedMs);
  let decimals = fewestDecimals;
  let scaled = 0n;
  for (; decimals <= mostDecimals; decimals += 1) {
    const scale = 100n * 10n ** BigInt(decimals);
    scaled = (up * scale) / observed;
    // All nines at this many places is 100 less one unit of the last place.
    if (scaled !== scale - 1n || decimals === mostDecimals) {
      break;
    }
  }
  return { decimals, percent: Number(scaled) / 10 ** decimals };
}

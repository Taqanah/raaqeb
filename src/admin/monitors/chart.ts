/**
 * The response-time chart's geometry: inline SVG written
 * here, no chart library. Time reads in the reading direction, so the
 * chart is a pure mirror: in Arabic the oldest point is at the right edge
 * and now at the left, with the value axis on the right; in English the
 * reverse. Points further apart than the gap limit are not joined, since
 * the gap is no data. Pure: the series and the size are parameters.
 */
import type { Direction } from "@/shared/i18n/locale.ts";
import { zoneOffsetMs } from "@/shared/i18n/timezone.ts";
import type { ChartSpan, ResponseSeries } from "@/shared/schemas/detail.ts";

/** The drawing's own units; the SVG scales to its box. */
export const chartWidth = 720;
export const chartHeight = 200;

export interface ChartPoint {
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

/** A bucket that held a down check, drawn as a band behind the line across its time. */
export interface DownBand {
  readonly at: number;
  /** Every check of the bucket was down, so it has no point on the line. */
  readonly whole: boolean;
  readonly width: number;
  /** The band's edge at the smaller x, whichever direction time runs. */
  readonly x: number;
}

export interface ChartGeometry {
  /** The points of the buckets that held a degraded check and no down one. */
  readonly degradedPoints: readonly ChartPoint[];
  readonly downBands: readonly DownBand[];
  /** Runs of joined points; a run of one is drawn as a dot. */
  readonly runs: readonly (readonly ChartPoint[])[];
  /** The y of the degraded threshold's line, when the monitor has one and it falls on the response times' scale. */
  readonly thresholdY: number | undefined;
  /** The scale's top value in milliseconds and the value of each grid line from the bottom. */
  readonly ticks: readonly number[];
  readonly topMs: number;
}

/** Where `at` falls across the width: the oldest time at the start edge of the reading direction. */
export function xOf(
  at: number,
  series: Pick<ResponseSeries, "from" | "to">,
  direction: Direction
): number {
  const share = (at - series.from) / (series.to - series.from);
  return (direction === "rtl" ? 1 - share : share) * chartWidth;
}

/** The smallest top of the value axis. */
const smallestTop = 10;

/** The multiples of a power of ten the axis may top at: each halves to a round value. */
const topSteps = [1, 2, 3, 4, 5, 6, 8, 10];

/** A top for the value axis at or above `maxMs`, at least 10 ms, close enough that the line fills the height. */
export function niceTop(maxMs: number): number {
  if (maxMs <= smallestTop) {
    return smallestTop;
  }
  const power = 10 ** Math.floor(Math.log10(maxMs));
  const step = topSteps.find((factor) => factor * power >= maxMs) ?? 10;
  return step * power;
}

export function chartGeometry(
  series: ResponseSeries,
  degradedMs: number | undefined,
  direction: Direction
): ChartGeometry {
  const drawn = series.buckets.filter(
    (bucket) => bucket.averageMs !== undefined
  );
  // The scale follows the response times alone; a threshold far above them would flatten the line.
  const highest = Math.max(0, ...drawn.map((bucket) => bucket.averageMs ?? 0));
  const topMs = niceTop(highest);
  const yOf = (ms: number) => chartHeight - (ms / topMs) * chartHeight;
  const middle = (at: number) =>
    xOf(at + series.bucketMs / 2, series, direction);
  // Two points join when no more than the gap limit, or one bucket, lies between their starts.
  const reach = Math.max(series.bucketMs, series.gapLimitMs);
  const runs: ChartPoint[][] = [];
  let previous: number | undefined;
  for (const bucket of drawn) {
    const point = {
      at: bucket.at,
      x: middle(bucket.at),
      y: yOf(bucket.averageMs ?? 0),
    };
    const run = runs.at(-1);
    if (run && previous !== undefined && bucket.at - previous <= reach) {
      run.push(point);
    } else {
      runs.push([point]);
    }
    previous = bucket.at;
  }
  const byStart = new Map(series.buckets.map((bucket) => [bucket.at, bucket]));
  const bandWidth = (series.bucketMs / (series.to - series.from)) * chartWidth;
  return {
    degradedPoints: runs.flat().filter((point) => {
      const at = byStart.get(point.at);
      return at !== undefined && at.degraded > 0 && at.down === 0;
    }),
    downBands: series.buckets
      .filter((bucket) => bucket.down > 0)
      .map((bucket) => ({
        at: bucket.at,
        width: bandWidth,
        whole: bucket.averageMs === undefined,
        x: xOf(
          direction === "rtl" ? bucket.at + series.bucketMs : bucket.at,
          series,
          direction
        ),
      })),
    runs,
    thresholdY:
      degradedMs === undefined || degradedMs > topMs
        ? undefined
        : yOf(degradedMs),
    ticks: [0, topMs / 2, topMs],
    topMs,
  };
}

/** An SVG path through the points of one run, to a hundredth of a unit. */
export function pathOf(run: readonly ChartPoint[]): string {
  return run
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${hundredths(point.x)} ${hundredths(point.y)}`
    )
    .join("");
}

function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The area under one run: its line, then down to the baseline and back. */
export function areaOf(run: readonly ChartPoint[]): string {
  const [first] = run;
  const last = run.at(-1);
  if (!(first && last)) {
    return "";
  }
  return `${pathOf(run)}L${hundredths(last.x)} ${chartHeight}L${hundredths(first.x)} ${chartHeight}Z`;
}

/**
 * The index in `series.buckets` of the bucket whose middle is nearest the
 * drawing's `x`; nothing when the nearest is further than the gap limit, or
 * one bucket, from it, since that time held no check.
 */
export function nearestBucket(
  series: ResponseSeries,
  x: number,
  direction: Direction
): number | undefined {
  const share = direction === "rtl" ? 1 - x / chartWidth : x / chartWidth;
  const at = series.from + share * (series.to - series.from);
  let nearest: number | undefined;
  let distance = Math.max(series.bucketMs, series.gapLimitMs);
  for (const [index, bucket] of series.buckets.entries()) {
    const away = Math.abs(bucket.at + series.bucketMs / 2 - at);
    if (away <= distance) {
      nearest = index;
      distance = away;
    }
  }
  return nearest;
}

/** A time label under the chart: a round minute, a whole hour or a midnight, in the operator's zone, clock and calendar, a midnight naming its day in the calendar. */
export interface TimeTick {
  readonly at: number;
  readonly unit: "day" | "hour" | "minute";
  readonly x: number;
}

/** The time at the drawing's `x`, the inverse of `xOf`. */
export function timeAt(
  x: number,
  series: Pick<ResponseSeries, "from" | "to">,
  direction: Direction
): number {
  const share = direction === "rtl" ? 1 - x / chartWidth : x / chartWidth;
  return series.from + share * (series.to - series.from);
}

/** The span between two points of the drawing, oldest first, widened to whole minutes. */
export function spanBetween(
  a: number,
  b: number,
  series: Pick<ResponseSeries, "from" | "to">,
  direction: Direction
): ChartSpan {
  const [older, newer] = [
    timeAt(a, series, direction),
    timeAt(b, series, direction),
  ].toSorted((first, second) => first - second);
  return {
    from: Math.floor((older ?? 0) / minuteMs) * minuteMs,
    to: Math.ceil((newer ?? 0) / minuteMs) * minuteMs,
  };
}

/**
 * The time labels across a range or a zoomed span: every 10 minutes over an
 * hour, 30 over 3 hours, every hour over 6, 2 hours over 12, 4 over a day
 * and 8 over 2 days; every midnight over a week, every 5th day over 30 days
 * and every 15th over 90; each on the zone's clock so the labels read round
 * times.
 */
export function timeTicks(
  series: Pick<ResponseSeries, "from" | "to">,
  direction: Direction,
  timeZone: string
): readonly TimeTick[] {
  const span = series.to - series.from;
  const [, step, unit] = tickSteps.find(([widest]) => span <= widest) ?? [
    Number.POSITIVE_INFINITY,
    15 * dayMs,
    "day",
  ];
  // Steps are taken on the clock: a wall time read as UTC, then turned back into the time it names.
  const fromOffset = zoneOffsetMs(series.from, timeZone);
  const ticks: TimeTick[] = [];
  for (
    let wall = Math.ceil((series.from + fromOffset) / step) * step;
    ;
    wall += step
  ) {
    const guess = wall - zoneOffsetMs(wall - fromOffset, timeZone);
    const at = wall - zoneOffsetMs(guess, timeZone);
    if (at >= series.to) {
      return ticks;
    }
    if (at >= series.from) {
      ticks.push({ at, unit, x: xOf(at, series, direction) });
    }
  }
}

const minuteMs = 60_000;
const hourMs = 3_600_000;
const dayMs = 86_400_000;

/** The widest span each label step serves, the step, and what its labels name; the widest last. */
const tickSteps: readonly (readonly [number, number, TimeTick["unit"]])[] = [
  [hourMs, 10 * minuteMs, "minute"],
  [3 * hourMs, 30 * minuteMs, "minute"],
  [6 * hourMs, hourMs, "hour"],
  [12 * hourMs, 2 * hourMs, "hour"],
  [dayMs, 4 * hourMs, "hour"],
  [2 * dayMs, 8 * hourMs, "hour"],
  [7 * dayMs, dayMs, "day"],
  [30 * dayMs, 5 * dayMs, "day"],
  [Number.POSITIVE_INFINITY, 15 * dayMs, "day"],
];

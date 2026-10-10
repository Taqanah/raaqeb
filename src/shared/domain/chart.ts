/**
 * A zoomed chart: the span the operator selected on
 * the response-time chart, read again with points fine enough to show it.
 * Pure: the span and now are parameters.
 */
import type { ChartSpan, ChartTier } from "@/shared/schemas/detail.ts";
import { rawWindowMs } from "./uptime.ts";

/** What the chart reads for a zoomed span: its edges, the width of a point and where the points come from. */
export interface ZoomedChart {
  readonly bucketMs: number;
  readonly from: number;
  readonly tier: ChartTier;
  readonly to: number;
}

/** The narrowest span a zoom shows; a narrower selection is a slip of the pointer. */
export const smallestZoomMs = 5 * 60_000;

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
/** The round widths a point may take, finest first. */
const pointWidths = [
  ...[1, 2, 5, 10, 15, 30].map((minutes) => minutes * minuteMs),
  ...[1, 2, 3, 6, 12, 24].map((hours) => hours * hourMs),
];
const mostPoints = 360;
const longestZoomMs = 90 * dayMs;

/**
 * The chart of a zoomed span: no more than 360 points of a round width, a
 * minute at the finest, read from the checks themselves while they are kept
 * (30 days) and from the hourly rollups, in whole hours, before that. The
 * span is cut to the last 90 days and to now; nothing when what is left is
 * narrower than the smallest zoom.
 */
export function zoomedChart(
  span: ChartSpan,
  now: number
): ZoomedChart | undefined {
  const to = Math.min(span.to, now);
  const from = Math.max(span.from, now - longestZoomMs);
  if (to - from < smallestZoomMs) {
    return;
  }
  const width =
    pointWidths.find((candidate) => (to - from) / candidate <= mostPoints) ??
    dayMs;
  // An hourly rollup cannot be split, so a point under an hour reads the checks, which are kept for 30 days.
  const raw = width < hourMs && from >= now - rawWindowMs;
  const bucketMs = raw ? width : Math.max(width, hourMs);
  return {
    bucketMs,
    from: Math.floor(from / bucketMs) * bucketMs,
    tier: raw ? "raw" : "hourly",
    to,
  };
}

/** The span "show on the chart" zooms a day's card to: its whole UTC day, or nothing while what of it has passed is narrower than the smallest zoom (just after midnight). */
export function dayZoom(dayStart: number, now: number): ChartSpan | undefined {
  const span = { from: dayStart, to: dayStart + dayMs };
  return zoomedChart(span, now) ? span : undefined;
}

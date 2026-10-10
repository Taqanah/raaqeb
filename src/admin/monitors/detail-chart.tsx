/**
 * The response-time chart of the monitor detail:
 * inline SVG over the geometry of `chart.ts`, mirrored with the reading
 * direction of the locale it renders in. The average response time is a
 * teal line over a soft area; a time that held a down check is a pale red
 * band behind it, a degraded one an amber dot on it.
 * The drawing stretches to its box; strokes keep their width through
 * `non-scaling-stroke`, and the dots are HTML laid over it so they stay
 * round. A pointer, a finger or the arrow keys pick the bucket nearest them:
 * a mouse or the keyboard opens its card beside the line, a finger shows it
 * in the figures row, which the finger does not cover.
 */
import { type ReactNode, useId } from "react";
import {
  formatChartTick,
  formatNumber,
  formatTimeSpan,
  formatUnit,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import { directionOf } from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  ChartSpan,
  ResponseBucket,
  ResponseSeries,
} from "@/shared/schemas/detail.ts";
import { cn } from "@/shared/ui/cn.ts";
import {
  areaOf,
  chartGeometry,
  chartHeight,
  chartWidth,
  pathOf,
  timeTicks,
  xOf,
} from "./chart.ts";
import { formatResponseTime, Pair, resultWords } from "./check-parts.tsx";
import { useChartPointer } from "./use-chart-pointer.ts";

export interface ResponseChartProps {
  readonly clock: TimeOptions;
  readonly degradedMs: number | undefined;
  /** Zooms into a selected span; without it the chart selects nothing. */
  readonly onZoom?: (span: ChartSpan) => void;
  readonly onZoomOut?: () => void;
  readonly series: ResponseSeries;
  /** The chart shows a span zoomed into, which Escape leaves. */
  readonly zoomed?: boolean;
}

/** A share of the drawing's width or height as a CSS percentage. */
function percent(value: number, of: number): string {
  return `${(value / of) * 100}%`;
}

export function ResponseChart({
  clock,
  degradedMs,
  onZoom,
  onZoomOut,
  series,
  zoomed = false,
}: ResponseChartProps): ReactNode {
  const { locale, t } = useMessages();
  const direction = directionOf(locale);
  const geometry = chartGeometry(series, degradedMs, direction);
  const fill = useId();
  const { active, handlers, selection } = useChartPointer(series, direction, {
    onZoom,
    onZoomOut,
    zoomed,
  });
  // An axis tick at zero is zero; a response time under 1 ms is not.
  const ms = (value: number) =>
    formatUnit(locale, Math.round(value), "millisecond");
  // Under 1 ms is judged before rounding, so 0.5 ms never reads 1 ms.
  const responseTime = (value: number) =>
    formatResponseTime(locale, value < 1 ? value : Math.round(value));
  const bucket =
    active === undefined ? undefined : series.buckets[active.index];
  const point = bucket
    ? geometry.runs.flat().find((candidate) => candidate.at === bucket.at)
    : undefined;
  const middle = bucket
    ? xOf(bucket.at + series.bucketMs / 2, series, direction)
    : 0;

  return (
    <div className="flex flex-col gap-4" data-slot="response-chart">
      {bucket && active?.touch ? (
        <BucketFigures bucket={bucket} clock={clock} series={series} />
      ) : null}
      {active?.touch ? null : <RangeFigures series={series} />}
      <div className="flex gap-3">
        <div className="flex h-48 shrink-0 flex-col justify-between text-end text-muted-foreground text-xs tabular-nums">
          {geometry.ticks.toReversed().map((tick) => (
            <span key={tick}>{ms(tick)}</span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* A slider over the buckets: the arrow keys walk them as a pointer does, and the value names the bucket. */}
          <div
            aria-label={t("monitor_chart_label")}
            aria-valuemax={Math.max(0, series.buckets.length - 1)}
            aria-valuemin={0}
            aria-valuenow={
              active?.index ?? Math.max(0, series.buckets.length - 1)
            }
            aria-valuetext={
              bucket
                ? `${formatTimeSpan(locale, bucket.at, bucket.at + series.bucketMs, clock)}: ${
                    bucket.averageMs === undefined
                      ? t(resultWords.down)
                      : responseTime(bucket.averageMs)
                  }`
                : undefined
            }
            className={cn(
              "relative h-48 touch-pan-y select-none rounded-sm outline-none focus-visible:ring-4 focus-visible:ring-ring-soft",
              onZoom ? "cursor-crosshair" : undefined
            )}
            data-slot="chart-plot"
            {...handlers}
            role="slider"
            tabIndex={0}
          >
            <svg
              aria-hidden="true"
              className="size-full overflow-visible"
              preserveAspectRatio="none"
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            >
              <defs>
                <linearGradient id={fill} x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0%"
                    style={{ stopColor: "var(--chart)", stopOpacity: 0.28 }}
                  />
                  <stop
                    offset="100%"
                    style={{ stopColor: "var(--chart)", stopOpacity: 0.02 }}
                  />
                </linearGradient>
              </defs>
              {geometry.downBands.map((band) => (
                <rect
                  className={cn(
                    "fill-status-down-soft",
                    band.whole ? undefined : "opacity-60"
                  )}
                  data-slot="chart-down"
                  height={chartHeight}
                  key={band.at}
                  width={band.width}
                  x={band.x}
                  y={0}
                />
              ))}
              {geometry.ticks.map((tick) => {
                const y = chartHeight - (tick / geometry.topMs) * chartHeight;
                return (
                  <path
                    className="stroke-border"
                    d={`M0 ${y}H${chartWidth}`}
                    key={tick}
                    strokeDasharray={tick === 0 ? undefined : "4 4"}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              {geometry.thresholdY === undefined ? null : (
                <path
                  className="stroke-status-degraded"
                  d={`M0 ${geometry.thresholdY}H${chartWidth}`}
                  data-slot="chart-threshold"
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {geometry.runs.map((run) => (
                <path
                  d={areaOf(run)}
                  fill={`url(#${fill})`}
                  key={`area-${run[0]?.at}`}
                />
              ))}
              {geometry.runs.map((run) => (
                <path
                  className="fill-none stroke-chart"
                  d={run.length === 1 ? `${pathOf(run)}h0` : pathOf(run)}
                  data-slot="chart-line"
                  key={run[0]?.at}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={run.length === 1 ? 4 : 1.75}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {selection ? (
                <g data-slot="chart-selection">
                  <rect
                    className="fill-chart opacity-15"
                    height={chartHeight}
                    width={selection.right - selection.left}
                    x={selection.left}
                    y={0}
                  />
                  <path
                    className="stroke-chart"
                    d={`M${selection.left} 0V${chartHeight}M${selection.right} 0V${chartHeight}`}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ) : null}
              {bucket ? (
                <path
                  className="stroke-muted-foreground"
                  d={`M${middle} 0V${chartHeight}`}
                  data-slot="chart-crosshair"
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>
            {geometry.degradedPoints.map((degraded) => (
              <span
                className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-status-degraded"
                data-slot="chart-degraded"
                key={degraded.at}
                style={{
                  left: percent(degraded.x, chartWidth),
                  top: percent(degraded.y, chartHeight),
                }}
              />
            ))}
            {point ? (
              <span
                className={cn(
                  "pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-background",
                  bucket?.degraded ? "border-status-degraded" : "border-chart"
                )}
                style={{
                  left: percent(point.x, chartWidth),
                  top: percent(point.y, chartHeight),
                }}
              />
            ) : null}
            {selection ? (
              <span
                className="pointer-events-none absolute bottom-1 z-10 whitespace-nowrap rounded-md bg-foreground px-2 py-0.5 text-background text-xs tabular-nums"
                // At the foot of the chart, clear of the hovered time's card; moved back by its own share of the width, so at either edge it stays inside.
                style={{
                  left: percent(
                    selection.left + selection.right,
                    2 * chartWidth
                  ),
                  translate: `-${percent(selection.left + selection.right, 2 * chartWidth)} 0`,
                }}
              >
                {formatTimeSpan(
                  locale,
                  selection.span.from,
                  selection.span.to,
                  clock
                )}
              </span>
            ) : null}
            {bucket && !active?.touch ? (
              <BucketCard
                bucket={bucket}
                clock={clock}
                middle={middle}
                series={series}
              />
            ) : null}
          </div>
          <div className="relative h-4 text-muted-foreground text-xs tabular-nums">
            {timeTicks(series, direction, clock.timeZone).map((tick) => (
              <span
                className="absolute -translate-x-1/2 whitespace-nowrap"
                key={tick.at}
                style={{ left: percent(tick.x, chartWidth) }}
              >
                {formatChartTick(locale, tick.at, tick.unit, clock)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <Legend threshold={geometry.thresholdY !== undefined} />
    </div>
  );
}

/** The range's average, lowest and highest, or why it has none. */
function RangeFigures({
  series,
}: {
  readonly series: ResponseSeries;
}): ReactNode {
  const { locale, t } = useMessages();
  const summary = summaryOf(series);
  // Under 1 ms is judged before rounding, so 0.5 ms never reads 1 ms.
  const responseTime = (value: number) =>
    formatResponseTime(locale, value < 1 ? value : Math.round(value));
  return (
    <>
      {summary ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
          <div className="flex gap-2">
            <Pair label={t("monitor_chart_average")}>
              {responseTime(summary.average)}
            </Pair>
          </div>
          <div className="flex gap-2">
            <Pair label={t("monitor_chart_min")}>
              {responseTime(summary.min)}
            </Pair>
          </div>
          <div className="flex gap-2">
            <Pair label={t("monitor_chart_max")}>
              {responseTime(summary.max)}
            </Pair>
          </div>
        </dl>
      ) : null}
      {summary ? null : (
        <p className="text-muted-foreground text-sm">
          {/* Checks with no response time are down ones. */}
          {series.buckets.some((entry) => entry.checks > 0)
            ? t("monitor_chart_all_down")
            : t("monitor_chart_empty")}
        </p>
      )}
    </>
  );
}

/** What the threshold line, the amber dots and the red bands mean. */
function Legend({ threshold }: { readonly threshold: boolean }): ReactNode {
  const { t } = useMessages();
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-xs">
      {threshold ? (
        <span className="flex items-center gap-2">
          <span className="w-4 border-status-degraded border-t-2 border-dashed" />
          {t("monitor_field_degraded")}
        </span>
      ) : null}
      <span className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-status-degraded" />
        {t(resultWords.degraded)}
      </span>
      <span className="flex items-center gap-2">
        <span className="size-2.5 rounded-xs bg-status-down-soft ring-1 ring-status-down/40" />
        {t("monitor_chart_down")}
      </span>
    </div>
  );
}

/** The hovered bucket's card beside the crosshair, on the side with more room. */
function BucketCard({
  bucket,
  clock,
  middle,
  series,
}: {
  readonly bucket: ResponseBucket;
  readonly clock: TimeOptions;
  readonly middle: number;
  readonly series: ResponseSeries;
}): ReactNode {
  const share = middle / chartWidth;
  const side =
    share > 0.5
      ? { right: `calc(${(1 - share) * 100}% + 12px)` }
      : { left: `calc(${share * 100}% + 12px)` };
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute top-0 z-10 w-max min-w-48 rounded-lg bg-popover p-3 text-popover-foreground text-sm shadow-md ring-(--rim) ring-1"
      data-slot="chart-bucket-card"
      style={side}
    >
      <BucketFigures bucket={bucket} clock={clock} series={series} />
    </div>
  );
}

/** What one bucket held: its time, its response times and its checks by result. */
function BucketFigures({
  bucket,
  clock,
  series,
}: {
  readonly bucket: ResponseBucket;
  readonly clock: TimeOptions;
  readonly series: ResponseSeries;
}): ReactNode {
  const { locale, t } = useMessages();
  const time = (value: number) =>
    formatResponseTime(locale, value < 1 ? value : Math.round(value));
  const up = bucket.checks - bucket.down - bucket.degraded;
  return (
    <div
      className="flex flex-col gap-1.5 tabular-nums"
      data-slot="chart-bucket"
    >
      <p className="text-muted-foreground text-xs">
        {formatTimeSpan(locale, bucket.at, bucket.at + series.bucketMs, clock)}
      </p>
      {bucket.averageMs === undefined ? (
        <p className="font-semibold text-lg text-status-down-text">
          {t(resultWords.down)}
        </p>
      ) : (
        <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">
              {t("monitor_chart_average")}
            </dt>
            <dd className="font-semibold text-lg">{time(bucket.averageMs)}</dd>
          </div>
          {/* One timed check has no spread: its average is its only figure. */}
          {bucket.minMs === undefined ||
          bucket.maxMs === undefined ||
          bucket.minMs === bucket.maxMs ? null : (
            <>
              <div className="flex gap-2">
                <Pair label={t("monitor_chart_min")}>{time(bucket.minMs)}</Pair>
              </div>
              <div className="flex gap-2">
                <Pair label={t("monitor_chart_max")}>{time(bucket.maxMs)}</Pair>
              </div>
            </>
          )}
        </dl>
      )}
      <dl className="flex flex-wrap gap-x-3 text-xs">
        {(
          [
            ["up", up, "bg-status-up"],
            ["degraded", bucket.degraded, "bg-status-degraded"],
            ["down", bucket.down, "bg-status-down"],
          ] as const
        ).map(([result, count, colour]) =>
          count > 0 ? (
            <div className="flex items-center gap-1.5" key={result}>
              <span className={cn("size-2 rounded-xs", colour)} />
              <dt className="text-muted-foreground">
                {t(resultWords[result])}
              </dt>
              <dd>{formatNumber(locale, count)}</dd>
            </div>
          ) : null
        )}
      </dl>
    </div>
  );
}

/** The average of the drawn response times weighted by their checks, and the range's lowest and highest. */
function summaryOf(
  series: ResponseSeries
): { average: number; max: number; min: number } | undefined {
  let total = 0;
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const bucket of series.buckets) {
    if (bucket.averageMs === undefined) {
      continue;
    }
    // Every up or degraded check of an HTTP, TCP or DNS monitor has a response time.
    const timed = bucket.checks - bucket.down;
    total += bucket.averageMs * timed;
    count += timed;
    min = Math.min(min, bucket.minMs ?? min);
    max = Math.max(max, bucket.maxMs ?? max);
  }
  return count === 0 ? undefined : { average: total / count, max, min };
}

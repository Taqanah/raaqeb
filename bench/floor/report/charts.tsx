/**
 * The report's two chart forms, inline SVG with a hover layer: a line chart
 * over time with a crosshair that reads every series at once, and a
 * horizontal bar chart whose bars carry their own tooltip. Every figure a
 * chart shows is also in the table beside it.
 */
import { type PointerEvent, useCallback, useState } from "react";
import { linearScale, linePath, niceCeiling, type Point } from "./chart.ts";

/** One line of a chart: its name, its colour role and its points. */
export interface Series {
  readonly colour: string;
  readonly name: string;
  readonly points: readonly Point[];
}

const width = 1000;
const height = 240;
const margin = { bottom: 24, left: 64, right: 96, top: 8 };
const plotWidth = width - margin.left - margin.right;
const plotHeight = height - margin.top - margin.bottom;

/** The point of a sorted series nearest to `x`. */
function nearest(points: readonly Point[], x: number): Point | undefined {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((points[middle]?.x ?? 0) < x) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const after = points[low];
  const before = points[low - 1];
  if (before && after && x - before.x < after.x - x) {
    return before;
  }
  return after ?? before;
}

export function LineChart(props: {
  readonly description: string;
  /** What the chart says when no series has a point. */
  readonly empty: string;
  /** A horizontal line the series should stay under, such as the memory limit. */
  readonly limit?: { readonly label: string; readonly value: number };
  /** How far apart two points may be before the line breaks between them. */
  readonly gap: number;
  readonly series: readonly Series[];
  /** The axis's top; a 1, 2 or 5 times a power of ten over the data when absent. */
  readonly top?: number;
  readonly x: (value: number) => string;
  readonly y: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | undefined>();
  const all = props.series.flatMap((each) => each.points);
  const xs = all.map((point) => point.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const move = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const at = ((event.clientX - box.left) / box.width) * width;
      const data = xMin + ((at - margin.left) / plotWidth) * (xMax - xMin);
      setHover(Math.min(xMax, Math.max(xMin, data)));
    },
    [xMin, xMax]
  );
  const leave = useCallback(() => setHover(undefined), []);
  if (all.length === 0) {
    return <p className="note">{props.empty}</p>;
  }
  const top =
    props.top ??
    niceCeiling(
      Math.max(props.limit?.value ?? 0, ...all.map((point) => point.y))
    );
  const x = linearScale([xMin, xMax], [margin.left, margin.left + plotWidth]);
  const y = linearScale([0, top], [margin.top + plotHeight, margin.top]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((step) => step * top);

  const readings =
    hover === undefined
      ? []
      : props.series.flatMap((each) => {
          const point = nearest(each.points, hover);
          return point ? [{ point, series: each }] : [];
        });
  const at = readings[0]?.point.x;
  return (
    <div className="chart">
      <div className="legend">
        {props.series.map((each) => (
          <span key={each.name}>
            <span className="key" style={{ background: each.colour }} />
            {each.name}
          </span>
        ))}
      </div>
      <svg
        aria-label={props.description}
        onPointerLeave={leave}
        onPointerMove={move}
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? "baseline" : "gridline"}
              x1={margin.left}
              x2={margin.left + plotWidth}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              className="tick"
              textAnchor="end"
              x={margin.left - 8}
              y={y(tick) + 4}
            >
              {props.y(tick)}
            </text>
          </g>
        ))}
        <text className="tick" x={margin.left} y={height - 4}>
          {props.x(xMin)}
        </text>
        <text
          className="tick"
          textAnchor="end"
          x={margin.left + plotWidth}
          y={height - 4}
        >
          {props.x(xMax)}
        </text>
        {props.limit ? (
          <g>
            <line
              className="limit"
              x1={margin.left}
              x2={margin.left + plotWidth}
              y1={y(props.limit.value)}
              y2={y(props.limit.value)}
            />
            <text
              className="label"
              x={margin.left + plotWidth + 6}
              y={y(props.limit.value) + 4}
            >
              {props.limit.label}
            </text>
          </g>
        ) : null}
        {props.series.map((each) => {
          const last = each.points.at(-1);
          return (
            <g key={each.name}>
              <path
                className="series"
                d={linePath(each.points, x, y, props.gap)}
                stroke={each.colour}
              />
              {last ? (
                <text className="label" x={x(last.x) + 6} y={y(last.y) + 4}>
                  {each.name}
                </text>
              ) : null}
            </g>
          );
        })}
        {at === undefined ? null : (
          <line
            className="baseline"
            x1={x(at)}
            x2={x(at)}
            y1={margin.top}
            y2={margin.top + plotHeight}
          />
        )}
      </svg>
      {at === undefined ? null : (
        <div
          className="tooltip"
          style={{ left: `${Math.min((x(at) / width) * 100, 70)}%` }}
        >
          <div>
            <span>{props.x(at)}</span>
          </div>
          {readings.map(({ point, series }) => (
            <div key={series.name}>
              <span className="key" style={{ background: series.colour }} />
              <b>{props.y(point.y)}</b> <span>{series.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One bar: its category, its value, and what its tooltip adds. */
export interface Bar {
  readonly detail?: string;
  readonly label: string;
  readonly value: number | null;
}

const rowHeight = 28;
const labelWidth = 160;

/** Bars keep their own SVG title, which a pointer and a screen reader both read; the table beside each chart holds the same figures. */
export function BarChart(props: {
  readonly bars: readonly Bar[];
  readonly description: string;
  readonly format: (value: number) => string;
}) {
  const top = niceCeiling(Math.max(...props.bars.map((bar) => bar.value ?? 0)));
  const chartHeight = props.bars.length * rowHeight + 8;
  const x = linearScale([0, top], [labelWidth, width - margin.right]);
  const shown = (bar: Bar) =>
    bar.value === null ? "not measured" : props.format(bar.value);
  return (
    <div className="chart">
      <svg
        aria-label={props.description}
        role="img"
        viewBox={`0 0 ${width} ${chartHeight}`}
      >
        <line
          className="baseline"
          x1={labelWidth}
          x2={labelWidth}
          y1={0}
          y2={chartHeight}
        />
        {props.bars.map((bar, index) => {
          const top0 = index * rowHeight + 4;
          const length = bar.value === null ? 0 : x(bar.value) - labelWidth;
          return (
            <g className="row" key={bar.label}>
              <title>
                {`${shown(bar)}: ${bar.label}${bar.detail ? `, ${bar.detail}` : ""}`}
              </title>
              <rect
                fill="transparent"
                height={rowHeight}
                width={width}
                x={0}
                y={top0 - 4}
              />
              <text
                className="label"
                textAnchor="end"
                x={labelWidth - 8}
                y={top0 + 14}
              >
                {bar.label}
              </text>
              <rect
                className="bar"
                height={rowHeight - 10}
                rx={4}
                width={Math.max(length, 0)}
                x={labelWidth}
                y={top0}
              />
              <text className="label" x={labelWidth + length + 6} y={top0 + 14}>
                {shown(bar)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

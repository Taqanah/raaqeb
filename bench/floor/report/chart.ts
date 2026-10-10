/**
 * The report viewer's pure part: scales, paths and the wording of a figure
 * against the previous release and the band. The viewer's components draw
 * with these; nothing here touches the page.
 */
import type { BandRange } from "../band.ts";

/** A coordinate to two decimals, short enough for a path of thousands of points. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A point in data units. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A linear map from a domain onto a range; a domain of one value maps everything to the range's start. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number]
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d0 === d1) {
    return () => r0;
  }
  return (value) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/** The smallest of 1, 2 or 5 times a power of ten at or above a value, the top of a chart's axis; 1 for nothing above zero. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= value) {
      return step * power;
    }
  }
  return 10 * power;
}

/** An SVG path through the points in order, broken where two neighbours are more than `gap` apart in x. */
export function linePath(
  points: readonly Point[],
  x: (value: number) => number,
  y: (value: number) => number,
  gap: number
): string {
  let path = "";
  let previous: Point | undefined;
  for (const point of points) {
    const move = previous === undefined || point.x - previous.x > gap;
    path += `${move ? "M" : "L"}${round(x(point.x))},${round(y(point.y))}`;
    previous = point;
  }
  return path;
}

/** How a figure stands against the previous release's. */
export type Comparison =
  | { readonly kind: "none" }
  | {
      readonly beyondNoise: boolean;
      readonly difference: number;
      readonly kind: "compared";
    };

/** The figure's difference from the previous release's, beyond noise when it is larger than the band's spread; none without both figures. */
export function compare(
  current: number | null,
  previous: number | null | undefined,
  band: BandRange | undefined
): Comparison {
  if (current === null || previous === null || previous === undefined) {
    return { kind: "none" };
  }
  const difference = current - previous;
  const noise = band ? band.high - band.low : 0;
  return {
    beyondNoise: Math.abs(difference) > noise,
    difference,
    kind: "compared",
  };
}

import { describe, expect, test } from "bun:test";
import { compare, linearScale, linePath, niceCeiling } from "./chart.ts";

describe("a chart's scale", () => {
  test("maps the domain onto the range linearly, a reversed range included", () => {
    const x = linearScale([0, 100], [0, 400]);
    expect(x(0)).toBe(0);
    expect(x(25)).toBe(100);
    expect(x(100)).toBe(400);
    const y = linearScale([0, 10], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(10)).toBe(0);
    expect(y(5)).toBe(100);
  });

  test("a domain of one value maps everything to the range's start", () => {
    expect(linearScale([5, 5], [10, 90])(5)).toBe(10);
  });

  test("an axis tops out at 1, 2 or 5 times a power of ten", () => {
    expect(niceCeiling(0.7)).toBe(1);
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(1.2)).toBe(2);
    expect(niceCeiling(3)).toBe(5);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(240 * 2 ** 20)).toBe(500_000_000);
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(-4)).toBe(1);
  });
});

describe("a chart's line", () => {
  const same = (value: number) => value;

  test("runs through the points in order", () => {
    expect(
      linePath(
        [
          { x: 0, y: 5 },
          { x: 1, y: 6 },
          { x: 2, y: 4 },
        ],
        same,
        same,
        10
      )
    ).toBe("M0,5L1,6L2,4");
  });

  test("breaks where two neighbours are more than the gap apart", () => {
    expect(
      linePath(
        [
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 10, y: 2 },
        ],
        same,
        same,
        5
      )
    ).toBe("M0,1L1,1M10,2");
  });

  test("no points draw nothing", () => {
    expect(linePath([], same, same, 1)).toBe("");
  });
});

describe("a figure against the previous release", () => {
  test("the difference from the previous figure, within noise when no larger than the band's spread", () => {
    expect(compare(110, 100, { high: 120, low: 105, median: 110 })).toEqual({
      beyondNoise: false,
      difference: 10,
      kind: "compared",
    });
    expect(compare(130, 100, { high: 120, low: 105, median: 110 })).toEqual({
      beyondNoise: true,
      difference: 30,
      kind: "compared",
    });
    expect(compare(85, 100, { high: 120, low: 105, median: 110 })).toEqual({
      beyondNoise: false,
      difference: -15,
      kind: "compared",
    });
  });

  test("with no band any difference is beyond noise, and none is not", () => {
    expect(compare(101, 100, undefined)).toMatchObject({ beyondNoise: true });
    expect(compare(100, 100, undefined)).toMatchObject({ beyondNoise: false });
  });

  test("a missing figure on either side compares nothing", () => {
    expect(compare(null, 100, undefined)).toEqual({ kind: "none" });
    expect(compare(100, null, undefined)).toEqual({ kind: "none" });
    expect(compare(100, undefined, undefined)).toEqual({ kind: "none" });
  });
});

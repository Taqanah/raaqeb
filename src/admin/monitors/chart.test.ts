import { describe, expect, test } from "bun:test";
import { wallTime } from "@/shared/i18n/timezone.ts";
import type {
  ResponseBucket,
  ResponseSeries,
} from "@/shared/schemas/detail.ts";
import {
  areaOf,
  chartGeometry,
  chartHeight,
  chartWidth,
  nearestBucket,
  niceTop,
  pathOf,
  spanBetween,
  timeAt,
  timeTicks,
  xOf,
} from "./chart.ts";

const t0 = 1_700_000_000_000;
// A wall time on a whole hour that 4 divides.
const everyFourthHour = /T(00|04|08|12|16|20):00$/;
const bucketMs = 300_000;

function bucket(
  index: number,
  averageMs: number | undefined,
  down = 0,
  degraded = 0
): ResponseBucket {
  return {
    at: t0 + index * bucketMs,
    averageMs,
    checks: 5,
    degraded,
    down,
    maxMs: averageMs,
    minMs: averageMs,
  };
}

function series(buckets: ResponseBucket[]): ResponseSeries {
  return {
    bucketMs,
    buckets,
    from: t0,
    gapLimitMs: 120_000,
    range: "24h",
    to: t0 + 288 * bucketMs,
  };
}

describe("the chart mirrors with the reading direction", () => {
  const span = { from: t0, to: t0 + 1000 };

  test("in Arabic the oldest time is at the right edge and now at the left", () => {
    expect(xOf(t0, span, "rtl")).toBe(chartWidth);
    expect(xOf(t0 + 1000, span, "rtl")).toBe(0);
    expect(xOf(t0 + 250, span, "rtl")).toBe(chartWidth * 0.75);
  });

  test("in English the oldest time is at the left edge and now at the right", () => {
    expect(xOf(t0, span, "ltr")).toBe(0);
    expect(xOf(t0 + 1000, span, "ltr")).toBe(chartWidth);
    expect(xOf(t0 + 250, span, "ltr")).toBe(chartWidth * 0.25);
  });

  test("the same series draws the same points, mirrored", () => {
    const drawn = series([bucket(0, 100), bucket(1, 200), bucket(2, 150)]);
    const rtl = chartGeometry(drawn, undefined, "rtl");
    const ltr = chartGeometry(drawn, undefined, "ltr");
    const rtlRun = rtl.runs[0] ?? [];
    const ltrRun = ltr.runs[0] ?? [];
    expect(rtlRun).toHaveLength(3);
    for (const [index, point] of rtlRun.entries()) {
      expect(point.x).toBeCloseTo(chartWidth - (ltrRun[index]?.x ?? 0));
      expect(point.y).toBe(ltrRun[index]?.y ?? Number.NaN);
    }
    // Time runs in the reading direction: each later point sits further to the left in Arabic.
    expect(rtlRun[0]?.x).toBeGreaterThan(rtlRun[1]?.x ?? 0);
    expect(ltrRun[0]?.x).toBeLessThan(ltrRun[1]?.x ?? 0);
  });
});

describe("the chart's points", () => {
  test("a point's height is its average response time on the scale; the baseline is the bottom", () => {
    const geometry = chartGeometry(
      series([bucket(0, 0), bucket(1, 500)]),
      undefined,
      "ltr"
    );
    expect(geometry.topMs).toBe(500);
    expect(geometry.runs[0]?.[0]?.y).toBe(chartHeight);
    expect(geometry.runs[0]?.[1]?.y).toBe(0);
  });

  test("points further apart than the gap limit are not joined: the gap is no data", () => {
    const geometry = chartGeometry(
      series([bucket(0, 100), bucket(1, 120), bucket(5, 90), bucket(6, 80)]),
      undefined,
      "ltr"
    );
    expect(geometry.runs.map((run) => run.length)).toEqual([2, 2]);
  });

  test("a gap limit wider than a bucket joins buckets it spans", () => {
    const wide = { ...series([bucket(0, 100), bucket(3, 120)]) };
    const geometry = chartGeometry(
      { ...wide, gapLimitMs: 4 * bucketMs },
      undefined,
      "ltr"
    );
    expect(geometry.runs.map((run) => run.length)).toEqual([2]);
  });

  test("a bucket where every check was down has no point but a down band across its time; a partly down bucket has both", () => {
    const geometry = chartGeometry(
      series([bucket(0, 100), bucket(1, undefined, 5), bucket(2, 90, 1)]),
      undefined,
      "ltr"
    );
    expect(geometry.runs.map((run) => run.length)).toEqual([1, 1]);
    const width = (bucketMs / (288 * bucketMs)) * chartWidth;
    // A band spans its bucket from start to end; points sit at the middle.
    expect(geometry.downBands).toEqual([
      {
        at: t0 + bucketMs,
        width,
        whole: true,
        x: xOf(t0 + bucketMs, series([]), "ltr"),
      },
      {
        at: t0 + 2 * bucketMs,
        width,
        whole: false,
        x: xOf(t0 + 2 * bucketMs, series([]), "ltr"),
      },
    ]);
    expect(geometry.runs[1]?.[0]?.x).toBe(
      xOf(t0 + 2.5 * bucketMs, series([]), "ltr")
    );
  });

  test("in Arabic a down band starts at its bucket's end, the edge nearer now", () => {
    const geometry = chartGeometry(
      series([bucket(1, undefined, 5)]),
      undefined,
      "rtl"
    );
    expect(geometry.downBands[0]?.x).toBe(
      xOf(t0 + 2 * bucketMs, series([]), "rtl")
    );
  });

  test("a bucket that held a degraded check and no down one is a degraded point on the line", () => {
    const geometry = chartGeometry(
      series([bucket(0, 100), bucket(1, 400, 0, 2), bucket(2, 300, 1, 2)]),
      undefined,
      "ltr"
    );
    expect(geometry.degradedPoints).toEqual(
      geometry.runs[0]?.slice(1, 2) ?? []
    );
  });

  test("the degraded threshold is a line where it falls on the response times' scale", () => {
    const geometry = chartGeometry(
      series([bucket(0, 100), bucket(1, 400)]),
      250,
      "ltr"
    );
    expect(geometry.topMs).toBe(400);
    expect(geometry.thresholdY).toBe(chartHeight * (1 - 250 / 400));
    expect(
      chartGeometry(series([bucket(0, 100)]), undefined, "ltr").thresholdY
    ).toBeUndefined();
  });

  test("a threshold far above the response times never stretches the scale and is not drawn", () => {
    const geometry = chartGeometry(
      series([bucket(0, 7), bucket(1, 9)]),
      1500,
      "ltr"
    );
    expect(geometry.topMs).toBe(10);
    expect(geometry.thresholdY).toBeUndefined();
  });

  test("an empty series draws nothing on the smallest scale", () => {
    const geometry = chartGeometry(series([]), undefined, "rtl");
    expect(geometry.runs).toEqual([]);
    expect(geometry.downBands).toEqual([]);
    expect(geometry.degradedPoints).toEqual([]);
    expect(geometry.topMs).toBe(10);
  });

  test("the grid has a line at the bottom, halfway and at the top", () => {
    expect(
      chartGeometry(series([bucket(0, 400)]), undefined, "ltr").ticks
    ).toEqual([0, 200, 400]);
  });
});

describe("the scale's top", () => {
  test("is 1, 2, 3, 4, 5, 6 or 8 times a power of ten at or above the value, so the line fills the height and the halfway line is round", () => {
    expect(niceTop(0)).toBe(10);
    expect(niceTop(7)).toBe(10);
    expect(niceTop(10)).toBe(10);
    expect(niceTop(11)).toBe(20);
    expect(niceTop(245)).toBe(300);
    expect(niceTop(1284)).toBe(2000);
    expect(niceTop(2800)).toBe(3000);
    expect(niceTop(5001)).toBe(6000);
    expect(niceTop(7001)).toBe(8000);
    expect(niceTop(8001)).toBe(10_000);
  });
});

describe("a run's path", () => {
  test("moves to the first point and draws a line through the rest", () => {
    expect(
      pathOf([
        { at: 0, x: 0, y: 10 },
        { at: 1, x: 5.5, y: 20 },
        { at: 2, x: 11, y: 0 },
      ])
    ).toBe("M0 10L5.5 20L11 0");
  });
});

describe("a run's area", () => {
  test("follows the line, then closes down to the baseline under its last and first points", () => {
    expect(
      areaOf([
        { at: 0, x: 0, y: 10 },
        { at: 1, x: 5.5, y: 20 },
        { at: 2, x: 11, y: 0 },
      ])
    ).toBe(`M0 10L5.5 20L11 0L11 ${chartHeight}L0 ${chartHeight}Z`);
  });
});

describe("the bucket under the pointer", () => {
  const sparse = series([bucket(0, 100), bucket(1, 120), bucket(3, 90)]);
  const middleOf = (index: number, direction: "ltr" | "rtl") =>
    xOf(t0 + (index + 0.5) * bucketMs, sparse, direction);

  test("is the bucket whose middle is nearest, in either direction", () => {
    expect(nearestBucket(sparse, middleOf(1, "ltr"), "ltr")).toBe(1);
    expect(nearestBucket(sparse, middleOf(1, "rtl"), "rtl")).toBe(1);
    expect(nearestBucket(sparse, middleOf(3, "rtl") + 1, "rtl")).toBe(2);
  });

  test("is nothing far inside a gap, where no check ran", () => {
    expect(nearestBucket(sparse, middleOf(40, "ltr"), "ltr")).toBeUndefined();
    expect(nearestBucket(series([]), 100, "ltr")).toBeUndefined();
  });
});

describe("the time labels", () => {
  // 2026-10-02 00:10 UTC, 03:10 in Riyadh.
  const from = Date.parse("2026-10-02T00:10:00Z");
  const range = (days: number) => ({ from, to: from + days * 86_400_000 });

  test("over a day are every 4 hours on the zone's clock", () => {
    const ticks = timeTicks(range(1), "ltr", "Asia/Riyadh");
    expect(ticks.map((tick) => wallTime(tick.at, "Asia/Riyadh"))).toEqual([
      "2026-10-02T04:00",
      "2026-10-02T08:00",
      "2026-10-02T12:00",
      "2026-10-02T16:00",
      "2026-10-02T20:00",
      "2026-10-03T00:00",
    ]);
    expect(ticks.every((tick) => tick.unit === "hour")).toBe(true);
    expect(ticks[0]?.x).toBe(xOf(ticks[0]?.at ?? 0, range(1), "ltr"));
  });

  test("over a zoomed span are finer: every 10 minutes over an hour, 30 over 3 hours, every hour over 6, 2 over 12 and 8 over 2 days", () => {
    for (const [span, every, unit] of [
      [3_600_000, 600_000, "minute"],
      [2 * 3_600_000, 1_800_000, "minute"],
      [5 * 3_600_000, 3_600_000, "hour"],
      [10 * 3_600_000, 2 * 3_600_000, "hour"],
      [2 * 86_400_000, 8 * 3_600_000, "hour"],
    ] as const) {
      const ticks = timeTicks({ from, to: from + span }, "ltr", "Asia/Riyadh");
      expect(ticks.length).toBeGreaterThan(1);
      for (const [index, tick] of ticks.entries()) {
        expect(tick.unit).toBe(unit);
        if (index > 0) {
          expect(tick.at - (ticks[index - 1]?.at ?? 0)).toBe(every);
        }
      }
    }
  });

  test("land on whole hours in a zone half an hour off UTC", () => {
    const ticks = timeTicks(range(1), "rtl", "Asia/Kolkata");
    expect(ticks.length).toBe(6);
    for (const tick of ticks) {
      expect(wallTime(tick.at, "Asia/Kolkata")).toMatch(everyFourthHour);
    }
  });

  test("over a week are each midnight, over 30 days every 5th and over 90 every 15th", () => {
    for (const [days, every, count] of [
      [7, 1, 7],
      [30, 5, 6],
      [90, 15, 6],
    ] as const) {
      const ticks = timeTicks(range(days), "ltr", "Asia/Riyadh");
      expect(ticks.length).toBe(count);
      for (const [index, tick] of ticks.entries()) {
        expect(tick.unit).toBe("day");
        expect(wallTime(tick.at, "Asia/Riyadh")).toEndWith("T00:00");
        if (index > 0) {
          expect(tick.at - (ticks[index - 1]?.at ?? 0)).toBe(
            every * 86_400_000
          );
        }
      }
    }
  });

  test("keep to midnight across a clock change", () => {
    const ticks = timeTicks(
      {
        from: Date.parse("2026-10-20T00:00:00Z"),
        to: Date.parse("2026-10-27T00:00:00Z"),
      },
      "ltr",
      "Europe/Berlin"
    );
    expect(
      ticks.map((tick) => wallTime(tick.at, "Europe/Berlin").slice(11))
    ).toEqual(Array.from({ length: 7 }, () => "00:00"));
  });
});

describe("the time at a point of the drawing", () => {
  const range = { from: t0, to: t0 + 288 * bucketMs };

  test("is the time drawn there, in either direction", () => {
    const at = t0 + 100 * bucketMs;
    expect(timeAt(xOf(at, range, "ltr"), range, "ltr")).toBeCloseTo(at, -1);
    expect(timeAt(xOf(at, range, "rtl"), range, "rtl")).toBeCloseTo(at, -1);
    expect(timeAt(0, range, "rtl")).toBe(range.to);
  });

  test("between two points is a span, oldest first, widened to whole minutes", () => {
    const older = xOf(t0 + 10 * bucketMs + 20_000, range, "rtl");
    const newer = xOf(t0 + 20 * bucketMs + 20_000, range, "rtl");
    const span = spanBetween(newer, older, range, "rtl");
    expect(span).toEqual({
      from: Math.floor((t0 + 10 * bucketMs + 20_000) / 60_000) * 60_000,
      to: Math.ceil((t0 + 20 * bucketMs + 20_000) / 60_000) * 60_000,
    });
    expect(spanBetween(older, newer, range, "rtl")).toEqual(span);
  });
});

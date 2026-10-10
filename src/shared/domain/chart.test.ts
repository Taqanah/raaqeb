import { describe, expect, test } from "bun:test";
import { dayZoom, zoomedChart } from "./chart.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
// 2026-10-03 12:00 UTC.
const now = Date.UTC(2026, 9, 3, 12, 0);

describe("a zoomed chart", () => {
  test("a zoomed hour reads every minute's checks", () => {
    expect(zoomedChart({ from: now - 2 * hour, to: now - hour }, now)).toEqual({
      bucketMs: minute,
      from: now - 2 * hour,
      tier: "raw",
      to: now - hour,
    });
  });

  test("has no more than 360 points, each a round width", () => {
    for (const [span, bucketMs] of [
      [6 * hour, minute],
      [6 * hour + minute, 2 * minute],
      [day, 5 * minute],
      [2 * day, 10 * minute],
      [3 * day, 15 * minute],
      [7 * day, 30 * minute],
      [10 * day, hour],
      [30 * day, 2 * hour],
      [90 * day, 6 * hour],
    ] as const) {
      expect(zoomedChart({ from: now - span, to: now }, now)?.bucketMs).toBe(
        bucketMs
      );
    }
  });

  test("starts on its point width, so a point covers whole minutes or hours", () => {
    const chart = zoomedChart(
      { from: now - 2 * hour + 30_000, to: now - hour },
      now
    );
    expect(chart?.from).toBe(now - 2 * hour);
    const hourly = zoomedChart({ from: now - 10 * day + minute, to: now }, now);
    expect(hourly?.from).toBe(now - 10 * day);
  });

  test("reads the checks while they are kept, and the hourly rollups in whole hours before that", () => {
    expect(zoomedChart({ from: now - day, to: now }, now)?.tier).toBe("raw");
    const old = zoomedChart(
      { from: now - 40 * day, to: now - 40 * day + 2 * hour },
      now
    );
    expect(old).toEqual({
      bucketMs: hour,
      from: now - 40 * day,
      tier: "hourly",
      to: now - 40 * day + 2 * hour,
    });
    expect(zoomedChart({ from: now - 7 * day, to: now }, now)?.tier).toBe(
      "raw"
    );
    expect(zoomedChart({ from: now - 10 * day, to: now }, now)?.tier).toBe(
      "hourly"
    );
  });

  test("is cut to now and to the last 90 days", () => {
    expect(zoomedChart({ from: now - hour, to: now + 5 * hour }, now)?.to).toBe(
      now
    );
    expect(
      zoomedChart({ from: now - 100 * day, to: now - 80 * day }, now)?.from
    ).toBe(now - 90 * day);
  });

  test("a span narrower than five minutes, reversed or in the future is no zoom", () => {
    expect(
      zoomedChart({ from: now - 4 * minute, to: now }, now)
    ).toBeUndefined();
    expect(zoomedChart({ from: now, to: now - hour }, now)).toBeUndefined();
    expect(
      zoomedChart({ from: now + hour, to: now + 2 * hour }, now)
    ).toBeUndefined();
    expect(
      zoomedChart({ from: now - 200 * day, to: now - 100 * day }, now)
    ).toBeUndefined();
  });
});

describe("the span a day card zooms the chart to", () => {
  const today = Date.UTC(2026, 9, 3);

  test("is the whole UTC day, cut to now by the chart", () => {
    expect(dayZoom(today - day, now)).toEqual({ from: today - day, to: today });
    expect(dayZoom(today, now)).toEqual({ from: today, to: today + day });
  });

  test("is nothing just after midnight, while less of today has passed than the smallest zoom", () => {
    expect(dayZoom(today, today + 4 * minute)).toBeUndefined();
    expect(dayZoom(today, today + 5 * minute)).toEqual({
      from: today,
      to: today + day,
    });
  });
});

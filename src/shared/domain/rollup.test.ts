import { describe, expect, test } from "bun:test";
import type { CheckResult } from "@/shared/schemas/check.ts";
import type { Rollup } from "@/shared/schemas/rollup.ts";
import {
  bucketsOf,
  type CheckPoint,
  dailyOfHours,
  rollupsOfDay,
} from "./rollup.ts";

/** A UTC day's start. */
const day = 1_700_006_400_000;
const minute = 60_000;
const hour = 60 * minute;
const dayMs = 24 * hour;

function point(
  startedAt: number,
  result: CheckResult = "up",
  responseMs: number | undefined = 100
): CheckPoint {
  return { responseMs, result, startedAt };
}

/** A check at the start of every hour listed. */
function hourly(hours: Iterable<number>): CheckPoint[] {
  return Array.from(hours, (index) => point(day + index * hour));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, index) => from + index);
}

function rollup(fields: Partial<Rollup> & Pick<Rollup, "at">): Rollup {
  return {
    averageMs: 100,
    checks: 10,
    degraded: 0,
    failed: 0,
    maxMs: 150,
    minMs: 50,
    monitorId: "m",
    observedMs: hour,
    ...fields,
  };
}

describe("the rollups of a sealed day", () => {
  test("the time a maintenance window covered the monitor leaves the day's and each hour's observed time, and its checks still count", () => {
    const { daily, hourly: hours } = rollupsOfDay({
      after: day + dayMs,
      before: day - minute,
      checks: hourly(range(0, 24)),
      day,
      excluded: [{ from: day + 2 * hour, to: day + 3 * hour + 30 * minute }],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(daily.observedMs).toBe(dayMs - 90 * minute);
    expect(daily.checks).toBe(24);
    expect(hours.find((each) => each.at === day + 2 * hour)).toMatchObject({
      checks: 1,
      observedMs: 0,
    });
    expect(hours.find((each) => each.at === day + 3 * hour)).toMatchObject({
      checks: 1,
      observedMs: 30 * minute,
    });
  });

  test("an hour's rollup counts its checks, its down and its degraded ones, and times only the up and degraded checks", () => {
    const { hourly: hours } = rollupsOfDay({
      after: day + dayMs,
      before: day - 20 * minute,
      checks: [
        point(day, "up", 100),
        point(day + 20 * minute, "degraded", 400),
        point(day + 40 * minute, "down", 9000),
        ...hourly(range(1, 24)),
      ],
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(hours[0]).toEqual({
      at: day,
      averageMs: 250,
      checks: 3,
      degraded: 1,
      failed: 1,
      maxMs: 400,
      minMs: 100,
      monitorId: "m",
      observedMs: hour,
    });
  });

  test("the average is in whole milliseconds, rounded", () => {
    const { daily } = rollupsOfDay({
      after: undefined,
      before: undefined,
      checks: [point(day, "up", 100), point(day + minute, "up", 101)],
      day,
      excluded: [],
      gapLimitMs: 2 * minute,
      monitorId: "m",
    });
    expect(daily.averageMs).toBe(101);
  });

  test("an hour whose checks were all down, or had no time, has no response time", () => {
    const { hourly: hours } = rollupsOfDay({
      after: undefined,
      before: undefined,
      checks: [
        point(day, "down", 10_000),
        // Built whole: the helper's default would turn an undefined time into 100.
        { responseMs: undefined, result: "up", startedAt: day + hour },
      ],
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(hours[0]).toMatchObject({
      averageMs: undefined,
      checks: 1,
      failed: 1,
      maxMs: undefined,
      minMs: undefined,
    });
    expect(hours[1]).toMatchObject({ averageMs: undefined, checks: 1 });
  });

  test("observed time crosses the day's edges: the check before the day covers its start, and the day's last check covers up to the first one after it", () => {
    const { daily, hourly: hours } = rollupsOfDay({
      after: day + dayMs + 30 * minute,
      before: day - 30 * minute,
      checks: Array.from({ length: 24 }, (_, index) =>
        point(day + index * hour + 30 * minute)
      ),
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(daily.observedMs).toBe(dayMs);
    expect(hours).toHaveLength(24);
    expect(hours.every((row) => row.observedMs === hour)).toBe(true);
  });

  test("without a check before the day, observed time starts at the day's first check", () => {
    const { daily } = rollupsOfDay({
      after: day + dayMs,
      before: undefined,
      checks: Array.from({ length: 24 }, (_, index) =>
        point(day + index * hour + 30 * minute)
      ),
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(daily.observedMs).toBe(dayMs - 30 * minute);
  });

  test("a gap longer than the gap limit is not observed; an hour inside it with no check has no row, and the check that opened it has observed nothing", () => {
    const { daily, hourly: hours } = rollupsOfDay({
      after: day + dayMs,
      before: day - hour,
      checks: hourly([...range(0, 6), ...range(10, 24)]),
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(daily.observedMs).toBe(5 * hour + 14 * hour);
    expect(hours.map((row) => (row.at - day) / hour)).toEqual([
      ...range(0, 6),
      ...range(10, 24),
    ]);
    expect(hours[5]).toMatchObject({ checks: 1, observedMs: 0 });
  });

  test("without a check after the day, the last check covers the rest of the day while that is within the gap limit, and nothing past it otherwise", () => {
    const within = rollupsOfDay({
      after: undefined,
      before: day - hour,
      checks: hourly(range(0, 24)),
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(within.daily.observedMs).toBe(dayMs);
    const beyond = rollupsOfDay({
      after: undefined,
      before: day - hour,
      checks: hourly(range(0, 21)),
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(beyond.daily.observedMs).toBe(20 * hour);
  });

  test("the first check after the day ends the last check's cover: past the gap limit the day's end is no data, though the day itself ends inside it", () => {
    const { daily } = rollupsOfDay({
      after: day + dayMs + 10 * minute,
      before: day - hour,
      checks: hourly(range(0, 24)),
      day,
      excluded: [],
      gapLimitMs: 65 * minute,
      monitorId: "m",
    });
    expect(daily.observedMs).toBe(dayMs - hour);
  });

  test("an hour with observed time and no check has a row with no checks", () => {
    const { hourly: hours } = rollupsOfDay({
      after: day + dayMs,
      before: day - 3 * hour,
      checks: hourly(range(0, 8).map((index) => index * 3)),
      day,
      excluded: [],
      gapLimitMs: 6 * hour,
      monitorId: "m",
    });
    expect(hours).toHaveLength(24);
    expect(hours[1]).toEqual({
      at: day + hour,
      averageMs: undefined,
      checks: 0,
      degraded: 0,
      failed: 0,
      maxMs: undefined,
      minMs: undefined,
      monitorId: "m",
      observedMs: hour,
    });
  });

  test("the day's rollup sums every check of the day, its average weighing each timed check once", () => {
    const { daily, hourly: hours } = rollupsOfDay({
      after: undefined,
      before: undefined,
      checks: [
        point(day, "up", 100),
        point(day + hour, "up", 200),
        point(day + hour + minute, "up", 300),
        point(day + 2 * hour, "degraded", 900),
        point(day + 3 * hour, "down", 50),
      ],
      day,
      excluded: [],
      gapLimitMs: 2 * hour,
      monitorId: "m",
    });
    expect(daily).toEqual({
      at: day,
      averageMs: 375,
      checks: 5,
      degraded: 1,
      failed: 1,
      maxMs: 900,
      minMs: 100,
      monitorId: "m",
      observedMs: hours.reduce((sum, row) => sum + row.observedMs, 0),
    });
  });
});

describe("the chart's buckets", () => {
  test("raw checks sum into buckets from the start; a down check is counted but not timed; a bucket without a check and a check outside the range are left out", () => {
    const buckets = bucketsOf({
      bucketMs: 10 * minute,
      checks: [
        point(day - minute, "up", 999),
        point(day, "up", 100),
        point(day + minute, "down", 5000),
        point(day + 2 * minute, "degraded", 300),
        point(day + 25 * minute, "up", 50),
        point(day + 30 * minute, "up", 999),
      ],
      from: day,
      rollups: [],
      to: day + 30 * minute,
    });
    expect(buckets).toEqual([
      {
        at: day,
        averageMs: 200,
        checks: 3,
        degraded: 1,
        down: 1,
        maxMs: 300,
        minMs: 100,
      },
      {
        at: day + 20 * minute,
        averageMs: 50,
        checks: 1,
        degraded: 0,
        down: 0,
        maxMs: 50,
        minMs: 50,
      },
    ]);
  });

  test("rollups sum into the bucket their start falls in, each average weighing its up and degraded checks", () => {
    const [bucket] = bucketsOf({
      bucketMs: 2 * hour,
      checks: [],
      from: day,
      rollups: [
        rollup({ at: day, averageMs: 100, checks: 10, maxMs: 120, minMs: 80 }),
        rollup({
          at: day + hour,
          averageMs: 200,
          checks: 30,
          degraded: 2,
          failed: 20,
          maxMs: 400,
          minMs: 90,
        }),
      ],
      to: day + 2 * hour,
    });
    expect(bucket).toEqual({
      at: day,
      averageMs: 150,
      checks: 40,
      degraded: 2,
      down: 20,
      maxMs: 400,
      minMs: 80,
    });
  });

  test("rollups and raw checks in one bucket sum together; a rollup with no time adds its counts only; one outside the range is left out", () => {
    const buckets = bucketsOf({
      bucketMs: 2 * hour,
      checks: [point(day + hour + minute, "up", 400)],
      from: day,
      rollups: [
        rollup({ at: day - hour, averageMs: 999 }),
        rollup({ at: day, averageMs: 100, checks: 3 }),
        rollup({
          at: day + hour - 1,
          averageMs: undefined,
          checks: 2,
          failed: 2,
          maxMs: undefined,
          minMs: undefined,
        }),
        rollup({ at: day + 2 * hour, averageMs: 999 }),
      ],
      to: day + 2 * hour,
    });
    expect(buckets).toEqual([
      {
        at: day,
        averageMs: 175,
        checks: 6,
        degraded: 0,
        down: 2,
        maxMs: 400,
        minMs: 50,
      },
    ]);
  });

  test("a bucket whose rollups hold observed time and no check is left out, as a bucket with no raw check is", () => {
    expect(
      bucketsOf({
        bucketMs: 2 * hour,
        checks: [],
        from: day,
        rollups: [
          rollup({
            at: day,
            averageMs: undefined,
            checks: 0,
            maxMs: undefined,
            minMs: undefined,
          }),
        ],
        to: day + 2 * hour,
      })
    ).toEqual([]);
  });
});

describe("a day's rollup summed from its hours", () => {
  const hourOf = (at: number, overrides: Partial<Rollup> = {}): Rollup => ({
    at,
    averageMs: 100,
    checks: 4,
    degraded: 1,
    failed: 0,
    maxMs: 200,
    minMs: 50,
    monitorId: "m",
    observedMs: hour,
    ...overrides,
  });

  test("adds up the counts and the observed time, and keeps the lowest and highest times", () => {
    expect(
      dailyOfHours("m", day, [
        hourOf(day, { maxMs: 300, minMs: 40 }),
        hourOf(day + hour, { degraded: 2, failed: 1, observedMs: hour / 2 }),
      ])
    ).toEqual({
      at: day,
      averageMs: 100,
      checks: 8,
      degraded: 3,
      failed: 1,
      maxMs: 300,
      minMs: 40,
      monitorId: "m",
      observedMs: hour + hour / 2,
    });
  });

  test("weighs each hour's average by its up and degraded checks, in whole milliseconds", () => {
    const summed = dailyOfHours("m", day, [
      hourOf(day, { averageMs: 100, checks: 3, failed: 0 }),
      hourOf(day + hour, { averageMs: 201, checks: 4, failed: 3 }),
    ]);
    // (100 * 3 + 201 * 1) / 4 = 125.25
    expect(summed.averageMs).toBe(125);
  });

  test("an hour with no timed check leaves the times alone, and a day with none has none", () => {
    const untimed = {
      averageMs: undefined,
      failed: 4,
      maxMs: undefined,
      minMs: undefined,
    };
    expect(
      dailyOfHours("m", day, [hourOf(day), hourOf(day + hour, untimed)])
    ).toMatchObject({ averageMs: 100, maxMs: 200, minMs: 50 });
    expect(dailyOfHours("m", day, [hourOf(day, untimed)])).toMatchObject({
      averageMs: undefined,
      maxMs: undefined,
      minMs: undefined,
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  errorBudget,
  monthDates,
  quarterDates,
  rangeKind,
  reportPeriod,
} from "./report.ts";

const day = 86_400_000;
const now = Date.UTC(2026, 9, 19, 12);

describe("a report's range", () => {
  test("a closed month runs from its first UTC midnight to the midnight after its last day", () => {
    expect(reportPeriod("2026-09-01", "2026-09-30", now)).toEqual({
      from: "2026-09-01",
      fromMs: Date.UTC(2026, 8, 1),
      open: false,
      to: "2026-09-30",
      toMs: Date.UTC(2026, 9, 1),
    });
  });

  test("a range that reaches today is open and ends at now, not at the end of the day, and its last day is cut to today, where the figures stop", () => {
    expect(reportPeriod("2026-10-01", "2026-10-31", now)).toMatchObject({
      open: true,
      to: "2026-10-19",
      toMs: now,
    });
    expect(reportPeriod("2026-10-19", "2026-10-19", now)).toMatchObject({
      fromMs: Date.UTC(2026, 9, 19),
      open: true,
      toMs: now,
    });
  });

  test("a range ending yesterday is closed", () => {
    expect(reportPeriod("2026-10-01", "2026-10-18", now)).toMatchObject({
      open: false,
      toMs: Date.UTC(2026, 9, 19),
    });
  });

  test("a range of today alone is open from the very midnight it starts", () => {
    const midnight = Date.UTC(2026, 9, 19);
    expect(reportPeriod("2026-10-19", "2026-10-19", midnight)).toMatchObject({
      open: true,
      toMs: midnight,
    });
  });

  test("a range ending the day before now is closed even when now is its midnight", () => {
    expect(
      reportPeriod("2026-10-01", "2026-10-18", Date.UTC(2026, 9, 19))
    ).toMatchObject({ open: false, toMs: Date.UTC(2026, 9, 19) });
  });

  test("a day that does not exist, a last day before the first, or a first day after today has no range", () => {
    expect(reportPeriod("2026-02-30", "2026-03-05", now)).toBeUndefined();
    expect(reportPeriod("2026-09-10", "2026-09-09", now)).toBeUndefined();
    expect(reportPeriod("2026-10-20", "2026-10-25", now)).toBeUndefined();
    expect(reportPeriod("September", "2026-09-30", now)).toBeUndefined();
  });

  test("a year of days is the most: 366 are served and 367 are not", () => {
    expect(reportPeriod("2025-10-19", "2026-10-19", now)).toBeDefined();
    expect(reportPeriod("2025-10-18", "2026-10-19", now)).toBeUndefined();
  });

  test("a month and a quarter are written as their first and last day, a leap February included", () => {
    expect(monthDates(2026, 9)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(monthDates(2028, 2)).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(monthDates(2026, 12)).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(quarterDates(2026, 1)).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(quarterDates(2026, 4)).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
    });
  });

  test("a range is a month or a quarter only when it is exactly one", () => {
    expect(rangeKind("2026-09-01", "2026-09-30")).toBe("month");
    expect(rangeKind("2028-02-01", "2028-02-29")).toBe("month");
    expect(rangeKind("2026-07-01", "2026-09-30")).toBe("quarter");
    expect(rangeKind("2026-09-01", "2026-09-29")).toBe("custom");
    expect(rangeKind("2026-09-02", "2026-10-01")).toBe("custom");
    expect(rangeKind("2026-07-01", "2026-12-31")).toBe("custom");
    // Three months, but not from the start of a quarter.
    expect(rangeKind("2026-02-01", "2026-04-30")).toBe("custom");
  });
});

describe("the error budget", () => {
  const thirtyDays = 30 * day;

  test("a 99.9 target allows a thousandth of the observed time, and the downtime uses part of it", () => {
    expect(
      errorBudget({ downtimeMs: 1_000_000, observedMs: thirtyDays }, 99.9)
    ).toEqual({
      allowedMs: 2_592_000,
      leftMs: 1_592_000,
      met: true,
      usedRatio: 1_000_000 / 2_592_000,
    });
  });

  test("downtime exactly the budget meets the target with nothing left, and a millisecond more misses it", () => {
    expect(
      errorBudget({ downtimeMs: 2_592_000, observedMs: thirtyDays }, 99.9)
    ).toMatchObject({ leftMs: 0, met: true, usedRatio: 1 });
    expect(
      errorBudget({ downtimeMs: 2_592_001, observedMs: thirtyDays }, 99.9)
    ).toMatchObject({ leftMs: -1, met: false });
  });

  test("a missed target shows how far over: the used share passes 1 and what is left is negative", () => {
    const budget = errorBudget(
      { downtimeMs: 5_184_000, observedMs: thirtyDays },
      99.9
    );
    expect(budget?.usedRatio).toBe(2);
    expect(budget?.leftMs).toBe(-2_592_000);
    expect(budget?.met).toBe(false);
  });

  test("a window with no observed time has no budget", () => {
    expect(errorBudget({ downtimeMs: 0, observedMs: 0 }, 99.9)).toBeUndefined();
  });

  test("a budget smaller than a millisecond is cut to none, judged by the exact figure, and its used share stays finite", () => {
    expect(errorBudget({ downtimeMs: 0, observedMs: 1000 }, 99.999)).toEqual({
      allowedMs: 0,
      leftMs: 0,
      met: true,
      usedRatio: 0,
    });
    const missed = errorBudget({ downtimeMs: 1, observedMs: 1000 }, 99.999);
    expect(missed?.met).toBe(false);
    expect(Number.isFinite(missed?.usedRatio)).toBe(true);
    expect(missed?.usedRatio).toBeCloseTo(100, 6);
  });

  test("a pooled quarter of 200 monitors does not lose precision to floating point", () => {
    const observed = 200 * 92 * day;
    // 99.99 allows exactly 0.01 percent: 158 976 000 ms of 1 589 760 000 000.
    expect(
      errorBudget({ downtimeMs: 0, observedMs: observed }, 99.99)
    ).toMatchObject({
      allowedMs: 158_976_000,
    });
    expect(
      errorBudget({ downtimeMs: 158_976_000, observedMs: observed }, 99.99)?.met
    ).toBe(true);
    expect(
      errorBudget({ downtimeMs: 158_976_001, observedMs: observed }, 99.99)?.met
    ).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { historyMonth, monthOf } from "./history.ts";

const at = (year: number, month: number, day = 1, hour = 0) =>
  Date.UTC(year, month - 1, day, hour);

describe("the UTC month an instant falls in", () => {
  test("names the month by year and two digits", () => {
    expect(monthOf(at(2026, 9, 11, 12))).toBe("2026-09");
    expect(monthOf(at(2026, 12, 31, 23))).toBe("2026-12");
  });

  test("turns at UTC midnight, whatever the install's zone", () => {
    expect(monthOf(at(2026, 10) - 1)).toBe("2026-09");
    expect(monthOf(at(2026, 10))).toBe("2026-10");
  });
});

describe("the month the history shows", () => {
  const now = at(2026, 1, 15, 12);
  const starts = [at(2025, 11, 20), at(2026, 1, 3), at(2025, 11, 2)];

  test("with none named it is the current month, after the oldest entry's", () => {
    expect(historyMonth(starts, undefined, now)).toEqual({
      month: "2026-01",
      next: undefined,
      previous: "2025-12",
    });
  });

  test("reaches back to the month of an oldest entry older than the bar, and no further", () => {
    const older = [...starts, at(2025, 6, 2)];
    expect(historyMonth(older, "2025-06", now)).toEqual({
      month: "2025-06",
      next: "2025-07",
      previous: undefined,
    });
    expect(historyMonth(older, "2025-05", now)).toBeUndefined();
  });

  test("reaches back to the month of the day bar's first day when the oldest entry is younger, so every day card's month is a history month", () => {
    // The bar's first day is 2025-10-18, 89 days before today.
    expect(historyMonth(starts, "2025-10", now)).toEqual({
      month: "2025-10",
      next: "2025-11",
      previous: undefined,
    });
    expect(historyMonth(starts, "2025-09", now)).toBeUndefined();
  });

  test("a month inside the range with no entry of its own is still shown", () => {
    expect(historyMonth(starts, "2025-12", now)).toEqual({
      month: "2025-12",
      next: "2026-01",
      previous: "2025-11",
    });
  });

  test("a month after the current one is not shown", () => {
    expect(historyMonth(starts, "2026-02", now)).toBeUndefined();
  });

  test("with no entry at all the history reaches from the bar's first day's month to the current month", () => {
    expect(historyMonth([], undefined, now)).toEqual({
      month: "2026-01",
      next: undefined,
      previous: "2025-12",
    });
    expect(historyMonth([], "2025-10", now)).toEqual({
      month: "2025-10",
      next: "2025-11",
      previous: undefined,
    });
    expect(historyMonth([], "2025-09", now)).toBeUndefined();
  });

  test("an entry that starts in a later month than now does not stretch the range", () => {
    expect(historyMonth([at(2026, 3, 1)], undefined, now)?.next).toBe(
      undefined
    );
    expect(historyMonth([at(2026, 3, 1)], "2026-02", now)).toBeUndefined();
  });
});

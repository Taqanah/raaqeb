import { describe, expect, test } from "bun:test";
import type {
  MaintenanceStage,
  Recurrence,
  RecurrenceDays,
} from "@/shared/schemas/maintenance.ts";
import {
  nextOccurrenceStart,
  nextOccurrencesOnly,
  occurrencesBetween,
  plannedUntilAt,
} from "./series.ts";

const minute = 60_000;
const day = 86_400_000;

function recurrence(
  days: RecurrenceDays,
  overrides: Partial<Recurrence> = {}
): Recurrence {
  return { days, minutes: 120, time: "02:00", timeZone: "UTC", ...overrides };
}

const starts = (
  rule: Recurrence,
  from: number,
  to: number
): readonly number[] =>
  occurrencesBetween(rule, from, to).map((each) => each.startsAt);

describe("a weekly series", () => {
  test("starts on each day ticked at its time on its zone's clock, soonest first", () => {
    // 1 October 2026 is a Thursday; Riyadh keeps UTC+3 all year.
    const rule = recurrence(
      { repeat: "weekly", weekdays: [0, 2] },
      { time: "02:30", timeZone: "Asia/Riyadh" }
    );
    expect(starts(rule, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 15))).toEqual([
      Date.UTC(2026, 9, 3, 23, 30),
      Date.UTC(2026, 9, 5, 23, 30),
      Date.UTC(2026, 9, 10, 23, 30),
      Date.UTC(2026, 9, 12, 23, 30),
    ]);
  });

  test("an occurrence lasts the series' minutes", () => {
    const rule = recurrence(
      { repeat: "weekly", weekdays: [4] },
      { minutes: 90 }
    );
    expect(
      occurrencesBetween(rule, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2))
    ).toEqual([
      {
        endsAt: Date.UTC(2026, 9, 1, 2) + 90 * minute,
        startsAt: Date.UTC(2026, 9, 1, 2),
      },
    ]);
  });

  test("an occurrence starting at `from` is in, one starting at `to` is not", () => {
    const rule = recurrence({ repeat: "weekly", weekdays: [4] });
    const thursday = Date.UTC(2026, 9, 1, 2);
    expect(starts(rule, thursday, thursday + 7 * day)).toEqual([thursday]);
    expect(starts(rule, thursday + 1, thursday + 7 * day)).toEqual([]);
  });

  test("keeps its wall-clock time across a daylight-saving change", () => {
    // New York moves from UTC-4 to UTC-5 on 1 November 2026.
    const rule = recurrence(
      { repeat: "weekly", weekdays: [0] },
      { time: "09:00", timeZone: "America/New_York" }
    );
    expect(starts(rule, Date.UTC(2026, 9, 24), Date.UTC(2026, 10, 9))).toEqual([
      Date.UTC(2026, 9, 25, 13),
      Date.UTC(2026, 10, 1, 14),
      Date.UTC(2026, 10, 8, 14),
    ]);
  });

  test("a start time the clock skips that day starts when the clock reaches it after the change, and at its time the next week", () => {
    // New York's clock jumps from 02:00 to 03:00 on 8 March 2026, so 02:30 that day reads at UTC-5: 03:30 on the new clock.
    const rule = recurrence(
      { repeat: "weekly", weekdays: [0] },
      { time: "02:30", timeZone: "America/New_York" }
    );
    expect(starts(rule, Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 16))).toEqual([
      Date.UTC(2026, 2, 8, 7, 30),
      Date.UTC(2026, 2, 15, 6, 30),
    ]);
  });

  test("a day the zone's calendar skips altogether gives no second occurrence", () => {
    // Samoa went from 29 to 31 December 2011, UTC-10 to UTC+14: the skipped 30th reads as the 31st's start.
    const rule = recurrence(
      { repeat: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      { timeZone: "Pacific/Apia" }
    );
    expect(starts(rule, Date.UTC(2011, 11, 29), Date.UTC(2012, 0, 1))).toEqual([
      Date.UTC(2011, 11, 29, 12),
      Date.UTC(2011, 11, 30, 12),
      Date.UTC(2011, 11, 31, 12),
    ]);
  });

  test("a start time the clock repeats that day starts the first time", () => {
    // New York's clock goes from 02:00 back to 01:00 on 1 November 2026, so 01:30 comes twice: 05:30 and 06:30 UTC.
    const rule = recurrence(
      { repeat: "weekly", weekdays: [0] },
      { time: "01:30", timeZone: "America/New_York" }
    );
    expect(starts(rule, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 2))).toEqual([
      Date.UTC(2026, 10, 1, 5, 30),
    ]);
  });
});

describe("a monthly series", () => {
  test("on a day of the month starts on that day each month", () => {
    const rule = recurrence({ day: 15, repeat: "monthly_day" });
    expect(starts(rule, Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1))).toEqual([
      Date.UTC(2026, 9, 15, 2),
      Date.UTC(2026, 10, 15, 2),
      Date.UTC(2026, 11, 15, 2),
    ]);
  });

  test("on day 29, 30 or 31 falls on the last day of a shorter month", () => {
    const rule = recurrence({ day: 31, repeat: "monthly_day" });
    expect(starts(rule, Date.UTC(2027, 0, 1), Date.UTC(2027, 4, 1))).toEqual([
      Date.UTC(2027, 0, 31, 2),
      Date.UTC(2027, 1, 28, 2),
      Date.UTC(2027, 2, 31, 2),
      Date.UTC(2027, 3, 30, 2),
    ]);
    const leap = recurrence({ day: 30, repeat: "monthly_day" });
    expect(starts(leap, Date.UTC(2028, 1, 1), Date.UTC(2028, 2, 1))).toEqual([
      Date.UTC(2028, 1, 29, 2),
    ]);
  });

  test("on an nth weekday starts on that weekday of each month", () => {
    // The second Tuesday: 13 October, 10 November, 8 December 2026.
    const rule = recurrence({
      repeat: "monthly_weekday",
      week: "second",
      weekday: 2,
    });
    expect(starts(rule, Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1))).toEqual([
      Date.UTC(2026, 9, 13, 2),
      Date.UTC(2026, 10, 10, 2),
      Date.UTC(2026, 11, 8, 2),
    ]);
  });

  test("on the last weekday starts on that weekday of each month's last seven days", () => {
    // The last Friday: 30 October (a fifth Friday), 27 November 2026.
    const rule = recurrence({
      repeat: "monthly_weekday",
      week: "last",
      weekday: 5,
    });
    expect(starts(rule, Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 1))).toEqual([
      Date.UTC(2026, 9, 30, 2),
      Date.UTC(2026, 10, 27, 2),
    ]);
  });

  test("on the last weekday is the month's very last of it, never the one a week before", () => {
    // November 2026 has 30 days and five Mondays: the 23rd and the 30th; only the 30th is the last.
    const rule = recurrence({
      repeat: "monthly_weekday",
      week: "last",
      weekday: 1,
    });
    expect(starts(rule, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1))).toEqual([
      Date.UTC(2026, 10, 30, 2),
    ]);
  });

  test("on the fourth weekday is never the fifth", () => {
    const rule = recurrence({
      repeat: "monthly_weekday",
      week: "fourth",
      weekday: 5,
    });
    expect(starts(rule, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1))).toEqual([
      Date.UTC(2026, 9, 23, 2),
    ]);
  });

  test("starts on the day as its own zone's calendar reads it", () => {
    // 02:00 on the 1st in Riyadh is 23:00 on the last day of the month before in UTC.
    const rule = recurrence(
      { day: 1, repeat: "monthly_day" },
      { timeZone: "Asia/Riyadh" }
    );
    expect(starts(rule, Date.UTC(2026, 9, 15), Date.UTC(2026, 11, 15))).toEqual(
      [Date.UTC(2026, 9, 31, 23), Date.UTC(2026, 10, 30, 23)]
    );
  });
});

describe("a series' next occurrence", () => {
  test("is the first one starting at the time given or later, however far", () => {
    const monthly = recurrence({ day: 31, repeat: "monthly_day" });
    expect(nextOccurrenceStart(monthly, Date.UTC(2027, 1, 1))).toBe(
      Date.UTC(2027, 1, 28, 2)
    );
    const weekly = recurrence({ repeat: "weekly", weekdays: [4] });
    const thursday = Date.UTC(2026, 9, 1, 2);
    expect(nextOccurrenceStart(weekly, thursday)).toBe(thursday);
    expect(nextOccurrenceStart(weekly, thursday + 1)).toBe(thursday + 7 * day);
  });
});

describe("what a create or an edit schedules", () => {
  test("is the coming week when the series' next occurrence falls in it", () => {
    const weekly = recurrence({ repeat: "weekly", weekdays: [4] });
    const now = Date.UTC(2026, 9, 1);
    expect(plannedUntilAt(weekly, now)).toBe(now + 7 * day + 1);
  });

  test("reaches the series' next occurrence when it is more than a week away, so the series' notice has one to name", () => {
    const monthly = recurrence({ day: 25, repeat: "monthly_day" });
    const now = Date.UTC(2026, 9, 1);
    const until = plannedUntilAt(monthly, now);
    expect(starts(monthly, now, until)).toEqual([Date.UTC(2026, 9, 25, 2)]);
  });
});

describe("the windows a visitor sees", () => {
  const window = (
    id: string,
    stage: MaintenanceStage,
    startsAt: number,
    seriesId?: string
  ) => ({ id, seriesId, stage, startsAt });

  test("of a series are its next occurrence alone: the soonest scheduled", () => {
    const shown = nextOccurrencesOnly([
      window("thursday", "scheduled", 3 * day, "daily"),
      window("tuesday", "scheduled", day, "daily"),
      window("wednesday", "scheduled", 2 * day, "daily"),
    ]);
    expect(shown.map((each) => each.id)).toEqual(["tuesday"]);
  });

  test("of a series are the occurrence in progress alone while one runs", () => {
    const shown = nextOccurrencesOnly([
      window("today", "in_progress", 0, "daily"),
      window("tomorrow", "scheduled", day, "daily"),
    ]);
    expect(shown.map((each) => each.id)).toEqual(["today"]);
  });

  test("keep every window of no series, every completed occurrence and each series' own next, in the order given", () => {
    const shown = nextOccurrencesOnly([
      window("done", "completed", -day, "daily"),
      window("move", "scheduled", 5 * day),
      window("daily-next", "scheduled", day, "daily"),
      window("weekly-next", "scheduled", 2 * day, "weekly"),
      window("daily-after", "scheduled", 2 * day, "daily"),
      window("upgrade", "scheduled", 6 * day),
    ]);
    expect(shown.map((each) => each.id)).toEqual([
      "done",
      "move",
      "daily-next",
      "weekly-next",
      "upgrade",
    ]);
  });
});

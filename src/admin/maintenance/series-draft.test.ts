import { describe, expect, test } from "bun:test";
import type { MaintenanceSeries } from "@/shared/schemas/maintenance.ts";
import {
  type RecurrenceDraft,
  recurrenceDraftOf,
  type SeriesTextDraft,
  seriesDraftOf,
  seriesInputOf,
} from "./series-draft.ts";
import type { WindowDraft } from "./window-draft.ts";

const riyadh = "Asia/Riyadh";

/** Saturday 26 September 2026, 15:30 to 17:00 on the operator's clock. */
const window: WindowDraft = {
  componentIds: ["web"],
  ends: "2026-09-26T17:00",
  message: { ar: "نحدّث الخوادم.", en: "" },
  starts: "2026-09-26T15:30",
  title: { ar: "صيانة الخوادم", en: "Server upkeep" },
};

const text: SeriesTextDraft = {
  componentIds: window.componentIds,
  message: window.message,
  title: window.title,
};

const weekly: RecurrenceDraft = {
  day: 26,
  hours: "1",
  minutes: 30,
  monthly: "day",
  repeat: "weekly",
  time: "15:30",
  timeZone: riyadh,
  week: "fourth",
  weekday: 6,
  weekdays: [3, 1],
};

describe("the recurrence picker's draft", () => {
  test("a new window repeats once, its other kinds starting from the window's day, start and length", () => {
    expect(recurrenceDraftOf(window, riyadh)).toEqual({
      day: 26,
      hours: "1",
      minutes: 30,
      monthly: "day",
      repeat: "once",
      time: "15:30",
      timeZone: riyadh,
      week: "fourth",
      weekday: 6,
      weekdays: [6],
    });
  });

  test("a window in a month's last seven days past the 28th starts the nth weekday at the last", () => {
    expect(
      recurrenceDraftOf(
        { ...window, ends: "2026-09-29T17:00", starts: "2026-09-29T15:30" },
        riyadh
      )
    ).toMatchObject({ day: 29, week: "last", weekday: 2 });
  });

  test("a stored series reads back its kind, its days, its start and its length in hours and minutes", () => {
    const series: MaintenanceSeries = {
      componentIds: ["web", "api"],
      createdAt: 0,
      id: "s1",
      message: { ar: "نص" },
      recurrence: {
        days: { repeat: "monthly_weekday", week: "second", weekday: 2 },
        minutes: 150,
        time: "02:00",
        timeZone: "Europe/London",
      },
      scheduledUntil: 0,
      title: { ar: "صيانة" },
      updatedAt: 0,
    };
    expect(seriesDraftOf(series)).toEqual({
      recurrence: expect.objectContaining({
        hours: "2",
        minutes: 30,
        monthly: "weekday",
        repeat: "monthly",
        time: "02:00",
        timeZone: "Europe/London",
        week: "second",
        weekday: 2,
      }),
      text: {
        componentIds: ["web", "api"],
        message: { ar: "نص", en: "" },
        title: { ar: "صيانة", en: "" },
      },
    });
    const weeklySeries: MaintenanceSeries = {
      ...series,
      recurrence: {
        ...series.recurrence,
        days: { repeat: "weekly", weekdays: [0, 4] },
      },
    };
    expect(seriesDraftOf(weeklySeries).recurrence).toMatchObject({
      repeat: "weekly",
      weekdays: [0, 4],
    });
    const monthlyDay: MaintenanceSeries = {
      ...series,
      recurrence: {
        ...series.recurrence,
        days: { day: 31, repeat: "monthly_day" },
      },
    };
    expect(seriesDraftOf(monthlyDay).recurrence).toMatchObject({
      day: 31,
      monthly: "day",
      repeat: "monthly",
    });
  });
});

describe("what the series form posts", () => {
  test("a weekly series: the days ticked in week order, the start, the length in minutes and the zone, with the text and the components", () => {
    expect(seriesInputOf(text, weekly, "ar")).toEqual({
      input: {
        componentIds: ["web"],
        message: { ar: "نحدّث الخوادم." },
        recurrence: {
          days: { repeat: "weekly", weekdays: [1, 3] },
          minutes: 90,
          time: "15:30",
          timeZone: riyadh,
        },
        title: { ar: "صيانة الخوادم", en: "Server upkeep" },
      },
      ok: true,
    });
  });

  test("a monthly series on a day of the month, or on an nth weekday", () => {
    const monthly = { ...weekly, repeat: "monthly" } as const;
    const onDay = seriesInputOf(text, monthly, "ar");
    expect(onDay.ok && onDay.input.recurrence.days).toEqual({
      day: 26,
      repeat: "monthly_day",
    });
    const onWeekday = seriesInputOf(
      text,
      { ...monthly, monthly: "weekday" },
      "ar"
    );
    expect(onWeekday.ok && onWeekday.input.recurrence.days).toEqual({
      repeat: "monthly_weekday",
      week: "fourth",
      weekday: 6,
    });
  });

  test("no day ticked, a length of nothing, more than a week or not a whole number of hours, no component and no install-language title are each refused on their field", () => {
    expect(
      seriesInputOf(
        { ...text, componentIds: [], title: { ar: "", en: "Upkeep" } },
        { ...weekly, hours: "0", minutes: 0, weekdays: [] },
        "ar"
      )
    ).toEqual({
      errors: {
        components: "maintenance_refused_components",
        duration: "maintenance_refused_duration",
        title: "maintenance_missing_title",
        weekdays: "maintenance_refused_weekdays",
      },
      ok: false,
    });
    for (const hours of ["169", "1.5", "two", "-1"]) {
      expect(seriesInputOf(text, { ...weekly, hours }, "ar")).toEqual({
        errors: { duration: "maintenance_refused_duration" },
        ok: false,
      });
    }
    expect(
      seriesInputOf(text, { ...weekly, hours: "168", minutes: 0 }, "ar").ok
    ).toBe(true);
  });
});

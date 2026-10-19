/**
 * The recurrence picker's draft (CONTEXT.md "Maintenance series"): once,
 * weekly on the days ticked, or monthly on a day of the month or an nth
 * weekday; the start time on the zone's clock, the length in hours and
 * minutes, and the zone. A new window's picker starts from the window's own
 * start and length, so switching from once to weekly or monthly keeps the
 * time the operator already set. It turns into what the series form posts
 * through the shared schema, with one catalog message per refused field.
 * Pure: the form holds the draft in state and calls these.
 */
import { nextOccurrenceStart } from "@/shared/domain/series.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { fromWallTime, wallTime } from "@/shared/i18n/timezone.ts";
import { contentDraftOf } from "@/shared/schemas/content.ts";
import {
  type MaintenanceSeries,
  type MonthWeek,
  monthWeeks,
  occurrenceMaxMinutes,
  type RecurrenceDays,
  type SeriesInput,
  seriesInputSchema,
} from "@/shared/schemas/maintenance.ts";
import { type DraftParse, judged, type WindowDraft } from "./window-draft.ts";

/** How the window repeats: not at all, or as a series of one of two kinds. */
export type Repeat = "monthly" | "once" | "weekly";

export interface RecurrenceDraft {
  /** The day of the month, 1 to 31. */
  readonly day: number;
  /** The length's whole hours as typed. */
  readonly hours: string;
  /** The length's minutes past the hours, 0 to 59. */
  readonly minutes: number;
  /** Which kind of monthly day: the day of the month or the nth weekday. */
  readonly monthly: "day" | "weekday";
  readonly repeat: Repeat;
  /** `HH:MM` on the zone's clock. */
  readonly time: string;
  readonly timeZone: string;
  readonly week: MonthWeek;
  /** The weekday of an nth-weekday month, 0 for Sunday. */
  readonly weekday: number;
  /** The weekly days ticked, 0 for Sunday. */
  readonly weekdays: readonly number[];
}

/** What a series' form holds besides its recurrence. */
export type SeriesTextDraft = Pick<
  WindowDraft,
  "componentIds" | "message" | "title"
>;

const hourMinutes = 60;
/** Whole hours as typed; none typed is none. */
const wholeHours = /^\d*$/;

/** The picker as one occurrence on a date (`2026-09-26`) reads: once, that weekday, that day of the month and that nth weekday. */
function pickerOn(
  date: string,
  time: string,
  minutes: number,
  timeZone: string
): RecurrenceDraft {
  const day = Number(date.slice(8, 10));
  const weekday = new Date(Date.parse(date)).getUTCDay();
  return {
    day,
    hours: String(Math.floor(minutes / hourMinutes)),
    minutes: minutes % hourMinutes,
    monthly: "day",
    repeat: "once",
    time,
    timeZone,
    // The fifth of a weekday is the month's last of it.
    week: monthWeeks[Math.min(Math.ceil(day / 7), 5) - 1] ?? "last",
    weekday,
    weekdays: [weekday],
  };
}

/** The picker for a new window: once, its other kinds starting from the window's start, length and the zone. */
export function recurrenceDraftOf(
  window: WindowDraft,
  timeZone: string
): RecurrenceDraft {
  const starts = fromWallTime(window.starts, timeZone);
  const ends = fromWallTime(window.ends, timeZone);
  const length =
    starts !== undefined && ends !== undefined && ends > starts
      ? Math.round((ends - starts) / 60_000)
      : hourMinutes;
  return pickerOn(
    window.starts.slice(0, 10),
    window.starts.slice(11, 16),
    length,
    timeZone
  );
}

/** A stored series' text and recurrence as the form holds them; the kinds it is not start from its next occurrence. */
export function seriesDraftOf(series: MaintenanceSeries): {
  readonly recurrence: RecurrenceDraft;
  readonly text: SeriesTextDraft;
} {
  const { days, minutes, time, timeZone } = series.recurrence;
  const next = nextOccurrenceStart(series.recurrence, series.scheduledUntil);
  const picker = pickerOn(
    wallTime(next, timeZone).slice(0, 10),
    time,
    minutes,
    timeZone
  );
  let recurrence: RecurrenceDraft;
  if (days.repeat === "weekly") {
    recurrence = { ...picker, repeat: "weekly", weekdays: days.weekdays };
  } else if (days.repeat === "monthly_day") {
    recurrence = {
      ...picker,
      day: days.day,
      monthly: "day",
      repeat: "monthly",
    };
  } else {
    recurrence = {
      ...picker,
      monthly: "weekday",
      repeat: "monthly",
      week: days.week,
      weekday: days.weekday,
    };
  }
  return {
    recurrence,
    text: {
      componentIds: [...series.componentIds],
      message: contentDraftOf(series.message),
      title: contentDraftOf(series.title),
    },
  };
}

/** The days the picker names. */
function daysOf(recurrence: RecurrenceDraft): RecurrenceDays {
  if (recurrence.repeat === "weekly") {
    return { repeat: "weekly", weekdays: [...recurrence.weekdays] };
  }
  return recurrence.monthly === "day"
    ? { day: recurrence.day, repeat: "monthly_day" }
    : {
        repeat: "monthly_weekday",
        week: recurrence.week,
        weekday: recurrence.weekday,
      };
}

/** What the series form posts, or the refusal of every field that does not fit. */
export function seriesInputOf(
  text: SeriesTextDraft,
  recurrence: RecurrenceDraft,
  language: Locale
): DraftParse<SeriesInput> {
  const hours = recurrence.hours.trim();
  const minutes = wholeHours.test(hours)
    ? Number(hours) * hourMinutes + recurrence.minutes
    : Number.NaN;
  const refused: Partial<Record<"duration" | "weekdays", MessageId>> = {};
  if (!(minutes >= 1 && minutes <= occurrenceMaxMinutes)) {
    refused.duration = "maintenance_refused_duration";
  }
  const days = daysOf(recurrence);
  if (days.repeat === "weekly" && days.weekdays.length === 0) {
    refused.weekdays = "maintenance_refused_weekdays";
  }
  return judged(
    seriesInputSchema.safeParse({
      componentIds: text.componentIds,
      message: text.message,
      recurrence: {
        days,
        minutes,
        time: recurrence.time,
        timeZone: recurrence.timeZone,
      },
      title: text.title,
    }),
    text,
    language,
    refused
  );
}

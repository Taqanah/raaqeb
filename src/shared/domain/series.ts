/**
 * A maintenance series' occurrences (CONTEXT.md "Maintenance series",
 * "Occurrence"): the starts its recurrence names, each its start time on its
 * zone's clock that day, whatever the offset. A start time the clock skips
 * that day reads at the offset before the change, so it starts when the
 * clock reaches it after; one the clock repeats starts the first time. Day
 * 29, 30 or 31 falls on a shorter month's last day. An occurrence lasts its
 * minutes of elapsed time. Pure: the times are parameters.
 */
import { fromWallTime, wallTime } from "@/shared/i18n/timezone.ts";
import type {
  Recurrence,
  RecurrenceDays,
} from "@/shared/schemas/maintenance.ts";

const dayMs = 86_400_000;
const minuteMs = 60_000;

/** How long before its start a series schedules an occurrence. */
export const seriesLeadMs = 7 * dayMs;

/** Before when a series has scheduled its occurrences at `now`: every one starting a week from now or sooner. */
export function scheduledUntilAt(now: number): number {
  return now + seriesLeadMs + 1;
}

/** The start and end of one occurrence. */
export interface OccurrenceTimes {
  readonly endsAt: number;
  readonly startsAt: number;
}

const weeks = { first: 1, fourth: 4, second: 2, third: 3 } as const;

/** Whether the recurrence falls on a calendar date, given as its UTC midnight. */
function fallsOn(days: RecurrenceDays, date: number): boolean {
  const at = new Date(date);
  const day = at.getUTCDate();
  const monthDays = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)
  ).getUTCDate();
  if (days.repeat === "weekly") {
    return days.weekdays.includes(at.getUTCDay());
  }
  if (days.repeat === "monthly_day") {
    return day === Math.min(days.day, monthDays);
  }
  if (at.getUTCDay() !== days.weekday) {
    return false;
  }
  return days.week === "last"
    ? day + 7 > monthDays
    : Math.ceil(day / 7) === weeks[days.week];
}

/** The starts at `from` or later and before `to`, soonest first, each once: a day the zone's calendar skips reads as the next day's start. */
function* startsBetween(
  recurrence: Recurrence,
  from: number,
  to: number
): Generator<number> {
  const { days, time, timeZone } = recurrence;
  // From the zone's date a day before `from` to a day after `to`: any offset fits inside.
  const first = Date.parse(wallTime(from - dayMs, timeZone).slice(0, 10));
  const last = Date.parse(wallTime(to + dayMs, timeZone).slice(0, 10));
  let previous = Number.NEGATIVE_INFINITY;
  for (let date = first; date <= last; date += dayMs) {
    if (!fallsOn(days, date)) {
      continue;
    }
    const day = new Date(date).toISOString().slice(0, 10);
    const startsAt = fromWallTime(`${day}T${time}`, timeZone);
    if (
      startsAt !== undefined &&
      startsAt >= from &&
      startsAt < to &&
      startsAt > previous
    ) {
      previous = startsAt;
      yield startsAt;
    }
  }
}

/** Every occurrence starting at `from` or later and before `to`, soonest first. */
export function occurrencesBetween(
  recurrence: Recurrence,
  from: number,
  to: number
): OccurrenceTimes[] {
  return Array.from(startsBetween(recurrence, from, to), (startsAt) => ({
    endsAt: startsAt + recurrence.minutes * minuteMs,
    startsAt,
  }));
}

/** When the first occurrence starting at `from` or later starts. */
export function nextOccurrenceStart(
  recurrence: Recurrence,
  from: number
): number {
  // Every recurrence falls within two months; the search stops at the first start.
  const { value } = startsBetween(recurrence, from, from + 62 * dayMs).next();
  if (value === undefined) {
    throw new Error("a recurrence that never falls");
  }
  return value;
}

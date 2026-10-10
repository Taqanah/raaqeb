/**
 * Dates in the Umm al-Qura calendar for the fields an operator types a date
 * into when their calendar is Hijri. Intl writes a Hijri date but
 * reads none, so a Hijri date becomes Gregorian by searching the days around
 * an estimate for the one Intl writes as that date. A field still holds
 * `datetime-local` text, Gregorian and in the operator's zone, so what the
 * form sends does not change with the calendar.
 */
import type { Locale } from "./locale.ts";

/** A date in the Umm al-Qura calendar; the month counts from 1, Muharram. */
export interface HijriDate {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

const dayMs = 86_400_000;
// 1 Muharram 1448 is 16 June 2026, and a lunar month lasts 29.530589 days on average.
const anchor = Date.UTC(2026, 5, 16);
const meanMonthDays = 29.530_589;
const umalqura = "-u-nu-latn-ca-islamic-umalqura";

// One formatter: building one costs what formatting a hundred dates does.
const numeric = new Intl.DateTimeFormat(`en${umalqura}`, {
  day: "numeric",
  month: "numeric",
  timeZone: "UTC",
  year: "numeric",
});

/** The Umm al-Qura date of a UTC day. */
function hijriDay(dayStart: number): HijriDate {
  const parts = numeric.formatToParts(dayStart);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((each) => each.type === type)?.value);
  return { day: part("day"), month: part("month"), year: part("year") };
}

/** The Umm al-Qura date of `datetime-local` text, or of a date alone: `2026-02-18` is 1 Ramadan 1447. */
export function hijriDateOf(wallTime: string): HijriDate {
  return hijriDay(Date.parse(wallTime.slice(0, 10)));
}

/** The Gregorian date, `yyyy-mm-dd`, of an Umm al-Qura date; nothing for a day its month does not have. */
export function gregorianDateOf(date: HijriDate): string | undefined {
  const months = (date.year - 1448) * 12 + date.month - 1;
  const estimate =
    anchor + (Math.round(months * meanMonthDays) + date.day - 1) * dayMs;
  // A month starts within a day or two of the mean; a day the month lacks matches none of the seven.
  for (let offset = -3; offset <= 3; offset += 1) {
    const day = estimate + offset * dayMs;
    const found = hijriDay(day);
    if (
      found.day === date.day &&
      found.month === date.month &&
      found.year === date.year
    ) {
      return new Date(day).toISOString().slice(0, 10);
    }
  }
}

/** How many days an Umm al-Qura month has: 29 or 30, as Intl counts them. */
export function hijriMonthDays(year: number, month: number): number {
  return gregorianDateOf({ day: 30, month, year }) ? 30 : 29;
}

const monthNames = new Map<Locale, readonly string[]>();

/** The twelve month names in the locale, Muharram first, from Intl. */
export function hijriMonthNames(locale: Locale): readonly string[] {
  let names = monthNames.get(locale);
  if (!names) {
    const format = new Intl.DateTimeFormat(`${locale}${umalqura}`, {
      month: "long",
      timeZone: "UTC",
    });
    // The middle of each month of 1448, safely inside it.
    names = Array.from({ length: 12 }, (_, index) =>
      format.format(anchor + Math.round((index + 0.5) * meanMonthDays) * dayMs)
    );
    monthNames.set(locale, names);
  }
  return names;
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** The `datetime-local` text of a Hijri date and a time on the clock; a day past its month's last reads as the month's last. */
export function hijriWallTime(
  date: HijriDate,
  hour: number,
  minute: number
): string {
  const day = Math.min(date.day, hijriMonthDays(date.year, date.month));
  return `${gregorianDateOf({ ...date, day }) ?? ""}T${twoDigits(hour)}:${twoDigits(minute)}`;
}

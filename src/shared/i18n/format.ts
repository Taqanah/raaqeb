/**
 * Formatting for every screen and message: Western digits in every
 * locale, dates with the short month name in the Gregorian or the Umm
 * al-Qura calendar, a 12- or 24-hour clock, relative time under a
 * day, units and ISO output for machine surfaces. Every form comes from the
 * runtime's Intl objects, never from hand-written text, save one spelling of
 * CLDR's corrected in relative time and the brackets that put a Gregorian
 * date beside a Hijri one; the time zone, the clock, the calendar and `now`
 * are parameters, so nothing here reads a setting or the wall clock.
 */
import type { Calendar, Clock } from "@/shared/schemas/clock.ts";
import type { Locale } from "./locale.ts";

export interface TimeOptions {
  /** The calendar a date is written in; a time alone reads the same in each. */
  readonly calendar: Calendar;
  readonly clock: Clock;
  /** An IANA zone name such as `Asia/Riyadh`. */
  readonly timeZone: string;
}

/** The units a screen shows; each maps to an Intl sanctioned unit identifier. */
export type Unit =
  | "millisecond"
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "byte"
  | "kilobyte"
  | "megabyte"
  | "gigabyte";

/** A day in milliseconds: the boundary between relative and absolute time. */
export const dayMs = 86_400_000;
const minuteMs = 60_000;
const hourMs = 3_600_000;

// Arabic-Indic digits start at U+0660, extended Arabic-Indic at U+06F0.
const easternDigits = /[٠-٩۰-۹]/g;

/** The Intl locale tag for a locale: Latin digits and the Gregorian calendar forced. */
export function intlLocale(locale: Locale): string {
  return `${locale}-u-nu-latn-ca-gregory`;
}

/** Replaces Arabic-Indic (٠ to ٩) and extended Arabic-Indic (۰ to ۹) digits with 0 to 9. */
export function normalizeDigits(text: string): string {
  return text.replace(easternDigits, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    return String(code >= 0x6_f0 ? code - 0x6_f0 : code - 0x6_60);
  });
}

/** A number with the locale's grouping and Western digits: `1,234.5`. */
export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

/** A ratio as a percentage with up to two decimals: 0.9998 is `99.98%`. */
export function formatPercent(locale: Locale, ratio: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 2,
    style: "percent",
  }).format(ratio);
}

function clockParts(clock: Clock): Intl.DateTimeFormatOptions {
  return clock === "12h"
    ? { hour: "numeric", hourCycle: "h12", minute: "2-digit" }
    : { hour: "2-digit", hourCycle: "h23", minute: "2-digit" };
}

/** The Intl locale tag a calendar's dates are written with: Latin digits, and Umm al-Qura for either Hijri choice. */
function calendarLocale(locale: Locale, calendar: Calendar): string {
  return calendar === "gregorian"
    ? intlLocale(locale)
    : `${locale}-u-nu-latn-ca-islamic-umalqura`;
}

/** The 12-hour clock's two halves of the day in the locale, from Intl: `ص` and `م`, `AM` and `PM`. */
export function dayPeriods(locale: Locale): readonly [string, string] {
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "numeric",
    hourCycle: "h12",
    timeZone: "UTC",
  });
  const period = (hour: number) =>
    format
      .formatToParts(Date.UTC(2026, 0, 1, hour))
      .find((part) => part.type === "dayPeriod")?.value ?? "";
  return [period(0), period(12)];
}

/** The parts that write a date, as against its time. */
const dateParts: ReadonlySet<string> = new Set([
  "day",
  "era",
  "month",
  "weekday",
  "year",
]);

/**
 * Formats an instant, or a span, in the calendar. Hijri with Gregorian puts
 * the Gregorian date in brackets right after each Hijri date, before its
 * time: `29 ربيع الأول 1448 هـ (11 سبتمبر 2026)، 9:49 ص`; a span whose ends
 * share the day names it once.
 */
function calendarFormat(
  locale: Locale,
  calendar: Calendar,
  options: Intl.DateTimeFormatOptions
): (from: number, to?: number) => string {
  const format = new Intl.DateTimeFormat(
    calendarLocale(locale, calendar),
    options
  );
  if (calendar !== "hijri_gregorian") {
    return (from, to) =>
      to === undefined ? format.format(from) : format.formatRange(from, to);
  }
  // The Gregorian date beside takes the Hijri date's own fields, so a form without the year has none beside it either.
  const gregorian = new Intl.DateTimeFormat(intlLocale(locale), {
    day: options.day,
    month: options.month,
    timeZone: options.timeZone,
    year: options.year,
  });
  return (from, to = from) => {
    // An instant's parts all belong to the one date, as a span's shared ones do.
    const parts: readonly Intl.DateTimeRangeFormatPart[] =
      to === from
        ? format
            .formatToParts(from)
            .map((part) => ({ ...part, source: "shared" }))
        : format.formatRangeToParts(from, to);
    // Where each end's date ends: the start's, the end's, or the one both ends share.
    const lastDatePart = new Map<string, number>();
    for (const [index, part] of parts.entries()) {
      if (dateParts.has(part.type)) {
        lastDatePart.set(part.source, index);
      }
    }
    return parts
      .map((part, index) =>
        lastDatePart.get(part.source) === index
          ? `${part.value} (${gregorian.format(part.source === "endRange" ? to : from)})`
          : part.value
      )
      .join("");
  };
}

/** The screen form: `11 سبتمبر 2026، 9:49 ص`, in the calendar. */
export function formatDateTime(
  locale: Locale,
  ms: number,
  options: TimeOptions
): string {
  return calendarFormat(locale, options.calendar, {
    day: "numeric",
    month: "short",
    timeZone: options.timeZone,
    year: "numeric",
    ...clockParts(options.clock),
  })(ms);
}

// One formatter a locale and calendar: a page of bars formats a thousand days, and building one costs what formatting a hundred does.
const dayFormats = new Map<string, (dayStart: number) => string>();

/** A UTC day as a date in the calendar: `11 سبتمبر 2026`, `Sep 11, 2026`, `29 ربيع الأول 1448 هـ` (a day bar cell). */
export function formatDay(
  locale: Locale,
  dayStart: number,
  calendar: Calendar
): string {
  const key = `${locale} ${calendar}`;
  let format = dayFormats.get(key);
  if (!format) {
    format = calendarFormat(locale, calendar, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
      year: "numeric",
    });
    dayFormats.set(key, format);
  }
  return format(dayStart);
}

/**
 * A UTC month, `yyyy-mm`, by name: `سبتمبر 2026`, `September 2026` (a
 * history view's month). The month stays Gregorian, so in Hijri it names the
 * Hijri months it spans: `ربيع الأول – ربيع الآخر 1448 هـ`, with the
 * Gregorian month in brackets after them for Hijri with Gregorian.
 */
export function formatMonth(
  locale: Locale,
  month: string,
  calendar: Calendar
): string {
  const [year = 0, number = 1] = month.split("-").map(Number);
  const first = Date.UTC(year, number - 1, 1);
  const options: Intl.DateTimeFormatOptions = {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  };
  const gregorian = new Intl.DateTimeFormat(intlLocale(locale), options).format(
    first
  );
  if (calendar === "gregorian") {
    return gregorian;
  }
  // Day zero of the next month is this month's last day.
  const hijri = new Intl.DateTimeFormat(
    calendarLocale(locale, calendar),
    options
  ).formatRange(first, Date.UTC(year, number, 0));
  return calendar === "hijri" ? hijri : `${hijri} (${gregorian})`;
}

/** A UTC day by its day and month alone, in the calendar: `1 يناير`, `12 رجب`, `12 رجب (1 يناير)` (a calendar choice's sample). */
export function formatDayAndMonth(
  locale: Locale,
  dayStart: number,
  calendar: Calendar
): string {
  return calendarFormat(locale, calendar, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })(dayStart);
}

/** So many days ago in the locale's words, today for none: `قبل 90 يومًا`, `today`. */
export function formatDaysAgo(locale: Locale, days: number): string {
  return new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  }).format(-days, "day");
}

/** The zone label of an instant in a zone: `غرينتش+3`, `GMT+3`. */
export function zoneLabel(
  locale: Locale,
  ms: number,
  timeZone: string
): string {
  return (
    new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(ms)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone
  );
}

/** The screen form with the zone label appended, for chat and email. */
export function formatDateTimeWithZone(
  locale: Locale,
  ms: number,
  options: TimeOptions
): string {
  return `${formatDateTime(locale, ms, options)} (${zoneLabel(locale, ms, options.timeZone)})`;
}

/** A chart's time label: a minute (`2:10 م`, `14:10`), an hour on the clock format (`4 م`, `16:00`), or a day (`2 أكتوبر`, `21 ربيع الآخر`); an axis has no room for a second calendar, so Hijri with Gregorian writes the Hijri day alone. */
export function formatChartTick(
  locale: Locale,
  ms: number,
  unit: "day" | "hour" | "minute",
  options: TimeOptions
): string {
  const parts: Record<typeof unit, Intl.DateTimeFormatOptions> = {
    day: { day: "numeric", month: "short" },
    // A whole hour in 12-hour time drops its minutes; in 24-hour time they keep "16:00" from reading as a count.
    hour:
      options.clock === "12h"
        ? { hour: "numeric", hourCycle: "h12" }
        : clockParts(options.clock),
    minute: clockParts(options.clock),
  };
  return new Intl.DateTimeFormat(calendarLocale(locale, options.calendar), {
    timeZone: options.timeZone,
    ...parts[unit],
  }).format(ms);
}

/** A span of time with the zone label, the day once when both ends share it: `2 أكتوبر، 2:08–2:13 م (غرينتش+3)`. */
export function formatTimeSpan(
  locale: Locale,
  from: number,
  to: number,
  options: TimeOptions
): string {
  const span = calendarFormat(locale, options.calendar, {
    day: "numeric",
    month: "short",
    timeZone: options.timeZone,
    year: "numeric",
    ...clockParts(options.clock),
  })(from, to);
  return `${span} (${zoneLabel(locale, from, options.timeZone)})`;
}

/** A check's time in a zoomed span's list: the clock to the second (`10:42:15 ص`), with the date before it when the span's ends fall on different days in the zone. */
export function formatSpanTime(
  locale: Locale,
  ms: number,
  span: { readonly from: number; readonly to: number },
  options: TimeOptions
): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone });
  // The span's last instant, so a span that ends at midnight stays on its day.
  const oneDay = day.format(span.from) === day.format(span.to - 1);
  return calendarFormat(locale, options.calendar, {
    ...(oneDay ? {} : { day: "numeric", month: "short", year: "numeric" }),
    timeZone: options.timeZone,
    ...clockParts(options.clock),
    second: "2-digit",
  })(ms);
}

/** The largest unit under a day that fits the distance, with its size in milliseconds. */
function relativeUnit(distance: number): [Intl.RelativeTimeFormatUnit, number] {
  if (distance < minuteMs) {
    return ["second", 1000];
  }
  if (distance < hourMs) {
    return ["minute", minuteMs];
  }
  return ["hour", hourMs];
}

/**
 * Relative wording from Intl.RelativeTimeFormat while the instant is under a
 * day from `now`, in either direction: `قبل دقيقتين`, `in 3 hours`. Nothing
 * once a day has passed; the caller shows the absolute form then.
 */
export function relativeTime(
  locale: Locale,
  ms: number,
  now: number
): string | undefined {
  const delta = ms - now;
  const distance = Math.abs(delta);
  if (distance >= dayMs) {
    return;
  }
  const [unit, size] = relativeUnit(distance);
  // `|| 0` turns a negative zero into zero, so half a second ago is "now", not "0 seconds ago".
  const value = Math.trunc(delta / size) || 0;
  const text = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  }).format(value, unit);
  // CLDR's Arabic past seconds read ثوانِ; its future and the catalog write ثوانٍ.
  return locale === "ar" ? text.replace("ثوانِ", "ثوانٍ") : text;
}

/** Relative under a day, the screen form after. */
export function formatWhen(
  locale: Locale,
  ms: number,
  options: TimeOptions & { readonly now: number }
): string {
  return (
    relativeTime(locale, ms, options.now) ?? formatDateTime(locale, ms, options)
  );
}

/** A value with its unit in the locale's words: `245 ملي ث`, `90 يومًا`, `1.2 kB`. */
export function formatUnit(
  locale: Locale,
  value: number,
  unit: Unit,
  display: "short" | "long" = "short"
): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 1,
    style: "unit",
    unit,
    unitDisplay: display,
  }).format(value);
}

/** A size in bytes in the largest unit under its value, to one decimal: `512 بايت`, `4.2 ميغابايت`, `4.2 MB`, `363 bytes`; a kilobyte is 1024 bytes, as the storage page counts. */
export function formatBytes(locale: Locale, bytes: number): string {
  const [unit, size] = byteUnits.find(([, each]) => bytes >= each) ?? [
    "byte",
    1,
  ];
  // Intl's short English byte has no plural ("363 byte"); its long form has. Arabic's short forms mix words and abbreviations (كيلوبايت, م.ب), so Arabic reads every unit as a word.
  return formatUnit(
    locale,
    bytes / size,
    unit,
    unit === "byte" || locale === "ar" ? "long" : "short"
  );
}

/** The units a size reads in, largest first, a kilobyte being 1024 bytes. */
const byteUnits: readonly (readonly [Unit, number])[] = [
  ["gigabyte", 1024 ** 3],
  ["megabyte", 1024 ** 2],
  ["kilobyte", 1024],
  ["byte", 1],
];

/** A displayed uptime as a percentage with exactly its decimals and no rounding up: `99.94%`, `100%`. */
export function formatUptime(
  locale: Locale,
  uptime: { readonly decimals: number; readonly percent: number }
): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: uptime.decimals,
    minimumFractionDigits: Math.min(2, uptime.decimals),
    style: "percent",
  }).format(uptime.percent / 100);
}

/** The units a duration is shown in, largest first. */
const durationUnits = [
  ["day", dayMs],
  ["hour", hourMs],
  ["minute", minuteMs],
  ["second", 1000],
] as const;

/** A duration in its two largest units, each cut to a whole number: `5 د و42 ث`, `2 days, 12 hr`. */
export function formatDuration(locale: Locale, ms: number): string {
  const start = durationUnits.findIndex(([, length]) => ms >= length);
  const shown = start === -1 ? [] : durationUnits.slice(start, start + 2);
  const parts: Record<string, number> = {};
  // Each unit takes what the one above left, cut, never rounded up: observed time is never shown longer than it was.
  let rest = ms;
  for (const [unit, size] of shown) {
    const whole = Math.trunc(rest / size);
    rest -= whole * size;
    if (whole > 0) {
      parts[`${unit}s`] = whole;
    }
  }
  // Under a second shows as zero seconds, which the format would otherwise leave empty.
  const empty = Object.keys(parts).length === 0;
  return new Intl.DurationFormat(intlLocale(locale), {
    secondsDisplay: empty ? "always" : "auto",
    style: "short",
  }).format(empty ? { seconds: 0 } : parts);
}

/** ISO 8601 with the zone's offset, for machine surfaces: `2026-09-11T09:49:00+03:00`. */
export function isoTimestamp(ms: number, timeZone: string): string {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of new Intl.DateTimeFormat("en-u-nu-latn-ca-gregory", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
  }).formatToParts(ms)) {
    parts[part.type] = part.value;
  }
  // The long offset reads `GMT+03:00`; ICU writes zero as `GMT` or `GMT+00:00`, ISO writes `Z`.
  const offset = (parts.timeZoneName ?? "GMT").slice(3);
  const zone = offset === "" || offset === "+00:00" ? "Z" : offset;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${zone}`;
}

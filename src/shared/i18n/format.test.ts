import { describe, expect, test } from "bun:test";
import {
  dayMs,
  dayPeriods,
  formatBytes,
  formatChartTick,
  formatDateTime,
  formatDateTimeWithZone,
  formatDay,
  formatDayAndMonth,
  formatDaysAgo,
  formatDuration,
  formatMonth,
  formatNumber,
  formatPercent,
  formatSpanTime,
  formatTimeSpan,
  formatUnit,
  formatUptime,
  formatWhen,
  intlLocale,
  isoTimestamp,
  normalizeDigits,
  relativeTime,
  zoneLabel,
} from "./format.ts";

// 2026-09-11 06:49:00 UTC, which is 9:49 in Riyadh (UTC+3).
const instant = Date.parse("2026-09-11T06:49:00Z");
const riyadh = {
  calendar: "gregorian",
  clock: "12h",
  timeZone: "Asia/Riyadh",
} as const;

describe("digits", () => {
  test("the Intl tag forces Latin digits and the Gregorian calendar", () => {
    expect(intlLocale("ar")).toBe("ar-u-nu-latn-ca-gregory");
    expect(intlLocale("en")).toBe("en-u-nu-latn-ca-gregory");
  });

  test("Arabic-Indic and extended Arabic-Indic digits normalize to 0 to 9, mixed in one field too", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizeDigits("example.com:٨٠٨٠")).toBe("example.com:8080");
    expect(normalizeDigits("١٢۳۴")).toBe("1234");
  });

  test("text without Eastern digits is unchanged", () => {
    expect(normalizeDigits("https://راقب.example/٪")).toBe(
      "https://راقب.example/٪"
    );
    expect(normalizeDigits("")).toBe("");
  });
});

describe("numbers", () => {
  test("a number groups with a comma and a dot in both locales", () => {
    expect(formatNumber("ar", 1234.5)).toBe("1,234.5");
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
  });

  test("a ratio is a percentage with up to two decimals and an ASCII sign", () => {
    expect(formatPercent("en", 0.9998)).toBe("99.98%");
    expect(formatPercent("en", 1)).toBe("100%");
    expect(formatPercent("en", 0.999_99)).toBe("100%");
    // ICU wraps the sign in left-to-right marks in Arabic; the visible text is the same.
    expect(formatPercent("ar", 0.9998).replaceAll("‎", "")).toBe("99.98%");
  });
});

describe("dates on a screen", () => {
  test("the short month name, then the clock with ص and م in Arabic", () => {
    expect(formatDateTime("ar", instant, riyadh)).toBe(
      "11 سبتمبر 2026، 9:49 ص"
    );
  });

  test("the same instant in English", () => {
    expect(formatDateTime("en", instant, riyadh)).toBe("Sep 11, 2026, 9:49 AM");
  });

  test("the 24-hour option pads the hour and drops the period", () => {
    expect(formatDateTime("ar", instant, { ...riyadh, clock: "24h" })).toBe(
      "11 سبتمبر 2026، 09:49"
    );
    expect(formatDateTime("en", instant, { ...riyadh, clock: "24h" })).toBe(
      "Sep 11, 2026, 09:49"
    );
  });

  test("the afternoon is م in Arabic and PM in English", () => {
    const afternoon = Date.parse("2026-09-11T13:05:00Z");
    expect(formatDateTime("ar", afternoon, riyadh)).toBe(
      "11 سبتمبر 2026، 4:05 م"
    );
    expect(formatDateTime("en", afternoon, riyadh)).toBe(
      "Sep 11, 2026, 4:05 PM"
    );
  });

  test("the zone changes the rendered hour, never the instant", () => {
    expect(
      formatDateTime("en", instant, {
        calendar: "gregorian",
        clock: "24h",
        timeZone: "UTC",
      })
    ).toBe("Sep 11, 2026, 06:49");
    expect(
      formatDateTime("en", instant, {
        calendar: "gregorian",
        clock: "24h",
        timeZone: "America/New_York",
      })
    ).toBe("Sep 11, 2026, 02:49");
  });

  test("a date near midnight belongs to the zone's day", () => {
    const lateUtc = Date.parse("2026-09-11T22:30:00Z");
    expect(
      formatDateTime("en", lateUtc, {
        calendar: "gregorian",
        clock: "24h",
        timeZone: "Asia/Riyadh",
      })
    ).toBe("Sep 12, 2026, 01:30");
  });
});

describe("the zone label", () => {
  test("names the offset in the locale's words", () => {
    expect(zoneLabel("ar", instant, "Asia/Riyadh")).toBe("غرينتش+3");
    expect(zoneLabel("en", instant, "Asia/Riyadh")).toBe("GMT+3");
    expect(zoneLabel("en", instant, "UTC")).toBe("UTC");
    expect(zoneLabel("en", instant, "America/New_York")).toBe("EDT");
  });

  test("chat and email get the screen form with the label appended", () => {
    expect(formatDateTimeWithZone("ar", instant, riyadh)).toBe(
      "11 سبتمبر 2026، 9:49 ص (غرينتش+3)"
    );
    expect(formatDateTimeWithZone("en", instant, riyadh)).toBe(
      "Sep 11, 2026, 9:49 AM (GMT+3)"
    );
  });
});

describe("the 12-hour clock's halves of the day", () => {
  test("are the locale's words, morning first", () => {
    expect(dayPeriods("ar")).toEqual(["ص", "م"]);
    expect(dayPeriods("en")).toEqual(["AM", "PM"]);
  });
});

describe("relative time", () => {
  const minute = 60_000;
  const hour = 60 * minute;

  test("the past under a day is worded by Intl, dual and plural forms included", () => {
    expect(relativeTime("ar", instant - 2 * minute, instant)).toBe(
      "قبل دقيقتين"
    );
    expect(relativeTime("ar", instant - 3 * minute, instant)).toBe(
      "قبل 3 دقائق"
    );
    expect(relativeTime("ar", instant - 11 * minute, instant)).toBe(
      "قبل 11 دقيقة"
    );
    expect(relativeTime("ar", instant - 1 * hour, instant)).toBe(
      "قبل ساعة واحدة"
    );
    expect(relativeTime("en", instant - 2 * minute, instant)).toBe(
      "2 minutes ago"
    );
    expect(relativeTime("en", instant - 5 * hour, instant)).toBe("5 hours ago");
  });

  test("under a minute counts seconds, and the same instant is now", () => {
    expect(relativeTime("en", instant - 30_000, instant)).toBe(
      "30 seconds ago"
    );
    expect(relativeTime("ar", instant - 30_000, instant)).toBe("قبل 30 ثانية");
    expect(relativeTime("en", instant, instant)).toBe("now");
    expect(relativeTime("ar", instant, instant)).toBe("الآن");
  });

  test("a few seconds ago in Arabic are ثوانٍ with the tanween, as the future already is", () => {
    for (const seconds of [3, 5, 10]) {
      expect(relativeTime("ar", instant - seconds * 1000, instant)).toBe(
        `قبل ${seconds} ثوانٍ`
      );
      expect(relativeTime("ar", instant + seconds * 1000, instant)).toBe(
        `خلال ${seconds} ثوانٍ`
      );
    }
  });

  test("the future under a day reads forward", () => {
    expect(relativeTime("en", instant + 3 * hour, instant)).toBe("in 3 hours");
    expect(relativeTime("ar", instant + 3 * hour, instant)).toBe(
      "خلال 3 ساعات"
    );
  });

  test("a whole unit is not rounded up: 119 seconds is 1 minute, 23.9 hours is 23 hours", () => {
    expect(relativeTime("en", instant - 119_000, instant)).toBe("1 minute ago");
    expect(relativeTime("en", instant - (dayMs - minute), instant)).toBe(
      "23 hours ago"
    );
  });

  test("fifty-nine minutes and a half is still minutes", () => {
    expect(relativeTime("en", instant - 59.5 * minute, instant)).toBe(
      "59 minutes ago"
    );
    expect(relativeTime("en", instant - 59_900, instant)).toBe(
      "59 seconds ago"
    );
  });

  test("half a second either way is now, never zero seconds", () => {
    expect(relativeTime("en", instant - 500, instant)).toBe("now");
    expect(relativeTime("en", instant + 500, instant)).toBe("now");
  });

  test("a day or more is not relative", () => {
    expect(relativeTime("en", instant - dayMs, instant)).toBe(undefined);
    expect(relativeTime("en", instant + dayMs, instant)).toBe(undefined);
    expect(relativeTime("ar", instant - 40 * dayMs, instant)).toBe(undefined);
  });

  test("a time is relative under a day either way, and the screen form after", () => {
    expect(
      formatWhen("ar", instant - 2 * minute, { ...riyadh, now: instant })
    ).toBe("قبل دقيقتين");
    expect(
      formatWhen("en", instant + 2 * hour, { ...riyadh, now: instant })
    ).toBe("in 2 hours");
    expect(
      formatWhen("ar", instant, { ...riyadh, now: instant + 2 * dayMs })
    ).toBe("11 سبتمبر 2026، 9:49 ص");
  });
});

describe("units", () => {
  test("the verified Arabic forms of the units", () => {
    expect(formatUnit("ar", 245, "millisecond")).toBe("245 ملي ث");
    expect(formatUnit("ar", 30, "second")).toBe("30 ث");
    expect(formatUnit("ar", 1.2, "kilobyte")).toBe("1.2 كيلوبايت");
    expect(formatUnit("ar", 90, "day", "long")).toBe("90 يومًا");
  });

  test("the English forms", () => {
    expect(formatUnit("en", 245, "millisecond")).toBe("245 ms");
    expect(formatUnit("en", 30, "second")).toBe("30 sec");
    expect(formatUnit("en", 1.2, "kilobyte")).toBe("1.2 kB");
    expect(formatUnit("en", 90, "day", "long")).toBe("90 days");
  });

  test("the long Arabic day form follows the count", () => {
    expect(formatUnit("ar", 1, "day", "long")).toBe("يوم");
    expect(formatUnit("ar", 2, "day", "long")).toBe("يومان");
  });

  test("a fraction keeps at most one decimal", () => {
    expect(formatUnit("en", 1.234, "megabyte")).toBe("1.2 MB");
    expect(formatUnit("en", 1234.5, "millisecond")).toBe("1,234.5 ms");
  });
});

describe("uptime", () => {
  test("shows exactly its decimals, trailing zeros trimmed down to two, and never rounds up", () => {
    expect(formatUptime("en", { decimals: 2, percent: 99.98 })).toBe("99.98%");
    expect(formatUptime("en", { decimals: 3, percent: 99.996 })).toBe(
      "99.996%"
    );
    expect(formatUptime("en", { decimals: 5, percent: 99.9999 })).toBe(
      "99.9999%"
    );
    expect(formatUptime("en", { decimals: 5, percent: 99.999_99 })).toBe(
      "99.99999%"
    );
    expect(formatUptime("en", { decimals: 2, percent: 0 })).toBe("0.00%");
  });

  test("100% has no decimals", () => {
    expect(formatUptime("en", { decimals: 0, percent: 100 })).toBe("100%");
  });

  test("Arabic keeps Western digits", () => {
    expect(formatUptime("ar", { decimals: 2, percent: 99.98 })).toBe(
      "99.98\u200e%\u200e"
    );
  });
});

describe("durations", () => {
  test("show the two largest units, cut rather than rounded, never a decimal", () => {
    expect(formatDuration("en", 2.5 * dayMs)).toBe("2 days, 12 hr");
    expect(formatDuration("en", 3 * 3_600_000 + 59_000)).toBe("3 hr");
    expect(formatDuration("en", 45 * 60_000)).toBe("45 min");
    expect(formatDuration("en", 5 * 60_000 + 42_900)).toBe("5 min, 42 sec");
    expect(formatDuration("en", 12_345)).toBe("12 sec");
    expect(formatDuration("en", 1.99 * dayMs)).toBe("1 day, 23 hr");
    expect(formatDuration("en", 400)).toBe("0 sec");
    expect(formatDuration("en", 0)).toBe("0 sec");
  });

  test("Arabic forms", () => {
    expect(formatDuration("ar", 2.5 * dayMs)).toBe("يومان و12 س");
    expect(formatDuration("ar", 45 * 60_000)).toBe("45 د");
    expect(formatDuration("ar", 5 * 60_000 + 42_000)).toBe("5 د و42 ث");
  });
});

describe("machine timestamps", () => {
  test("ISO 8601 with the zone's offset, to the second", () => {
    expect(isoTimestamp(instant, "Asia/Riyadh")).toBe(
      "2026-09-11T09:49:00+03:00"
    );
    expect(isoTimestamp(instant, "UTC")).toBe("2026-09-11T06:49:00Z");
    expect(isoTimestamp(instant, "America/New_York")).toBe(
      "2026-09-11T02:49:00-04:00"
    );
  });

  test("a half-hour offset is written in full", () => {
    expect(isoTimestamp(instant, "Asia/Kolkata")).toBe(
      "2026-09-11T12:19:00+05:30"
    );
  });

  test("a negative half-hour offset keeps its minutes", () => {
    expect(isoTimestamp(instant, "America/St_Johns")).toBe(
      "2026-09-11T04:19:00-02:30"
    );
  });

  test("a zone at zero offset that is not UTC still writes Z", () => {
    expect(
      isoTimestamp(Date.parse("2026-01-15T12:00:00Z"), "Europe/London")
    ).toBe("2026-01-15T12:00:00Z");
  });

  test("the offset follows daylight time on the instant, not today", () => {
    const winter = Date.parse("2026-01-15T12:00:00Z");
    expect(isoTimestamp(winter, "America/New_York")).toBe(
      "2026-01-15T07:00:00-05:00"
    );
  });
});

describe("a day bar's dates", () => {
  test("a UTC day as a date in the locale's words and Western digits", () => {
    const day = Date.UTC(2026, 8, 11);
    expect(formatDay("ar", day, "gregorian")).toBe("11 سبتمبر 2026");
    expect(formatDay("en", day, "gregorian")).toBe("Sep 11, 2026");
  });

  test("a UTC day stays itself whatever the runtime's zone, since the day is UTC", () => {
    expect(formatDay("en", Date.UTC(2026, 8, 11, 23, 59), "gregorian")).toBe(
      "Sep 11, 2026"
    );
  });

  test("so many days ago, and today for none", () => {
    expect(formatDaysAgo("ar", 90)).toBe("قبل 90 يومًا");
    expect(formatDaysAgo("en", 90)).toBe("90 days ago");
    expect(formatDaysAgo("ar", 0)).toBe("اليوم");
    expect(formatDaysAgo("en", 0)).toBe("today");
  });
});

describe("a history's month by name", () => {
  test("the month's name and its year, in the locale, with Latin digits", () => {
    expect(formatMonth("ar", "2026-09", "gregorian")).toBe("سبتمبر 2026");
    expect(formatMonth("en", "2026-01", "gregorian")).toBe("January 2026");
  });

  test("a UTC month, whatever the machine's zone", () => {
    expect(formatMonth("en", "2026-12", "gregorian")).toBe("December 2026");
  });
});

describe("a chart's time labels", () => {
  // 2026-10-02 12:00 UTC, 3 PM in Riyadh.
  const three = Date.parse("2026-10-02T12:00:00Z");

  test("a minute and an hour read on the clock format, a day by its month", () => {
    expect(formatChartTick("ar", three, "hour", riyadh)).toBe("3 م");
    expect(formatChartTick("en", three, "hour", riyadh)).toBe("3 PM");
    expect(
      formatChartTick("ar", three, "hour", { ...riyadh, clock: "24h" })
    ).toBe("15:00");
    expect(formatChartTick("ar", three, "day", riyadh)).toBe("2 أكتوبر");
    expect(formatChartTick("en", three, "day", riyadh)).toBe("Oct 2");
    const tenPast = three + 600_000;
    expect(formatChartTick("ar", tenPast, "minute", riyadh)).toBe("3:10 م");
    expect(formatChartTick("en", tenPast, "minute", riyadh)).toBe("3:10 PM");
    expect(
      formatChartTick("ar", tenPast, "minute", { ...riyadh, clock: "24h" })
    ).toBe("15:10");
  });

  test("a span names its day once when both ends share it, and carries the zone label", () => {
    const start = Date.parse("2026-10-02T11:08:00Z");
    expect(formatTimeSpan("ar", start, start + 300_000, riyadh)).toBe(
      "2 أكتوبر 2026، 2:08–2:13 م (غرينتش+3)"
    );
    expect(formatTimeSpan("en", start, start + 300_000, riyadh)).toBe(
      "Oct 2, 2026, 2:08 – 2:13 PM (GMT+3)"
    );
    expect(formatTimeSpan("en", start, start + dayMs, riyadh)).toBe(
      "Oct 2, 2026, 2:08 PM – Oct 3, 2026, 2:08 PM (GMT+3)"
    );
  });
});

describe("a size in bytes", () => {
  test("reads in the largest unit under its value, to one decimal, a kilobyte being 1024 bytes", () => {
    expect(formatBytes("ar", 512)).toBe("512 بايت");
    expect(formatBytes("en", 4.2 * 1024)).toBe("4.2 kB");
    expect(formatBytes("ar", 4.2 * 1024 * 1024)).toBe("4.2 م.ب");
    expect(formatBytes("en", 1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  test("spells out the byte in English with its plural, and reads the same in Arabic", () => {
    expect(formatBytes("en", 0)).toBe("0 bytes");
    expect(formatBytes("en", 1)).toBe("1 byte");
    expect(formatBytes("en", 363)).toBe("363 bytes");
    expect(formatBytes("ar", 363)).toBe("363 بايت");
  });
});

describe("the calendar dates are written in", () => {
  const hijri = { ...riyadh, calendar: "hijri" } as const;
  const both = { ...riyadh, calendar: "hijri_gregorian" } as const;
  const day = Date.UTC(2026, 8, 11);

  test("Hijri writes the Umm al-Qura date with the era, in both locales", () => {
    expect(formatDateTime("ar", instant, hijri)).toBe(
      "29 ربيع الأول 1448 هـ، 9:49 ص"
    );
    expect(formatDateTime("en", instant, hijri)).toBe(
      "Rab. I 29, 1448 AH, 9:49 AM"
    );
    expect(formatDay("ar", day, "hijri")).toBe("29 ربيع الأول 1448 هـ");
    expect(formatDay("en", day, "hijri")).toBe("Rab. I 29, 1448 AH");
  });

  test("Hijri with Gregorian writes the Gregorian date beside the Hijri one, before the time and the zone", () => {
    expect(formatDateTime("ar", instant, both)).toBe(
      "29 ربيع الأول 1448 هـ (11 سبتمبر 2026)، 9:49 ص"
    );
    expect(formatDateTime("en", instant, both)).toBe(
      "Rab. I 29, 1448 AH (Sep 11, 2026), 9:49 AM"
    );
    expect(formatDateTimeWithZone("ar", instant, both)).toBe(
      "29 ربيع الأول 1448 هـ (11 سبتمبر 2026)، 9:49 ص (غرينتش+3)"
    );
    expect(formatDay("ar", day, "hijri_gregorian")).toBe(
      "29 ربيع الأول 1448 هـ (11 سبتمبر 2026)"
    );
    expect(formatDay("en", day, "hijri_gregorian")).toBe(
      "Rab. I 29, 1448 AH (Sep 11, 2026)"
    );
  });

  test("the date is the zone's day in every calendar", () => {
    // 22:30 UTC on 11 September is already the 12th, 1 Rabi' II, in Riyadh.
    const lateUtc = Date.parse("2026-09-11T22:30:00Z");
    expect(formatDateTime("en", lateUtc, both)).toBe(
      "Rab. II 1, 1448 AH (Sep 12, 2026), 1:30 AM"
    );
  });

  test("a time span names the day once when both ends share it, and each end's day when they do not", () => {
    expect(formatTimeSpan("ar", instant, instant + 300_000, both)).toBe(
      "29 ربيع الأول 1448 هـ (11 سبتمبر 2026)، 9:49–9:54 ص (غرينتش+3)"
    );
    expect(formatTimeSpan("en", instant, instant + dayMs, both)).toBe(
      "Rab. I 29, 1448 AH (Sep 11, 2026), 9:49 AM – Rab. II 1, 1448 AH (Sep 12, 2026), 9:49 AM (GMT+3)"
    );
    expect(formatTimeSpan("en", instant, instant + 300_000, hijri)).toBe(
      "Rab. I 29, 1448 AH, 9:49 – 9:54 AM (GMT+3)"
    );
  });

  test("past a day, the absolute form is the calendar's", () => {
    expect(
      formatWhen("en", instant, { ...hijri, now: instant + 2 * dayMs })
    ).toBe("Rab. I 29, 1448 AH, 9:49 AM");
  });

  test("a history's Gregorian month names the Hijri months it spans, with the Gregorian month beside them", () => {
    expect(formatMonth("ar", "2026-09", "hijri")).toBe(
      "ربيع الأول – ربيع الآخر 1448 هـ"
    );
    expect(formatMonth("en", "2026-09", "hijri")).toBe(
      "Rabiʻ I – Rabiʻ II 1448 AH"
    );
    expect(formatMonth("ar", "2026-09", "hijri_gregorian")).toBe(
      "ربيع الأول – ربيع الآخر 1448 هـ (سبتمبر 2026)"
    );
  });

  test("a chart's day tick is the Hijri day alone, a minute tick the same in every calendar", () => {
    const three = Date.parse("2026-10-02T12:00:00Z");
    expect(formatChartTick("ar", three, "day", hijri)).toBe("21 ربيع الآخر");
    expect(formatChartTick("en", three, "day", both)).toBe("Rab. II 21");
    expect(formatChartTick("ar", three, "minute", both)).toBe(
      formatChartTick("ar", three, "minute", riyadh)
    );
  });

  test("a calendar choice's sample names the day and the month without the year, the Gregorian beside the Hijri for both", () => {
    const newYear = Date.UTC(2026, 0, 1);
    expect(formatDayAndMonth("ar", newYear, "gregorian")).toBe("1 يناير");
    expect(formatDayAndMonth("ar", newYear, "hijri")).toBe("12 رجب");
    expect(formatDayAndMonth("ar", newYear, "hijri_gregorian")).toBe(
      "12 رجب (1 يناير)"
    );
    expect(formatDayAndMonth("en", newYear, "gregorian")).toBe("Jan 1");
    expect(formatDayAndMonth("en", newYear, "hijri_gregorian")).toBe(
      "Raj. 12 (Jan 1)"
    );
  });
});

describe("a check's time in a zoomed list", () => {
  // 07:42:15 UTC, 10:42:15 in Riyadh.
  const at = Date.parse("2026-09-11T07:42:15Z");

  test("a span inside one day reads the clock to the second, in the clock format", () => {
    const span = {
      from: Date.parse("2026-09-11T06:00:00Z"),
      to: Date.parse("2026-09-11T09:00:00Z"),
    };
    expect(formatSpanTime("ar", at, span, riyadh)).toBe("10:42:15 ص");
    expect(formatSpanTime("en", at, span, riyadh)).toBe("10:42:15 AM");
    expect(formatSpanTime("ar", at, span, { ...riyadh, clock: "24h" })).toBe(
      "10:42:15"
    );
  });

  test("a span whose ends fall on two days in the zone puts the date before the clock", () => {
    const late = Date.parse("2026-09-11T20:30:00Z");
    const span = {
      from: Date.parse("2026-09-11T20:00:00Z"),
      to: Date.parse("2026-09-11T22:00:00Z"),
    };
    expect(formatSpanTime("ar", late, span, riyadh)).toBe(
      "11 سبتمبر 2026، 11:30:00 م"
    );
    expect(formatSpanTime("en", late, span, riyadh)).toBe(
      "Sep 11, 2026, 11:30:00 PM"
    );
    expect(
      formatSpanTime("ar", late, span, { ...riyadh, calendar: "hijri" })
    ).toContain("هـ");
  });

  test("the zone's days decide, not UTC's: a span over UTC midnight inside one Riyadh day reads the clock alone", () => {
    const span = {
      from: Date.parse("2026-09-11T23:00:00Z"),
      to: Date.parse("2026-09-12T01:00:00Z"),
    };
    expect(
      formatSpanTime("en", Date.parse("2026-09-12T00:10:05Z"), span, riyadh)
    ).toBe("3:10:05 AM");
  });

  test("a span of one whole day, ending at the next midnight, is one day", () => {
    const span = {
      from: Date.parse("2026-09-10T21:00:00Z"),
      to: Date.parse("2026-09-11T21:00:00Z"),
    };
    expect(formatSpanTime("en", at, span, riyadh)).toBe("10:42:15 AM");
  });
});

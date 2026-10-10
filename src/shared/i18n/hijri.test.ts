import { describe, expect, test } from "bun:test";
import {
  gregorianDateOf,
  hijriDateOf,
  hijriMonthDays,
  hijriMonthNames,
  hijriWallTime,
} from "./hijri.ts";

// Pinned against Bun 1.4.2's ICU: Intl writes these days as these Hijri dates.
const ramadan1447 = { day: 1, month: 9, year: 1447 };
const muharram1448 = { day: 1, month: 1, year: 1448 };

describe("a Gregorian date in Umm al-Qura", () => {
  test("18 February 2026 is 1 Ramadan 1447", () => {
    expect(hijriDateOf("2026-02-18")).toEqual(ramadan1447);
  });

  test("16 June 2026 is 1 Muharram 1448", () => {
    expect(hijriDateOf("2026-06-16")).toEqual(muharram1448);
  });

  test("datetime-local text reads by its date alone, whatever its time", () => {
    expect(hijriDateOf("2026-02-18T23:59")).toEqual(ramadan1447);
    expect(hijriDateOf("2026-02-17T00:00")).toEqual({
      day: 29,
      month: 8,
      year: 1447,
    });
  });
});

describe("an Umm al-Qura date in Gregorian", () => {
  test("1 Ramadan 1447 is 18 February 2026", () => {
    expect(gregorianDateOf(ramadan1447)).toBe("2026-02-18");
  });

  test("1 Muharram 1448 is 16 June 2026", () => {
    expect(gregorianDateOf(muharram1448)).toBe("2026-06-16");
  });

  test("the last day of a year runs into the first of the next", () => {
    expect(gregorianDateOf({ day: 29, month: 12, year: 1447 })).toBe(
      "2026-06-15"
    );
  });

  test("a 30th in a 29-day month names no day", () => {
    expect(gregorianDateOf({ day: 30, month: 8, year: 1447 })).toBeUndefined();
    expect(gregorianDateOf({ day: 29, month: 8, year: 1447 })).toBe(
      "2026-02-17"
    );
  });

  test("a day or a month out of the calendar names no day", () => {
    expect(gregorianDateOf({ day: 0, month: 9, year: 1447 })).toBeUndefined();
    expect(gregorianDateOf({ day: 31, month: 9, year: 1447 })).toBeUndefined();
    expect(gregorianDateOf({ day: 1, month: 0, year: 1447 })).toBeUndefined();
    expect(gregorianDateOf({ day: 1, month: 13, year: 1447 })).toBeUndefined();
  });

  test("every day from 2020 to 2040 reads back as itself", () => {
    const dayMs = 86_400_000;
    for (
      let day = Date.UTC(2020, 0, 1);
      day <= Date.UTC(2040, 11, 31);
      day += dayMs
    ) {
      const date = new Date(day).toISOString().slice(0, 10);
      expect(gregorianDateOf(hijriDateOf(date))).toBe(date);
    }
  });
});

describe("the search around the estimate", () => {
  test("finds the first and the last day of every month from 1356 to 1500", () => {
    for (let year = 1356; year <= 1500; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        expect(gregorianDateOf({ day: 1, month, year })).toBeDefined();
        expect(gregorianDateOf({ day: 29, month, year })).toBeDefined();
      }
    }
  });
});

describe("a month's length", () => {
  test("is 29 or 30 days as Intl counts them", () => {
    expect(hijriMonthDays(1447, 8)).toBe(29);
    expect(hijriMonthDays(1447, 9)).toBe(30);
    expect(hijriMonthDays(1447, 12)).toBe(29);
    expect(hijriMonthDays(1448, 1)).toBe(29);
  });
});

describe("the month names", () => {
  test("are twelve, Muharram first, in each locale's words", () => {
    const ar = hijriMonthNames("ar");
    const en = hijriMonthNames("en");
    expect(ar).toHaveLength(12);
    expect(en).toHaveLength(12);
    expect(ar[0]).toBe("محرم");
    expect(ar[8]).toBe("رمضان");
    expect(en[8]).toBe("Ramadan");
  });
});

describe("a Hijri date and a time as datetime-local text", () => {
  test("names the Gregorian minute the field would write", () => {
    expect(hijriWallTime(ramadan1447, 9, 5)).toBe("2026-02-18T09:05");
    expect(hijriWallTime(muharram1448, 23, 59)).toBe("2026-06-16T23:59");
  });

  test("a 30th chosen in a 29-day month reads as the 29th", () => {
    expect(hijriWallTime({ day: 30, month: 8, year: 1447 }, 0, 0)).toBe(
      "2026-02-17T00:00"
    );
  });
});

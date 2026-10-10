import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { formatDay, type TimeOptions } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type { Calendar, Clock } from "@/shared/schemas/clock.ts";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { TimeField, withPart } from "./time-field.tsx";

// 1 Ramadan 1447 at 14:05; Sha'ban 1447 has 29 days and Ramadan 30.
const value = "2026-02-18T14:05";
// 1 February 2026 is 13 Sha'ban 1447.
const now = Date.UTC(2026, 1, 1);
const easternDigits = /[٠-٩۰-۹]/;
const optionValue = /<option[^>]*value="([^"]*)"/g;
const selectedValue = /<option[^>]*value="([^"]*)"[^>]*selected=""/;
// Base UI writes the radio's checked state before its value; the class list names data-checked too.
const pmChecked = /aria-checked="true"[^>]*data-value="pm"/;
const timeLeftToRight = /dir="ltr"[^>]*>.*name="starts-hour"/s;
// Any element set left to right before the month select would turn the date with it.
const monthLeftToRight = /dir="ltr"[^>]*>.*name="starts-month"/s;
const invalid = /aria-invalid="true"/g;

const noop = () => undefined;

function render(
  calendar: Calendar,
  {
    clock = "24h",
    error,
    locale = "ar",
    at = value,
  }: {
    readonly at?: string;
    readonly clock?: Clock;
    readonly error?: string;
    readonly locale?: Locale;
  } = {}
): string {
  const time: TimeOptions = { calendar, clock, timeZone: "Asia/Riyadh" };
  return renderToString(
    <MessagesProvider i18n={createMessages(locale, locale === "ar" ? ar : en)}>
      <TimeField
        clock={time}
        error={error}
        label="Starts"
        name="starts"
        now={now}
        onChange={noop}
        value={at}
      />
    </MessagesProvider>
  );
}

/** The options of the select with the name, and the one selected. */
function select(
  html: string,
  name: string
): { readonly options: readonly string[]; readonly selected?: string } {
  const body = new RegExp(`<select[^>]*name="${name}"[^>]*>(.*?)</select>`, "s")
    .exec(html)
    ?.at(1);
  if (body === undefined) {
    throw new Error(`no select named ${name}`);
  }
  const options = [...body.matchAll(optionValue)].map(
    (match) => match[1] ?? ""
  );
  const selected = selectedValue.exec(body)?.[1];
  return { options, selected };
}

describe("a time field in the Gregorian calendar", () => {
  test("stays the native datetime-local field holding the draft's text", () => {
    const html = render("gregorian");
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain(`value="${value}"`);
    expect(html).not.toContain("<select");
  });
});

describe("a time field in the Hijri calendar", () => {
  test("holds the draft's minute as its Umm al-Qura day, month and year and its hour and minute", () => {
    const html = render("hijri");
    expect(html).not.toContain('type="datetime-local"');
    expect(select(html, "starts-day").selected).toBe("1");
    expect(select(html, "starts-month").selected).toBe("9");
    expect(select(html, "starts-year").selected).toBe("1447");
    expect(select(html, "starts-hour").selected).toBe("14");
    expect(select(html, "starts-minute").selected).toBe("5");
  });

  test("offers the chosen month's days and no more", () => {
    expect(select(render("hijri"), "starts-day").options).toHaveLength(30);
    expect(
      select(render("hijri", { at: "2026-02-17T09:00" }), "starts-day").options
    ).toHaveLength(29);
  });

  test("names the twelve months in the page's words", () => {
    expect(select(render("hijri"), "starts-month").options).toHaveLength(12);
    expect(render("hijri")).toContain("رمضان");
    expect(render("hijri", { locale: "en" })).toContain("Ramadan");
  });

  test("offers the years from the server's year on", () => {
    const { options } = select(render("hijri"), "starts-year");
    expect(options.at(0)).toBe("1447");
    expect(options).toContain("1452");
    // A stored year after the server's still starts the list at the server's year, and runs past the stored one.
    expect(
      select(render("hijri", { at: "2028-06-01T10:00" }), "starts-year").options
    ).toEqual([
      "1447",
      "1448",
      "1449",
      "1450",
      "1451",
      "1452",
      "1453",
      "1454",
      "1455",
    ]);
  });

  test("offers a stored year before the server's", () => {
    const { options, selected } = select(
      render("hijri", { at: "2025-06-20T10:00" }),
      "starts-year"
    );
    expect(selected).toBe("1446");
    expect(options.at(0)).toBe("1446");
  });

  test("writes every number in Western digits", () => {
    expect(render("hijri", { clock: "12h" })).toContain(">1447</option>");
    expect(render("hijri", { clock: "12h" })).not.toMatch(easternDigits);
    expect(render("hijri_gregorian", { clock: "12h" })).not.toMatch(
      easternDigits
    );
  });

  test("on a 24-hour clock offers the hours 00 to 23 and no half of the day", () => {
    const html = render("hijri");
    expect(select(html, "starts-hour").options).toHaveLength(24);
    expect(html).toContain(">00</option>");
    expect(html).toContain(">23</option>");
    expect(html).not.toContain('data-slot="segmented"');
  });

  test("on a 12-hour clock offers the hours 1 to 12 and the half of the day", () => {
    const html = render("hijri", { clock: "12h" });
    const hour = select(html, "starts-hour");
    expect(hour.options).toHaveLength(12);
    expect(hour.selected).toBe("2");
    expect(html).toContain('data-slot="segmented"');
    expect(html).toContain("ص");
    expect(html).toContain("م");
    expect(html).toMatch(pmChecked);
  });

  test("keeps the hour and minute left to right, the date in the page's direction", () => {
    const html = render("hijri");
    expect(html).toMatch(timeLeftToRight);
    expect(html).not.toMatch(monthLeftToRight);
  });

  test("shows no Gregorian date", () => {
    expect(render("hijri")).toContain('name="starts-day"');
    expect(render("hijri")).not.toContain(
      formatDay("ar", Date.UTC(2026, 1, 18), "gregorian")
    );
  });

  test("marks every part refused and says why", () => {
    const html = render("hijri", { error: "Enter a date and a time." });
    expect(html).toContain("Enter a date and a time.");
    expect(html.match(invalid)?.length).toBe(5);
  });
});

describe("a time field in Hijri with Gregorian", () => {
  test("shows the Gregorian date of the Hijri date chosen", () => {
    expect(render("hijri_gregorian")).toContain(
      formatDay("ar", Date.UTC(2026, 1, 18), "gregorian")
    );
    expect(render("hijri_gregorian", { locale: "en" })).toContain(
      formatDay("en", Date.UTC(2026, 1, 18), "gregorian")
    );
  });
});

describe("choosing one part of a Hijri time", () => {
  test("a day, a month or a year moves the date and keeps the time", () => {
    expect(withPart(value, "day", 2, false)).toBe("2026-02-19T14:05");
    expect(withPart(value, "month", 10, false)).toBe("2026-03-20T14:05");
    expect(withPart(value, "year", 1448, false)).toBe("2027-02-08T14:05");
  });

  test("a month shorter than the day chosen reads as its last day", () => {
    // 30 Ramadan 1447, then Shawwal, which has 29 days.
    expect(withPart("2026-03-19T08:00", "month", 10, false)).toBe(
      "2026-04-17T08:00"
    );
  });

  test("an hour and a minute on a 24-hour clock are what they say", () => {
    expect(withPart(value, "hour", 0, false)).toBe("2026-02-18T00:05");
    expect(withPart(value, "minute", 59, false)).toBe("2026-02-18T14:59");
  });

  test("an hour on a 12-hour clock keeps the half of the day", () => {
    expect(withPart(value, "hour", 3, true)).toBe("2026-02-18T15:05");
    expect(withPart(value, "hour", 12, true)).toBe("2026-02-18T12:05");
    expect(withPart("2026-02-18T12:05", "hour", 3, true)).toBe(
      "2026-02-18T15:05"
    );
    expect(withPart("2026-02-18T09:05", "hour", 12, true)).toBe(
      "2026-02-18T00:05"
    );
  });

  test("the half of the day keeps the hour", () => {
    expect(withPart(value, "period", 0, true)).toBe("2026-02-18T02:05");
    expect(withPart("2026-02-18T02:05", "period", 12, true)).toBe(
      "2026-02-18T14:05"
    );
    expect(withPart(value, "period", 12, true)).toBe(value);
  });
});

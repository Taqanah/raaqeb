import { describe, expect, test } from "bun:test";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import type { Locale } from "./locale.ts";
import { createMessages } from "./messages.ts";
import { repeatWords } from "./recurrence.ts";

function wordsIn(locale: Locale) {
  const i18n = createMessages(locale, locale === "ar" ? ar : en);
  return { locale, t: i18n._.bind(i18n) };
}

describe("the days a series repeats on, in words", () => {
  test("name every day, the days of a week, a day of the month or an nth weekday, with no time", () => {
    const english = wordsIn("en");
    expect(
      repeatWords(english, {
        repeat: "weekly",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      })
    ).toBe("Every day");
    expect(repeatWords(english, { repeat: "weekly", weekdays: [1, 4] })).toBe(
      "Every Monday and Thursday"
    );
    expect(repeatWords(english, { day: 5, repeat: "monthly_day" })).toBe(
      "Day 5 of every month"
    );
    expect(
      repeatWords(english, {
        repeat: "monthly_weekday",
        week: "second",
        weekday: 2,
      })
    ).toBe("The second Tuesday of every month");
  });

  test("read in Arabic with the Arabic list's «و»", () => {
    expect(
      repeatWords(wordsIn("ar"), { repeat: "weekly", weekdays: [0, 2] })
    ).toBe("كل أحد وثلاثاء");
  });
});

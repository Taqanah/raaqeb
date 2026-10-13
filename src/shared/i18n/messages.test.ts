import { describe, expect, test } from "bun:test";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { catalogFromJson, createMessages } from "./messages.ts";

describe("a locale's messages", () => {
  test("answer the words of that locale for an id", () => {
    expect(createMessages("ar", ar)._("app_name")).toBe("راقب");
    expect(createMessages("en", en)._("app_name")).toBe("Raaqeb");
  });

  test("have the locale active, so plural categories follow it", () => {
    // The id is a real one: an unknown id fails the type check, which is the point of the union.
    const i18n = createMessages("ar", {
      app_name:
        "{count, plural, zero {لا مراقبات} one {مراقبة واحدة} two {مراقبتان} few {# مراقبات} many {# مراقبة} other {# مراقبة}}",
    });
    expect(i18n.locale).toBe("ar");
    expect(i18n._("app_name", { count: 0 })).toBe("لا مراقبات");
    expect(i18n._("app_name", { count: 2 })).toBe("مراقبتان");
    expect(i18n._("app_name", { count: 3 })).toBe("3 مراقبات");
    expect(i18n._("app_name", { count: 11 })).toBe("11 مراقبة");
  });

  test("survive the trip through JSON text into the document", () => {
    const back = catalogFromJson(JSON.stringify(ar));
    expect(back).toEqual(ar);
    expect(createMessages("ar", back)._("onboarding_database_test")).toBe(
      "اختبار الاتصال"
    );
  });

  test("interpolate values", () => {
    const i18n = createMessages("en", { app_name: "Watching {name}" });
    expect(i18n._("app_name", { name: "example.com" })).toBe(
      "Watching example.com"
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  defaultLocale,
  directionOf,
  isLocale,
  localeSchema,
  locales,
  pathLocale,
} from "./locale.ts";

describe("the locales Raaqeb ships", () => {
  test("are Arabic and English, Arabic first", () => {
    expect(locales).toEqual(["ar", "en"]);
    expect(defaultLocale).toBe("ar");
  });

  test("Arabic reads right to left and English left to right", () => {
    expect(directionOf("ar")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
  });
});

describe("a locale in a URL or a setting", () => {
  test("is one of the two exact tags", () => {
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(localeSchema.parse("en")).toBe("en");
  });

  test("refuses a regional tag, a different case and anything else", () => {
    for (const value of ["ar-SA", "en-GB", "AR", "fr", "", undefined, 1]) {
      expect(isLocale(value)).toBe(false);
    }
    expect(localeSchema.safeParse("ar-SA").success).toBe(false);
  });
});

describe("the locale a path names", () => {
  test("is its first segment when that is exactly a locale tag", () => {
    expect(pathLocale("/en")).toBe("en");
    expect(pathLocale("/en/nope")).toBe("en");
    expect(pathLocale("/ar/status/docs")).toBe("ar");
  });

  test("is nothing for any other path", () => {
    for (const path of ["/", "/nope", "/english", "/EN/nope", "/status/en"]) {
      expect(pathLocale(path), path).toBeUndefined();
    }
  });
});

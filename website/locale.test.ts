import { describe, expect, test } from "bun:test";
import { pageLocale, pathLocale } from "./locale.ts";

describe("the locale a website address shows", () => {
  test("the bare path shows the Arabic page", () => {
    expect(pageLocale(undefined)).toBe("ar");
  });

  test("the /en prefix shows the English page", () => {
    expect(pageLocale("en")).toBe("en");
  });

  test("an /ar prefix names no page, since the Arabic page lives at the bare path", () => {
    expect(pageLocale("ar")).toBeUndefined();
  });

  test("a prefix that is no locale, or a locale in other case, names no page", () => {
    expect(pageLocale("fr")).toBeUndefined();
    expect(pageLocale("EN")).toBeUndefined();
    expect(pageLocale("")).toBeUndefined();
  });
});

describe("the locale a path that may name no page is shown in", () => {
  test("a path under /en is shown in English", () => {
    expect(pathLocale("/en")).toBe("en");
    expect(pathLocale("/en/")).toBe("en");
    expect(pathLocale("/en/docs/nope")).toBe("en");
  });

  test("every other path is shown in Arabic, an unknown one included", () => {
    expect(pathLocale("/")).toBe("ar");
    expect(pathLocale("/docs/nope")).toBe("ar");
    expect(pathLocale("/nope")).toBe("ar");
    expect(pathLocale("/ar/nope")).toBe("ar");
    expect(pathLocale("/english")).toBe("ar");
  });
});

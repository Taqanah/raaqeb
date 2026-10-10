import { describe, expect, test } from "bun:test";
import {
  contentDraftOf,
  contentIn,
  contentSchema,
  hasText,
  optionalContentSchema,
} from "./content.ts";

describe("what a reader sees of content", () => {
  test("a reader sees their own locale's text", () => {
    const name = { ar: "الموقع", en: "Website" };
    expect(contentIn(name, "en", "ar")).toBe("Website");
    expect(contentIn(name, "ar", "en")).toBe("الموقع");
  });

  test("an empty translation shows the page language's text", () => {
    expect(contentIn({ ar: "الموقع" }, "en", "ar")).toBe("الموقع");
  });

  test("with neither the reader's nor the page language's text, the locale that has one shows, never a blank", () => {
    expect(contentIn({ en: "Website" }, "ar", "ar")).toBe("Website");
    expect(contentIn({ en: "Website" }, "ar")).toBe("Website");
  });

  test("no content reads as empty", () => {
    expect(contentIn(undefined, "ar", "en")).toBe("");
    expect(contentIn({}, "ar")).toBe("");
  });

  test("whether content holds a locale's text", () => {
    expect(hasText({ ar: "الموقع" }, "ar")).toBe(true);
    expect(hasText({ ar: "الموقع" }, "en")).toBe(false);
    expect(hasText(undefined, "ar")).toBe(false);
  });

  test("a form shows each locale's text, empty where the content has none", () => {
    expect(contentDraftOf({ en: "Website" })).toEqual({
      ar: "",
      en: "Website",
    });
    expect(contentDraftOf(undefined)).toEqual({ ar: "", en: "" });
  });
});

describe("content an operator writes", () => {
  const name = contentSchema(10);
  const description = optionalContentSchema(10);

  test("each locale's text is trimmed and an empty one is dropped", () => {
    expect(name.parse({ ar: " الموقع ", en: "  " })).toEqual({ ar: "الموقع" });
    expect(name.parse({ en: "Site" })).toEqual({ en: "Site" });
  });

  test("content with no text in any locale is refused", () => {
    expect(name.safeParse({ ar: " ", en: "" }).success).toBe(false);
    expect(name.safeParse({}).success).toBe(false);
  });

  test("optional content with no text is none", () => {
    expect(description.parse({ ar: " ", en: "" })).toBeUndefined();
    expect(description.parse({ en: "Shop" })).toEqual({ en: "Shop" });
  });

  test("a locale's text past the limit is refused", () => {
    expect(name.safeParse({ ar: "ا".repeat(11) }).success).toBe(false);
    expect(name.safeParse({ ar: "ا".repeat(10) }).success).toBe(true);
    expect(description.safeParse({ en: "x".repeat(11) }).success).toBe(false);
  });

  test("text in a locale Raaqeb does not ship is refused", () => {
    expect(name.safeParse({ ar: "الموقع", fr: "Site" }).success).toBe(false);
  });

  test("a plain text, with no locale, is refused", () => {
    expect(name.safeParse("الموقع").success).toBe(false);
  });
});

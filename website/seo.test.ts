import { describe, expect, test } from "bun:test";
import { site } from "./copy.ts";
import { languageLinks } from "./seo.ts";

describe("a page's language links for search engines", () => {
  test("each language it is written in, and x-default on the Arabic one", () => {
    expect(
      languageLinks([
        { locale: "ar", url: "/docs/api" },
        { locale: "en", url: "/en/docs/api" },
      ])
    ).toEqual([
      { href: `${site}/docs/api`, hrefLang: "ar" },
      { href: `${site}/en/docs/api`, hrefLang: "en" },
      { href: `${site}/docs/api`, hrefLang: "x-default" },
    ]);
  });

  test("a page written only in English takes x-default itself", () => {
    expect(languageLinks([{ locale: "en", url: "/en/docs/new" }])).toEqual([
      { href: `${site}/en/docs/new`, hrefLang: "en" },
      { href: `${site}/en/docs/new`, hrefLang: "x-default" },
    ]);
  });

  test("the Arabic home page is the site's root, and x-default", () => {
    expect(
      languageLinks([
        { locale: "ar", url: "/" },
        { locale: "en", url: "/en" },
      ]).at(-1)
    ).toEqual({ href: `${site}/`, hrefLang: "x-default" });
  });
});

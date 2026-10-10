import { describe, expect, test } from "bun:test";
import { defineI18n } from "fumadocs-core/i18n";
import { createI18nSearchAPI } from "fumadocs-core/search/server";
import { languageIndex } from "./search-index.ts";
import { searchTokenizer } from "./search-text.ts";

const page = (id: string, locale: string, title: string, content: string) => ({
  id,
  locale,
  structuredData: {
    contents: [{ content, heading: undefined }],
    headings: [],
  },
  title,
  url: `/${id}`,
});

const search = createI18nSearchAPI("advanced", {
  i18n: defineI18n({
    defaultLanguage: "ar",
    fallbackLanguage: null,
    languages: ["ar", "en"],
  }),
  indexes: [
    page("ar-page", "ar", "المراقبة", "نقيس الاستجابة كل دقيقة"),
    page("en-page", "en", "Monitoring", "We measure the response each minute"),
  ],
  localeMap: { ar: "multilingual", en: "multilingual" },
  tokenizer: searchTokenizer,
});

describe("the docs' search index of a language", () => {
  test("holds the pages of that language only", async () => {
    const ar = JSON.stringify(await languageIndex(search, "ar"));
    expect(ar).toContain("المراقبة");
    expect(ar).not.toContain("Monitoring");

    const en = JSON.stringify(await languageIndex(search, "en"));
    expect(en).toContain("Monitoring");
    expect(en).not.toContain("المراقبة");
  });

  test("is smaller than the index of both languages", async () => {
    const both = JSON.stringify(await search.export()).length;
    const ar = JSON.stringify(await languageIndex(search, "ar")).length;
    expect(ar).toBeLessThan(both);
  });

  test("of a language with no pages does not exist", async () => {
    expect(await languageIndex(search, "fr")).toBeUndefined();
  });
});

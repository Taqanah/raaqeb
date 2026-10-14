import { describe, expect, test } from "bun:test";
import { createSearchAPI } from "fumadocs-core/search/server";
import {
  foldedPattern,
  searchStem,
  searchText,
  searchTokenizer,
} from "./search-text.ts";

describe("the docs' search", () => {
  test("matches an Arabic word typed without its diacritics", () => {
    expect(searchText("التعطّل")).toBe(searchText("التعطل"));
    expect(searchText("مُراقَبة")).toBe(searchText("مراقبة"));
  });

  test("ignores tatweel", () => {
    expect(searchText("مـراقبة")).toBe(searchText("مراقبة"));
  });

  test("matches a ta marbuta with a ha", () => {
    expect(searchText("حالة")).toBe(searchText("حاله"));
  });

  test("leaves Latin text and digits as they are", () => {
    expect(searchText("Docker 404 webhook")).toBe("Docker 404 webhook");
    expect(searchText("٤٠٤")).toBe("٤٠٤");
  });
});

describe("the docs' search over an index", () => {
  const search = createSearchAPI("advanced", {
    indexes: [
      {
        id: "add",
        structuredData: {
          contents: [{ content: "إضافة حالة إلى التعطّل", heading: undefined }],
          headings: [],
        },
        title: "الإضافة",
        url: "/add",
      },
    ],
    tokenizer: searchTokenizer,
  });
  // The dialog folds what the reader typed before it reaches the index.
  const find = (typed: string) => search.search(searchText(typed));

  // The engine's own tokenizer folds the hamza and alef forms and the alef maqsura; their rows pin that, since the docs rely on it.
  test.each([
    ["without its hamza", "اضافة"],
    ["with an alef with a hamza above", "أضافة"],
    ["with an alef with a madda", "آضافة"],
    ["with a ya for its alef maqsura", "الي"],
    ["without its shadda", "التعطل"],
    ["with a ha for its ta marbuta", "حاله"],
  ])("finds a word typed %s", async (_how, typed) => {
    expect((await find(typed)).map((r) => r.url)).toContain("/add");
  });

  test("shows the content as written, never folded", async () => {
    const shown = (await find("اضافة")).map((r) => r.content).join(" ");
    expect(shown).toContain("إضافة");
    expect(shown).toContain("التعطّل");
  });
});

describe("the docs' search marks what it found", () => {
  const marked = (typed: string, content: string) => {
    const pattern = foldedPattern(typed);
    return pattern ? [...content.matchAll(pattern)].map((m) => m[0]) : [];
  };

  test("a word typed without its diacritics marks the word as written", () => {
    expect(marked("التعطل", "يكرّر تنبيه التعطّل")).toEqual(["التعطّل"]);
  });

  test("a word typed with any alef form marks it under any other", () => {
    expect(marked("اضافة", "إضافة مراقبة")).toEqual(["إضافة"]);
    expect(marked("أضافة", "اضافة")).toEqual(["اضافة"]);
  });

  test("a ha marks a ta marbuta, and a ya an alef maqsura", () => {
    expect(marked("حاله", "صفحة الحالة")).toEqual(["حالة"]);
    expect(marked("الي", "إلى الخادوم")).toEqual(["إلى"]);
  });

  test("a tatweel in the content is passed over", () => {
    expect(marked("مراقبة", "مـراقبة")).toEqual(["مـراقبة"]);
  });

  test("each typed word is marked on its own, Latin in any case", () => {
    expect(marked("tls  ENOTFOUND", "TLS then enotfound")).toEqual([
      "TLS",
      "enotfound",
    ]);
  });

  test("a character patterns reserve is matched as itself", () => {
    expect(marked("a.b", "axb a.b")).toEqual(["a.b"]);
  });

  test("nothing typed marks nothing", () => {
    expect(foldedPattern("  ")).toBeUndefined();
  });
});

describe("the docs' search finds an Arabic word with or without its article, singular or plural", () => {
  test("the article and a feminine plural's ending make no other word", () => {
    expect(searchStem("التنبيه")).toBe(searchStem("تنبيه"));
    expect(searchStem("تنبيهات")).toBe(searchStem("تنبيه"));
    expect(searchStem("الحالة")).toBe(searchStem("حالات"));
    expect(searchStem("والتنبيهات")).toBe(searchStem("تنبيه"));
  });

  test("each word of a query is cut on its own", () => {
    expect(searchStem("التنبيهات  البريد")).toBe(
      `${searchStem("تنبيه")} ${searchStem("بريد")}`
    );
  });

  test("a word too short to hold an article or an ending keeps its letters", () => {
    expect(searchStem("الي")).toBe("الي");
    expect(searchStem("له")).toBe("له");
  });

  test("leaves Latin text as it is", () => {
    expect(searchStem("Docker webhooks")).toBe("Docker webhooks");
  });

  const search = createSearchAPI("advanced", {
    indexes: [
      {
        id: "one",
        structuredData: {
          contents: [{ content: "يصل التنبيه إلى البريد", heading: undefined }],
          headings: [],
        },
        title: "البريد",
        url: "/one",
      },
      {
        id: "many",
        structuredData: {
          contents: [{ content: "عدة تنبيهات في الساعة", heading: undefined }],
          headings: [],
        },
        title: "الحدود",
        url: "/many",
      },
    ],
    tokenizer: searchTokenizer,
  });
  // The dialog stems what the reader typed before it reaches the index.
  const found = async (typed: string) =>
    (await search.search(searchStem(typed))).map((r) => r.url);

  test.each(["التنبيه", "تنبيه", "تنبيهات", "التنبيهات"])(
    "%s finds the page with the singular and the page with the plural",
    async (typed) => {
      const urls = await found(typed);
      expect(urls).toContain("/one");
      expect(urls).toContain("/many");
    }
  );

  test("marks the word it found, plural or singular, with the article when typed", () => {
    const marked = (typed: string, content: string) => {
      const pattern = foldedPattern(typed);
      return pattern ? [...content.matchAll(pattern)].map((m) => m[0]) : [];
    };
    expect(marked("تنبيهات", "يصل التنبيه")).toEqual(["تنبيه"]);
    expect(marked("التنبيه", "عدة تنبيهات")).toEqual(["تنبيهات"]);
    expect(marked("التنبيه", "يصل التنبيه")).toEqual(["التنبيه"]);
  });
});

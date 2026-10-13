import { describe, expect, test } from "bun:test";
import { createSearchAPI } from "fumadocs-core/search/server";
import { foldedPattern, searchText, searchTokenizer } from "./search-text.ts";

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

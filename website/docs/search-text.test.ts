import { describe, expect, test } from "bun:test";
import { createSearchAPI } from "fumadocs-core/search/server";
import { searchText, searchTokenizer } from "./search-text.ts";

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

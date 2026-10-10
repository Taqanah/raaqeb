import { describe, expect, test } from "bun:test";
import { markdownUrl, slugsOfMarkdown } from "./markdown.ts";

describe("a docs page's Markdown copy", () => {
  test("sits at the page's address with .md", () => {
    expect(
      markdownUrl({ slugs: ["checks", "http"], url: "/en/docs/checks/http" })
    ).toBe("/en/docs/checks/http.md");
    expect(
      markdownUrl({ slugs: ["checks", "http"], url: "/docs/checks/http" })
    ).toBe("/docs/checks/http.md");
  });

  test("of the docs home is index.md, since its address ends at /docs", () => {
    expect(markdownUrl({ slugs: [], url: "/en/docs" })).toBe(
      "/en/docs/index.md"
    );
    expect(markdownUrl({ slugs: [], url: "/docs" })).toBe("/docs/index.md");
  });

  test("of a page whose own slug is docs sits beside it, not inside it", () => {
    expect(
      markdownUrl({ slugs: ["guides", "docs"], url: "/en/docs/guides/docs" })
    ).toBe("/en/docs/guides/docs.md");
  });

  test("names the page it was made from", () => {
    expect(slugsOfMarkdown("checks/http")).toEqual(["checks", "http"]);
    expect(slugsOfMarkdown("operate")).toEqual(["operate"]);
  });

  test("named index is the docs home", () => {
    expect(slugsOfMarkdown("index")).toEqual([]);
  });

  test("with no name names no page", () => {
    expect(slugsOfMarkdown(undefined)).toEqual([]);
    expect(slugsOfMarkdown("")).toEqual([]);
  });
});

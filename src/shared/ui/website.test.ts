import { describe, expect, test } from "bun:test";
import { websiteDocs, websiteHome } from "./website.ts";

describe("Raaqeb's website", () => {
  test("opens in Arabic at its bare address", () => {
    expect(websiteHome("ar")).toBe("https://raaqeb.dev/");
  });

  test("opens in English under /en", () => {
    expect(websiteHome("en")).toBe("https://raaqeb.dev/en");
  });

  test("has a docs page in Arabic under /docs and in English under /en/docs", () => {
    expect(websiteDocs("ar", "operate/commands")).toBe(
      "https://raaqeb.dev/docs/operate/commands"
    );
    expect(websiteDocs("en", "operate/commands")).toBe(
      "https://raaqeb.dev/en/docs/operate/commands"
    );
  });
});

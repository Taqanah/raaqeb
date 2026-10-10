import { describe, expect, test } from "bun:test";
import { websiteHome } from "./website.ts";

describe("Raaqeb's website", () => {
  test("opens in Arabic at its bare address", () => {
    expect(websiteHome("ar")).toBe("https://raaqeb.dev/");
  });

  test("opens in English under /en", () => {
    expect(websiteHome("en")).toBe("https://raaqeb.dev/en");
  });
});

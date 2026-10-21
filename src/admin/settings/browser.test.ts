import { describe, expect, test } from "bun:test";
import { browserOf } from "./browser.ts";

describe("a session's browser", () => {
  test("is named with its system for the common ones, those that also say Chrome or Safari by their own name", () => {
    expect(
      browserOf(
        "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"
      )
    ).toEqual({ browser: "Firefox", system: "Linux" });
    expect(
      browserOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
      )
    ).toEqual({ browser: "Edge", system: "Windows" });
    expect(
      browserOf(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
      )
    ).toEqual({ browser: "Safari", system: "macOS" });
    expect(
      browserOf(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
      )
    ).toEqual({ browser: "Chrome", system: "Android" });
    expect(
      browserOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
      )
    ).toEqual({ browser: "Safari", system: "iOS" });
  });

  test("is unknown without a header, or for one that is not a common browser", () => {
    expect(browserOf(null)).toBeUndefined();
    expect(browserOf("")).toBeUndefined();
    expect(browserOf("curl/8.10.1")).toBeUndefined();
  });
});

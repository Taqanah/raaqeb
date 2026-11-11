import { describe, expect, test } from "bun:test";
import { browserAgentOf } from "./user-agent.ts";

/** Real current headers: [what sent it, header, browser, major version, system]. */
const sent = [
  [
    "Firefox on Linux",
    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Firefox",
    "140",
    "Linux",
  ],
  [
    "Firefox on Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Firefox",
    "140",
    "Windows",
  ],
  [
    "Firefox on macOS",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Firefox",
    "140",
    "macOS",
  ],
  [
    "Firefox on Android",
    "Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
    "Firefox",
    "140",
    "Android",
  ],
  [
    "Firefox on an iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
    "Firefox",
    "140",
    "iOS",
  ],
  [
    "Safari on a Mac",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
    "Safari",
    "18",
    "macOS",
  ],
  [
    "Safari on an iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    "Safari",
    "18",
    "iOS",
  ],
  [
    "Safari on an iPad",
    "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    "Safari",
    "18",
    "iOS",
  ],
  [
    "Chrome on an iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1",
    "Chrome",
    "140",
    "iOS",
  ],
  [
    "Edge on an iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 EdgiOS/140.0.3485.74 Mobile/15E148 Safari/605.1.15",
    "Edge",
    "140",
    "iOS",
  ],
  [
    "Edge on Android",
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.3485.74",
    "Edge",
    "140",
    "Android",
  ],
  [
    "Chrome on Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Chrome",
    "140",
    "Windows",
  ],
  [
    "Chrome on Android",
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    "Chrome",
    "140",
    "Android",
  ],
  [
    "Edge on Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.54",
    "Edge",
    "140",
    "Windows",
  ],
  [
    "Opera on Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/121.0.0.0",
    "Opera",
    "121",
    "Windows",
  ],
  [
    "Samsung Internet",
    "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
    "Samsung Internet",
    "28",
    "Android",
  ],
  [
    "Chrome on a Chromebook",
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Chrome",
    "140",
    "ChromeOS",
  ],
  [
    "Playwright's headless Chromium",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339.16 Safari/537.36",
    "Headless Chrome",
    "140",
    "Linux",
  ],
  [
    "Playwright's WebKit on Linux",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    "Safari",
    "26",
    "Linux",
  ],
  [
    "DuckDuckGo on an iPhone",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
    "Safari",
    "17",
    "iOS",
  ],
  [
    "DuckDuckGo on a Mac",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Ddg/17.5 Safari/605.1.15",
    "Safari",
    "17",
    "macOS",
  ],
] as const;

describe("the browser a User-Agent names", () => {
  test.each(sent)(
    "%s is named, with its major version and system",
    (_, header, browser, version, system) => {
      expect(browserAgentOf(header)).toEqual({ browser, system, version });
    }
  );

  test("a WebKit string with Safari but no Version, which no other browser claims, is Safari on its system, with no version to give", () => {
    expect(
      browserAgentOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/322.0.665018 Mobile/15E148 Safari/604.1"
      )
    ).toEqual({ browser: "Safari", system: "iOS", version: undefined });
  });

  test("a known browser on a system with no common name keeps its own name", () => {
    expect(
      browserAgentOf(
        "Mozilla/5.0 (X11; FreeBSD amd64; rv:140.0) Gecko/20100101 Firefox/140.0"
      )
    ).toEqual({ browser: "Firefox", system: undefined, version: "140" });
  });

  test("a header that names no browser names none", () => {
    expect(browserAgentOf("")).toBeUndefined();
    expect(browserAgentOf("curl/8.10.1")).toBeUndefined();
    expect(
      browserAgentOf("Mozilla/5.0 (Something; Unheard of)")
    ).toBeUndefined();
  });
});

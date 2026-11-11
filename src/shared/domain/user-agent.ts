/**
 * The browser and system a User-Agent header names, in a word each, for the
 * account page's sessions and the request log's lines. The common ones only;
 * a header that names none is not a browser's.
 */

export interface BrowserAgent {
  readonly browser: string;
  /** Nothing when the header names no common system. */
  readonly system: string | undefined;
  /** The major version; nothing for a Safari-based browser that names none. */
  readonly version: string | undefined;
}

// Order matters: Edge, Opera and Samsung Internet also say Chrome, and Chrome also says Safari.
const browsers: readonly (readonly [RegExp, string])[] = [
  [/Edg(?:e|A|iOS)?\/(\d{1,5})/, "Edge"],
  [/OPR\/(\d{1,5})/, "Opera"],
  [/SamsungBrowser\/(\d{1,5})/, "Samsung Internet"],
  [/(?:Firefox|FxiOS)\/(\d{1,5})/, "Firefox"],
  [/HeadlessChrome\/(\d{1,5})/, "Headless Chrome"],
  [/(?:Chrome|CriOS)\/(\d{1,5})/, "Chrome"],
  // Safari-based browsers (DuckDuckGo, the Google app) put their own token between Version and Safari.
  [/Version\/(\d{1,5})\b.*\bSafari\//, "Safari"],
  // Last: a WebKit string that gives no Version at all, which no browser above claimed.
  [/\bSafari\//, "Safari"],
];

// iOS before macOS, which an iPad's string also names; Android and ChromeOS before Linux.
const systems: readonly (readonly [RegExp, string])[] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

/** The browser a Mozilla-style User-Agent names, or nothing when it names none. */
export function browserAgentOf(userAgent: string): BrowserAgent | undefined {
  for (const [pattern, browser] of browsers) {
    const match = pattern.exec(userAgent);
    if (match) {
      const system = systems.find(([named]) => named.test(userAgent))?.[1];
      return { browser, system, version: match[1] };
    }
  }
}

/**
 * A session's browser and system in a word each, from its user agent, so
 * the account page lists "Firefox on Linux" rather than the header. The
 * common ones only; anything else is unknown, which the page says so.
 */

/** Each browser's mark in the header; the first that matches names it, so the ones that also say Chrome or Safari come before them. */
const browsers: readonly [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const systems: readonly [RegExp, string][] = [
  [/Android/, "Android"],
  [/iPhone|iPad/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

/** The browser and system of a user agent; nothing when either is not a common one. */
export function browserOf(
  userAgent: string | null
): { readonly browser: string; readonly system: string } | undefined {
  if (!userAgent) {
    return;
  }
  const browser = browsers.find(([mark]) => mark.test(userAgent))?.[1];
  const system = systems.find(([mark]) => mark.test(userAgent))?.[1];
  return browser && system ? { browser, system } : undefined;
}

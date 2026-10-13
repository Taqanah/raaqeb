/**
 * The request log's line: while the switch on the
 * general page is on, every request the entry's `fetch` answers is one line
 * by the logging convention (log.ts), written once the response is ready.
 * Static files never reach `fetch`, and a health probe answered 200 within a
 * second is not worth a line.
 */

import { clientAddressHeader } from "./boot/proxies.ts";
import { loggedPath } from "./log.ts";

/** How a status page's answer was made: from the memo's stored entry, or rendered for this request. */
export type MemoAnswer = "cached" | "rendered";

/** The status of a request whose client left before the answer was ready. */
export const closed = "closed";

/** Past this a request is slow, and its line names the process's memory. */
const slowMs = 1000;

const megabyte = 1024 * 1024;

// TanStack Start's default base for server functions, which the build keeps.
const serverFunctions = "/_serverFn/";

/** What answered a request, as its line names it. */
function kindOf(path: string, memo: MemoAnswer | undefined): string {
  if (memo !== undefined) {
    return memo === "cached" ? "status-page cached=true" : "status-page";
  }
  if (path.startsWith(serverFunctions)) {
    return "function";
  }
  if (path.startsWith("/api/auth/")) {
    return "auth";
  }
  return path.startsWith("/api/") || path === "/health" ? "api" : "page";
}

// A value with one of these is quoted, so it reads as one value whatever a client sent.
const unsafeValue = /[\s"\\]/;

/** A value as logfmt writes it: bare, or quoted with its quotes and backslashes escaped. */
function logfmt(value: string): string {
  if (value !== "" && !unsafeValue.test(value)) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The line for one request, or nothing when the request is not logged, in
 * logfmt: `request method= path= status= ms= ip= kind= browser=`, with
 * `cached=true` after the kind for a memo hit, `status=closed` for a client
 * that left, and `rss_mb=` from `rss` (bytes) when the request took over a
 * second or answered 5xx.
 */
export function requestLine(
  request: Request,
  status: number | typeof closed,
  ms: number,
  memo: MemoAnswer | undefined,
  rss: () => number
): string | undefined {
  const path = loggedPath(request.url);
  const took = Math.round(ms);
  const slow = took > slowMs;
  if (path === "/health" && status === 200 && !slow) {
    return;
  }
  const failed = typeof status === "number" && status >= 500;
  const memory =
    slow || failed ? ` rss_mb=${Math.round(rss() / megabyte)}` : "";
  const client = logfmt(request.headers.get(clientAddressHeader) ?? "-");
  const browser = logfmt(browserName(request.headers.get("user-agent")));
  return `request method=${logfmt(request.method)} path=${logfmt(path)} status=${status} ms=${took} ip=${client} kind=${kindOf(path, memo)} browser=${browser}${memory}`;
}

// A tool names itself first, as `curl/8.5.0`; the name is cut short so a client cannot grow the line.
const toolToken = /^([\w.-]{1,40})(?:\/(\d{1,5})(?:\.(\d{1,5}))?)?/;
// A crawler inside a browser's string: `(compatible; Googlebot/2.1; ...)`.
const botToken = /\(compatible; ([\w.-]{1,40}\/\d{1,5}(?:\.\d{1,5})?)/;

// Order matters: Edge, Opera and Samsung Internet also say Chrome, and Chrome also says Safari.
const browsers: readonly (readonly [RegExp, string])[] = [
  [/Edg(?:e|A|iOS)?\/(\d{1,5})/, "Edge"],
  [/OPR\/(\d{1,5})/, "Opera"],
  [/SamsungBrowser\/(\d{1,5})/, "Samsung Internet"],
  [/(?:Firefox|FxiOS)\/(\d{1,5})/, "Firefox"],
  [/HeadlessChrome\/(\d{1,5})/, "Headless Chrome"],
  [/(?:Chrome|CriOS)\/(\d{1,5})/, "Chrome"],
  [/Version\/(\d{1,5})[^ ]* (?:Mobile\/[^ ]+ )?Safari\//, "Safari"],
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

/** A tool's own name and version, the version cut to major and minor. */
function toolName(userAgent: string): string {
  const [, name, major, minor] = toolToken.exec(userAgent) ?? [];
  if (name === undefined) {
    return "unknown";
  }
  if (major === undefined) {
    return name;
  }
  return minor === undefined ? `${name}/${major}` : `${name}/${major}.${minor}`;
}

/** A browser or tool as a line names it, from its User-Agent: "Firefox 131 on Linux", "Safari 18 on iOS", "curl/8.5"; `-` for none. */
export function browserName(userAgent: string | null): string {
  if (!userAgent) {
    return "-";
  }
  if (!userAgent.startsWith("Mozilla/")) {
    return toolName(userAgent);
  }
  const bot = botToken.exec(userAgent)?.[1];
  if (bot !== undefined) {
    return bot;
  }
  for (const [pattern, name] of browsers) {
    const version = pattern.exec(userAgent)?.[1];
    if (version !== undefined) {
      const system = systems.find(([named]) => named.test(userAgent))?.[1];
      return system === undefined
        ? `${name} ${version}`
        : `${name} ${version} on ${system}`;
    }
  }
  return "unknown";
}

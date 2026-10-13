import { describe, expect, test } from "bun:test";
import { clientAddressHeader } from "./boot/proxies.ts";
import { browserName, closed, requestLine } from "./request-log.ts";

/** What a browser's name may hold: no quote, no line break, and no more than a short name needs. */
const safeName = /^[\w ./-]{1,48}$/;

const firefox =
  "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

/** A request as the entry hands it on: the client address it resolved, and the browser's User-Agent. */
function request(
  path: string,
  init: { client?: string; method?: string; userAgent?: string } = {}
): Request {
  const headers = new Headers();
  if (init.client !== undefined) {
    headers.set(clientAddressHeader, init.client);
  }
  if (init.userAgent !== undefined) {
    headers.set("user-agent", init.userAgent);
  }
  return new Request(`http://raaqeb.test${path}`, {
    headers,
    method: init.method ?? "GET",
  });
}

const megabytes = (n: number) => () => n * 1024 * 1024;
const unread = () => {
  throw new Error("the memory was read for a request that does not show it");
};

describe("a request's line", () => {
  test("names the method, the path, the status, the time to the answer, the client address, the kind and the browser", () => {
    expect(
      requestLine(
        request("/admin/monitors", {
          client: "203.0.113.9",
          userAgent: firefox,
        }),
        200,
        12.4,
        undefined,
        unread
      )
    ).toBe(
      'request method=GET path=/admin/monitors status=200 ms=12 ip=203.0.113.9 kind=page browser="Firefox 131 on Linux"'
    );
  });

  test("names what answered: a server function, Better Auth, the API, or a status page rendered or served from the memo", () => {
    const kind = (path: string, memo?: "cached" | "rendered") =>
      requestLine(request(path, { client: "127.0.0.1" }), 200, 3, memo, unread);
    expect(kind("/_serverFn/4f2a9c")).toBe(
      "request method=GET path=/_serverFn/4f2a9c status=200 ms=3 ip=127.0.0.1 kind=function browser=-"
    );
    expect(kind("/api/auth/sign-in/email")).toBe(
      "request method=GET path=/api/auth/sign-in/email status=200 ms=3 ip=127.0.0.1 kind=auth browser=-"
    );
    expect(kind("/api/v2/monitors")).toBe(
      "request method=GET path=/api/v2/monitors status=200 ms=3 ip=127.0.0.1 kind=api browser=-"
    );
    expect(kind("/status/main", "rendered")).toBe(
      "request method=GET path=/status/main status=200 ms=3 ip=127.0.0.1 kind=status-page browser=-"
    );
    expect(kind("/status/main", "cached")).toBe(
      "request method=GET path=/status/main status=200 ms=3 ip=127.0.0.1 kind=status-page cached=true browser=-"
    );
  });

  test("never carries a query or a token a path holds", () => {
    expect(
      requestLine(
        request("/api/heartbeat/s3cret?status=up", { client: "127.0.0.1" }),
        200,
        1,
        undefined,
        unread
      )
    ).toBe(
      "request method=GET path=/api/heartbeat/<token> status=200 ms=1 ip=127.0.0.1 kind=api browser=-"
    );
  });

  test("a request with no client address, as over a unix socket, names none", () => {
    expect(requestLine(request("/"), 302, 1, undefined, unread)).toBe(
      "request method=GET path=/ status=302 ms=1 ip=- kind=page browser=-"
    );
  });

  test("a value holding a space, a quote or a backslash is quoted with those escaped, so it cannot add a key or end the line's quoting", () => {
    const ip = (client: string) =>
      requestLine(request("/", { client }), 200, 1, undefined, unread);
    expect(ip("203.0.113.9 kind=api")).toBe(
      'request method=GET path=/ status=200 ms=1 ip="203.0.113.9 kind=api" kind=page browser=-'
    );
    expect(ip('a" kind="api')).toBe(
      'request method=GET path=/ status=200 ms=1 ip="a\\" kind=\\"api" kind=page browser=-'
    );
    expect(ip("")).toBe(
      'request method=GET path=/ status=200 ms=1 ip="" kind=page browser=-'
    );
    expect(ip("a\\")).toBe(
      'request method=GET path=/ status=200 ms=1 ip="a\\\\" kind=page browser=-'
    );
  });

  test("a client that left before the answer is named as closed", () => {
    expect(
      requestLine(
        request("/admin", { client: "127.0.0.1" }),
        closed,
        40,
        undefined,
        unread
      )
    ).toBe(
      "request method=GET path=/admin status=closed ms=40 ip=127.0.0.1 kind=page browser=-"
    );
  });

  test("a request over a second, or one answering 5xx, adds the process's memory; a quick one, a 4xx or exactly a second does not read it", () => {
    const line = (status: number, ms: number, rss: () => number) =>
      requestLine(
        request("/admin", { client: "127.0.0.1" }),
        status,
        ms,
        undefined,
        rss
      );
    expect(line(200, 1001, megabytes(87))).toBe(
      "request method=GET path=/admin status=200 ms=1001 ip=127.0.0.1 kind=page browser=- rss_mb=87"
    );
    expect(line(503, 4, () => 90.6 * 1024 * 1024)).toBe(
      "request method=GET path=/admin status=503 ms=4 ip=127.0.0.1 kind=page browser=- rss_mb=91"
    );
    expect(line(500, 4, megabytes(87))).toBe(
      "request method=GET path=/admin status=500 ms=4 ip=127.0.0.1 kind=page browser=- rss_mb=87"
    );
    expect(line(499, 4, unread)).toBe(
      "request method=GET path=/admin status=499 ms=4 ip=127.0.0.1 kind=page browser=-"
    );
    expect(line(404, 4, unread)).toBe(
      "request method=GET path=/admin status=404 ms=4 ip=127.0.0.1 kind=page browser=-"
    );
    expect(line(200, 1000, unread)).toBe(
      "request method=GET path=/admin status=200 ms=1000 ip=127.0.0.1 kind=page browser=-"
    );
  });

  test("a health probe answered 200 within a second is not logged; a failing or slow one is", () => {
    const probe = (status: number, ms: number) =>
      requestLine(
        request("/health", { client: "127.0.0.1", userAgent: "curl/8.5.0" }),
        status,
        ms,
        undefined,
        megabytes(80)
      );
    expect(probe(200, 2)).toBeUndefined();
    expect(probe(200, 1000)).toBeUndefined();
    expect(probe(503, 2)).toBe(
      "request method=GET path=/health status=503 ms=2 ip=127.0.0.1 kind=api browser=curl/8.5 rss_mb=80"
    );
    expect(probe(200, 1500)).toBe(
      "request method=GET path=/health status=200 ms=1500 ip=127.0.0.1 kind=api browser=curl/8.5 rss_mb=80"
    );
  });
});

describe("a browser as a line names it", () => {
  test.each([
    [firefox, "Firefox 131 on Linux"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari 18 on iOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Safari 18 on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome 130 on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
      "Edge 130 on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
      "Opera 115 on Windows",
    ],
    [
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      "Chrome 130 on Android",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      "Samsung Internet 26 on Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
      "Chrome 130 on iOS",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15",
      "Firefox 131 on iOS",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome 130 on ChromeOS",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.33 Safari/537.36",
      "Headless Chrome 131 on Linux",
    ],
    [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Googlebot/2.1",
    ],
    ["curl/8.5.0", "curl/8.5"],
    ["Wget/1.21.4", "Wget/1.21"],
    ["python-requests/2.32.3", "python-requests/2.32"],
    ["Go-http-client/1.1", "Go-http-client/1.1"],
    ["Uptime-Kuma/2", "Uptime-Kuma/2"],
    ["Mozilla/5.0 (Something; Unheard of)", "unknown"],
  ])("%s is %s", (userAgent, name) => {
    expect(browserName(userAgent)).toBe(name);
  });

  test("a request with no User-Agent names none", () => {
    expect(browserName(null)).toBe("-");
    expect(browserName("")).toBe("-");
  });

  test("whatever a client sends, the name is letters, digits, dots, dashes, slashes and spaces, so it cannot break out of its quotes or grow the line", () => {
    for (const userAgent of [
      'evil" 200 0ms 10.0.0.1 page "x',
      '"quoted"',
      "line\nbreak",
      `${"a".repeat(5000)}/1.0`,
      'Mozilla/5.0 (compatible; "bot"/1; Firefox/9")',
    ]) {
      const name = browserName(userAgent);
      expect(name).toMatch(safeName);
    }
  });
});

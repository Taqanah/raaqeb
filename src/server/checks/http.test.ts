import { describe, expect, test } from "bun:test";
import { retryDelayMs } from "@/shared/domain/checks.ts";
import { captureBodyBytes, errorMaxLength } from "@/shared/schemas/check.ts";
import type { HttpConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { credentialMask } from "./capture.ts";
import {
  bodyReadBytes,
  type CheckIo,
  type HttpMonitor,
  runHttpCheck,
} from "./http.ts";

const config: HttpConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: "https://example.test/health",
};

function monitor(
  overrides: Omit<Partial<HttpMonitor>, "config"> & {
    config?: Partial<HttpConfig>;
  } = {}
): HttpMonitor {
  const { config: configOverrides, ...rest } = overrides;
  return {
    config: { ...config, ...configOverrides },
    degradedMs: undefined,
    id: "m1",
    retries: 2,
    timeoutMs: 10_000,
    ...rest,
  };
}

/** The request options as Bun's fetch reads them, with its own `tls` field. */
type SeenInit = RequestInit & { tls?: { rejectUnauthorized?: boolean } };

/** One scripted answer of the fake fetch: a response after `ms`, or a thrown error. */
type Answer =
  | { ms: number; response: () => Response }
  | { ms: number; throws: unknown };

/** A clock the fake fetch advances, a sleep that records its delays, and the requests seen. */
function io(answers: Answer[]) {
  let clock = 1_700_000_000_000;
  const sleeps: number[] = [];
  const requests: { url: string; init: SeenInit | undefined }[] = [];
  const fetchFake = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ init: init as SeenInit | undefined, url: String(input) });
    const answer = answers.shift();
    if (!answer) {
      throw new Error("the fake fetch ran out of answers");
    }
    clock += answer.ms;
    if ("throws" in answer) {
      return Promise.reject(answer.throws);
    }
    return Promise.resolve(answer.response());
  }) as typeof fetch;
  const checkIo: CheckIo = {
    fetch: fetchFake,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  return { io: checkIo, requests, sleeps };
}

const ok = (ms: number, body = "ok", init: ResponseInit = {}): Answer => ({
  ms,
  response: () => new Response(body, { status: 200, ...init }),
});
const status = (ms: number, code: number): Answer => ({
  ms,
  response: () => new Response("nope", { status: code }),
});
const refused = (ms: number): Answer => ({
  ms,
  throws: Object.assign(new TypeError("Unable to connect."), {
    code: "ConnectionRefused",
  }),
});
const timedOut = (ms: number): Answer => ({
  ms,
  throws: new DOMException("The operation timed out.", "TimeoutError"),
});

describe("one HTTP check", () => {
  test("passing success rules are up in one attempt, with the time, the status and the bytes", async () => {
    const { io: checkIo, sleeps } = io([ok(120, "hello")]);
    const outcome = await runHttpCheck(monitor(), checkIo);
    expect(outcome.check).toEqual({
      attempts: 1,
      bytes: 5,
      monitorId: "m1",
      reason: reasons.ok,
      responseMs: 120,
      result: "up",
      startedAt: 1_700_000_000_000,
      statusCode: 200,
    });
    expect(outcome.detail).toBeUndefined();
    expect(outcome.capture).toBeUndefined();
    expect(sleeps).toEqual([]);
  });

  test("a failure is retried after the delay and the check is down after the retries, counting every attempt", async () => {
    const { io: checkIo, sleeps } = io([
      status(50, 503),
      status(60, 503),
      status(70, 502),
    ]);
    const outcome = await runHttpCheck(monitor({ retries: 2 }), checkIo);
    expect(outcome.check).toMatchObject({
      attempts: 3,
      reason: reasons.unexpected_status,
      responseMs: 70,
      result: "down",
      startedAt: 1_700_000_000_000,
      statusCode: 502,
    });
    expect(sleeps).toEqual([retryDelayMs, retryDelayMs]);
    expect(outcome.detail).toEqual({
      assertion: { codes: ["2xx"], kind: "status" },
      error: undefined,
      monitorId: "m1",
      params: { expected: ["2xx"], observed: 502, reason: "unexpected_status" },
      startedAt: 1_700_000_000_000,
    });
  });

  test("a timeout is the reason timeout and the response time is capped at the timeout", async () => {
    const { io: checkIo } = io([timedOut(10_400)]);
    const outcome = await runHttpCheck(monitor({ retries: 0 }), checkIo);
    expect(outcome.check).toMatchObject({
      bytes: 0,
      reason: reasons.timeout,
      responseMs: 10_000,
      result: "down",
    });
    expect(outcome.detail?.params).toEqual({
      reason: "timeout",
      timeoutMs: 10_000,
    });
  });

  test("a failing assertion after a good status is down with the assertion and what it saw", async () => {
    const { io: checkIo } = io([ok(50, '{"status":"down"}')]);
    const outcome = await runHttpCheck(
      monitor({
        config: {
          assertions: [
            { codes: ["2xx"], kind: "status" },
            { kind: "json_equals", path: "status", value: "up" },
          ],
        },
        retries: 0,
      }),
      checkIo
    );
    expect(outcome.check).toMatchObject({
      reason: reasons.assertion_failed,
      result: "down",
      statusCode: 200,
    });
    expect(outcome.detail).toMatchObject({
      assertion: { kind: "json_equals", path: "status", value: "up" },
      params: { expected: "up", observed: "down", reason: "assertion_failed" },
    });
  });

  test("response time under N failing is the reason slow, a down check, not a degraded one", async () => {
    const { io: checkIo } = io([ok(800)]);
    const outcome = await runHttpCheck(
      monitor({
        config: { assertions: [{ kind: "response_time_under", ms: 500 }] },
        degradedMs: 300,
        retries: 0,
      }),
      checkIo
    );
    expect(outcome.check).toMatchObject({
      reason: reasons.slow,
      result: "down",
    });
    expect(outcome.detail?.params).toEqual({
      limitMs: 500,
      observedMs: 800,
      reason: "slow",
    });
  });

  test("the request carries the method, the body, the timeout signal, and leaves redirects to the check rather than fetch", async () => {
    const { io: checkIo, requests } = io([ok(10)]);
    await runHttpCheck(
      monitor({
        config: { body: '{"ping":1}', method: "POST" },
        timeoutMs: 3000,
      }),
      checkIo
    );
    const [request] = requests;
    expect(request?.url).toBe("https://example.test/health");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.body).toBe('{"ping":1}');
    expect(request?.init?.redirect).toBe("manual");
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a GET carries no body even when one is stored", async () => {
    const { io: checkIo, requests } = io([ok(10)]);
    await runHttpCheck(
      monitor({ config: { body: "ignored", method: "GET" } }),
      checkIo
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  test("follow redirects off asks for a manual redirect, and the 3xx is what the status set sees", async () => {
    const { io: checkIo, requests } = io([
      {
        ms: 10,
        response: () =>
          new Response(null, { headers: { location: "/next" }, status: 302 }),
      },
    ]);
    const outcome = await runHttpCheck(
      monitor({ config: { followRedirects: false }, retries: 0 }),
      checkIo
    );
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(outcome.check).toMatchObject({
      reason: reasons.unexpected_status,
      result: "down",
      statusCode: 302,
    });
  });

  test("ignore TLS errors disables certificate verification on the request", async () => {
    const { io: checkIo, requests } = io([ok(10), ok(10)]);
    await runHttpCheck(monitor({ config: { ignoreTlsErrors: true } }), checkIo);
    await runHttpCheck(monitor(), checkIo);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.tls).toEqual({ rejectUnauthorized: false });
    expect(requests[1]?.init?.tls).toBeUndefined();
  });

  test("the body is read to the cap and the rest of the stream is cancelled", async () => {
    let cancelled = false;
    let pulled = 0;
    const chunk = new Uint8Array(65_536).fill(1);
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { io: checkIo } = io([
      { ms: 10, response: () => new Response(stream, { status: 200 }) },
    ]);
    const outcome = await runHttpCheck(
      monitor({ config: { captureMode: "always" } }),
      checkIo
    );
    expect(outcome.check.bytes).toBe(bodyReadBytes);
    expect(cancelled).toBe(true);
    // 1 MB in 64 KB chunks is 16 pulls; one more may be in flight when the loop leaves.
    expect(pulled).toBeLessThanOrEqual(17);
    expect(outcome.capture?.body.byteLength).toBe(captureBodyBytes);
  });

  test("a body under the cap is read whole and the stream is not cancelled", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(1000));
        controller.close();
      },
    });
    const { io: checkIo } = io([
      { ms: 10, response: () => new Response(stream, { status: 200 }) },
    ]);
    const outcome = await runHttpCheck(monitor(), checkIo);
    expect(outcome.check.bytes).toBe(1000);
    expect(cancelled).toBe(false);
  });

  test("a HEAD reads zero bytes", async () => {
    const { io: checkIo } = io([
      { ms: 10, response: () => new Response(null, { status: 200 }) },
    ]);
    const outcome = await runHttpCheck(
      monitor({ config: { method: "HEAD" } }),
      checkIo
    );
    expect(outcome.check).toMatchObject({ bytes: 0, result: "up" });
  });

  test("capture on failure keeps the down check's response, redacted, and nothing on up or degraded", async () => {
    const headers = { "content-type": "text/plain", "set-cookie": "s=1" };
    const { io: checkIo } = io([
      {
        ms: 10,
        response: () => new Response("body", { headers, status: 500 }),
      },
      {
        ms: 10,
        response: () => new Response("body", { headers, status: 200 }),
      },
      {
        ms: 900,
        response: () => new Response("body", { headers, status: 200 }),
      },
    ]);
    const mode = monitor({
      config: { captureMode: "on_failure" },
      degradedMs: 500,
      retries: 0,
    });
    const down = await runHttpCheck(mode, checkIo);
    expect(down.capture).toEqual({
      body: new TextEncoder().encode("body"),
      headers: [
        { name: "content-type", value: "text/plain" },
        { name: "set-cookie", value: undefined },
      ],
      monitorId: "m1",
      startedAt: down.check.startedAt,
    });
    const up = await runHttpCheck(mode, checkIo);
    expect(up.check.result).toBe("up");
    expect(up.capture).toBeUndefined();
    const degraded = await runHttpCheck(mode, checkIo);
    expect(degraded.check.result).toBe("degraded");
    expect(degraded.capture).toBeUndefined();
  });

  test("the capture and the detail are of the last attempt", async () => {
    const { io: checkIo } = io([status(10, 500), refused(10)]);
    const outcome = await runHttpCheck(
      monitor({ config: { captureMode: "on_failure" }, retries: 1 }),
      checkIo
    );
    expect(outcome.check).toMatchObject({
      attempts: 2,
      reason: reasons.connection_refused,
      statusCode: undefined,
    });
    expect(outcome.capture).toBeUndefined();
    expect(outcome.detail).toMatchObject({
      assertion: undefined,
      error: "Unable to connect.",
      params: { host: "example.test", port: 443, reason: "connection_refused" },
    });
  });

  test("a stream that fails mid-body is a down check with the reason of the error and the bytes that did arrive", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(300));
          return;
        }
        controller.error(
          Object.assign(new TypeError("reset"), { code: "ECONNRESET" })
        );
      },
    });
    const { io: checkIo } = io([
      { ms: 10, response: () => new Response(stream, { status: 200 }) },
    ]);
    const outcome = await runHttpCheck(monitor({ retries: 0 }), checkIo);
    expect(outcome.check).toMatchObject({
      bytes: 300,
      reason: reasons.connection_failed,
      result: "down",
      statusCode: 200,
    });
  });
});

describe("an HTTP monitor's credentials on the request", () => {
  const headersOf = (init: SeenInit | undefined) => new Headers(init?.headers);

  test("basic auth is sent as the Authorization header, the user and password in UTF-8 base64 (RFC 7617)", async () => {
    const { io: checkIo, requests } = io([ok(10)]);
    await runHttpCheck(
      monitor({
        credentials: {
          auth: { kind: "basic", password: "كلمة", user: "ops" },
          headers: [],
        },
      }),
      checkIo
    );
    const expected = new TextEncoder().encode("ops:كلمة").toBase64();
    expect(headersOf(requests[0]?.init).get("authorization")).toBe(
      `Basic ${expected}`
    );
  });

  test("a bearer token is sent as the Authorization header", async () => {
    const { io: checkIo, requests } = io([ok(10)]);
    await runHttpCheck(
      monitor({
        credentials: { auth: { kind: "bearer", token: "tok-1" }, headers: [] },
      }),
      checkIo
    );
    expect(headersOf(requests[0]?.init).get("authorization")).toBe(
      "Bearer tok-1"
    );
  });

  test("custom headers are sent on every attempt, retries included", async () => {
    const { io: checkIo, requests } = io([status(10, 500), ok(10)]);
    await runHttpCheck(
      monitor({
        credentials: {
          auth: undefined,
          headers: [
            { name: "X-Api-Key", value: "k1" },
            { name: "Content-Type", value: "application/json" },
          ],
        },
      }),
      checkIo
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const headers = headersOf(request.init);
      expect(headers.get("x-api-key")).toBe("k1");
      expect(headers.get("content-type")).toBe("application/json");
    }
  });

  test("the auth field wins over a custom Authorization header", async () => {
    const { io: checkIo, requests } = io([ok(10)]);
    await runHttpCheck(
      monitor({
        credentials: {
          auth: { kind: "bearer", token: "tok-1" },
          headers: [{ name: "Authorization", value: "Basic other" }],
        },
      }),
      checkIo
    );
    expect(headersOf(requests[0]?.init).get("authorization")).toBe(
      "Bearer tok-1"
    );
  });

  test("without credentials no Authorization header is sent", async () => {
    const { io: checkIo, requests } = io([ok(10)]);
    await runHttpCheck(monitor(), checkIo);
    expect(requests).toHaveLength(1);
    expect(headersOf(requests[0]?.init).has("authorization")).toBe(false);
  });

  test("a credential never reaches the capture or the failure detail", async () => {
    const { io: checkIo } = io([
      status(10, 401),
      status(10, 401),
      status(10, 401),
    ]);
    const outcome = await runHttpCheck(
      monitor({
        config: { captureMode: "always" },
        credentials: {
          auth: { kind: "bearer", token: "tok-secret" },
          headers: [{ name: "X-Api-Key", value: "key-secret" }],
        },
      }),
      checkIo
    );
    const kept = JSON.stringify({
      capture: outcome.capture?.headers,
      detail: outcome.detail,
    });
    expect(kept.includes("tok-secret")).toBe(false);
    expect(kept.includes("key-secret")).toBe(false);
  });
});

describe("a target that echoes the credentials it got", () => {
  /** A target that answers 401 with the request's headers as its JSON body and its Authorization repeated in a response header. */
  const echoing: CheckIo = {
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      const sent = new Headers(init?.headers);
      return Promise.resolve(
        new Response(JSON.stringify(Object.fromEntries(sent)), {
          headers: { "x-echo": sent.get("authorization") ?? "" },
          status: 401,
        })
      );
    }) as typeof fetch,
    now: () => 0,
    sleep: () => Promise.resolve(),
  };
  const echoed = (credentials: HttpMonitor["credentials"]) =>
    monitor({
      config: {
        assertions: [{ kind: "body_contains", text: "welcome" }],
        captureMode: "always",
      },
      credentials,
      retries: 0,
    });
  const quoted = (outcome: Awaited<ReturnType<typeof runHttpCheck>>) => {
    const params = outcome.detail?.params;
    return params && "observed" in params ? params.observed : undefined;
  };

  test("a bearer token and a custom header value are masked in the capture's body and headers and in the failure detail", async () => {
    const outcome = await runHttpCheck(
      echoed({
        auth: { kind: "bearer", token: "tok-secret" },
        headers: [{ name: "X-Custom", value: "  key-secret  " }],
      }),
      echoing
    );
    const masked = JSON.stringify({
      authorization: `Bearer ${credentialMask}`,
      "x-custom": credentialMask,
    });
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(masked);
    expect(outcome.capture?.headers).toContainEqual({
      name: "x-echo",
      value: `Bearer ${credentialMask}`,
    });
    expect(quoted(outcome)).toBe(masked);
  });

  test("the basic pair's base64 as sent is masked", async () => {
    const outcome = await runHttpCheck(
      echoed({
        auth: { kind: "basic", password: "pass-secret", user: "ops" },
        headers: [],
      }),
      echoing
    );
    const masked = JSON.stringify({
      authorization: `Basic ${credentialMask}`,
    });
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(masked);
    expect(quoted(outcome)).toBe(masked);
  });

  test("a basic password the response repeats is masked", async () => {
    const { io: checkIo } = io([ok(10, "the password was pass-secret")]);
    const outcome = await runHttpCheck(
      echoed({
        auth: { kind: "basic", password: "pass-secret", user: "ops" },
        headers: [],
      }),
      checkIo
    );
    const masked = `the password was ${credentialMask}`;
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(masked);
    expect(quoted(outcome)).toBe(masked);
  });

  test("an error text that quotes a credential keeps the mask", async () => {
    const { io: checkIo } = io([
      { ms: 10, throws: new TypeError("proxy refused Bearer tok-secret") },
    ]);
    const outcome = await runHttpCheck(
      echoed({ auth: { kind: "bearer", token: "tok-secret" }, headers: [] }),
      checkIo
    );
    expect(outcome.detail?.error).toBe(
      `proxy refused Bearer ${credentialMask}`
    );
  });

  test("a credential straddling the error text's cut leaves no part of itself", async () => {
    const before = "x".repeat(errorMaxLength - 4);
    const { io: checkIo } = io([
      { ms: 10, throws: new TypeError(`${before}tok-secret`) },
    ]);
    const outcome = await runHttpCheck(
      echoed({ auth: { kind: "bearer", token: "tok-secret" }, headers: [] }),
      checkIo
    );
    expect(outcome.detail?.error).toBe(
      `${before}${credentialMask}`.slice(0, errorMaxLength)
    );
  });

  test("a custom header's value is masked with no auth field set, a custom Authorization whole", async () => {
    const outcome = await runHttpCheck(
      echoed({
        auth: undefined,
        headers: [{ name: "Authorization", value: "Token key-secret" }],
      }),
      echoing
    );
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(
      JSON.stringify({ authorization: credentialMask })
    );
  });

  test("a standard request header's value is not masked, any other custom header's value is", async () => {
    const outcome = await runHttpCheck(
      monitor({
        config: {
          assertions: [
            { kind: "header_equals", name: "x-echo", value: "text/html" },
          ],
          captureMode: "always",
        },
        credentials: {
          auth: undefined,
          headers: [
            { name: "Accept", value: "application/json" },
            { name: "accept-encoding", value: "gzip" },
            { name: "Accept-Language", value: "ar" },
            { name: "Content-Type", value: "text/plain" },
            { name: "Cache-Control", value: "no-cache" },
            { name: "User-Agent", value: "probe/2" },
            { name: "X-Api-Key", value: "key-secret" },
          ],
        },
        retries: 0,
      }),
      {
        ...echoing,
        fetch: ((_input: string | URL | Request, init?: RequestInit) => {
          const sent = new Headers(init?.headers);
          return Promise.resolve(
            new Response(JSON.stringify(Object.fromEntries(sent)), {
              headers: { "x-echo": sent.get("accept") ?? "" },
            })
          );
        }) as typeof fetch,
      }
    );
    expect(JSON.parse(new TextDecoder().decode(outcome.capture?.body))).toEqual(
      {
        accept: "application/json",
        "accept-encoding": "gzip",
        "accept-language": "ar",
        "cache-control": "no-cache",
        "content-type": "text/plain",
        "user-agent": "probe/2",
        "x-api-key": credentialMask,
      }
    );
    expect(outcome.capture?.headers).toContainEqual({
      name: "x-echo",
      value: "application/json",
    });
    expect(outcome.detail?.params).toMatchObject({
      expected: "text/html",
      observed: "application/json",
    });
  });

  test("a token with spaces around it is masked as the request sent it, trimmed", async () => {
    const outcome = await runHttpCheck(
      echoed({ auth: { kind: "bearer", token: "tok-secret \t" }, headers: [] }),
      echoing
    );
    const masked = JSON.stringify({
      authorization: `Bearer ${credentialMask}`,
    });
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(masked);
    expect(outcome.capture?.headers).toContainEqual({
      name: "x-echo",
      value: `Bearer ${credentialMask}`,
    });
  });
});

describe("a header value the platform refuses", () => {
  test("a header value the platform refuses fails the check without the value in the failure detail", async () => {
    const { io: checkIo, requests } = io([]);
    const outcome = await runHttpCheck(
      monitor({
        credentials: {
          auth: undefined,
          headers: [{ name: "X-Api-Key", value: "مفتاح-سري" }],
        },
        retries: 0,
      }),
      checkIo
    );
    expect(outcome.check.result).toBe("down");
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(outcome.detail).includes("مفتاح-سري")).toBe(false);
  });
});

const hopPath = /^\/hop\/(\d+)$/;

/** The check's real I/O, for tests against a local server. */
const live: CheckIo = {
  fetch,
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

describe("following redirects", () => {
  /** What a local server saw of each request: the path and the headers. */
  interface Seen {
    readonly headers: Headers;
    readonly path: string;
  }

  /** A local server: /hop/<n> redirects to /hop/<n - 1> until /hop/0 answers "arrived"; /loop redirects to itself; /dir/start redirects to the relative "next". */
  function chainServer() {
    const seen: Seen[] = [];
    const server = Bun.serve({
      fetch(request) {
        const { pathname } = new URL(request.url);
        seen.push({ headers: request.headers, path: pathname });
        const hop = hopPath.exec(pathname);
        if (hop && Number(hop[1]) > 0) {
          return new Response("moved", {
            headers: { location: `/hop/${Number(hop[1]) - 1}` },
            status: 302,
          });
        }
        if (pathname === "/loop") {
          return new Response(null, {
            headers: { location: "/loop" },
            status: 302,
          });
        }
        if (pathname === "/dir/start") {
          return new Response(null, {
            headers: { location: "next" },
            status: 301,
          });
        }
        return new Response("arrived");
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    return { seen, server };
  }

  const following = (url: string, overrides: Partial<HttpMonitor> = {}) =>
    monitor({
      config: {
        assertions: [
          { codes: ["2xx"], kind: "status" },
          { kind: "body_contains", text: "arrived" },
        ],
        url,
      },
      retries: 0,
      ...overrides,
    });

  test("a chain of ten redirects is followed, and the status and the success rules read the final response", async () => {
    const { seen, server } = chainServer();
    using _ = server;
    const outcome = await runHttpCheck(following(`${server.url}hop/10`), live);
    expect(outcome.check).toMatchObject({
      bytes: "arrived".length,
      reason: reasons.ok,
      result: "up",
      statusCode: 200,
    });
    expect(seen).toHaveLength(11);
  });

  test("the eleventh redirect fails the attempt as too many redirects, without following it", async () => {
    const { seen, server } = chainServer();
    using _ = server;
    const outcome = await runHttpCheck(following(`${server.url}hop/11`), live);
    expect(outcome.check).toMatchObject({
      reason: reasons.too_many_redirects,
      result: "down",
    });
    expect(outcome.detail).toMatchObject({
      error: "The response redirected too many times.",
      params: { reason: "too_many_redirects" },
    });
    expect(seen).toHaveLength(11);
  });

  test("a hop to another origin drops Authorization, the Cookie and Proxy-Authorization as fetch does, and keeps the other custom headers", async () => {
    const { seen, server: other } = chainServer();
    using _other = other;
    using origin = Bun.serve({
      fetch: () =>
        new Response(null, {
          headers: { location: `${other.url}hop/0` },
          status: 302,
        }),
      hostname: "127.0.0.1",
      port: 0,
    });
    const outcome = await runHttpCheck(
      following(origin.url.href, {
        credentials: {
          auth: { kind: "bearer", token: "tok-1" },
          headers: [
            { name: "X-Api-Key", value: "k1" },
            { name: "Cookie", value: "s=1" },
            { name: "Proxy-Authorization", value: "Basic p" },
          ],
        },
      }),
      live
    );
    expect(outcome.check.result).toBe("up");
    const [hop] = seen;
    expect(hop?.headers.has("authorization")).toBe(false);
    expect(hop?.headers.has("cookie")).toBe(false);
    expect(hop?.headers.has("proxy-authorization")).toBe(false);
    expect(hop?.headers.get("x-api-key")).toBe("k1");
  });

  test("a hop within the origin keeps Authorization", async () => {
    const { seen, server } = chainServer();
    using _ = server;
    await runHttpCheck(
      following(`${server.url}hop/1`, {
        credentials: { auth: { kind: "bearer", token: "tok-1" }, headers: [] },
      }),
      live
    );
    expect(seen.map(({ headers }) => headers.get("authorization"))).toEqual([
      "Bearer tok-1",
      "Bearer tok-1",
    ]);
  });

  const redirect = (
    code: number,
    location = "/next",
    body: BodyInit | null = null
  ): Answer => ({
    ms: 10,
    response: () => new Response(body, { headers: { location }, status: code }),
  });

  /** The method, the body and the content type of the second request after a redirect with `code` of a `method` request. */
  async function hopAfter(code: number, method: HttpConfig["method"]) {
    const { io: checkIo, requests } = io([redirect(code), ok(10)]);
    await runHttpCheck(
      monitor({
        config: { body: "payload", method },
        credentials: {
          auth: undefined,
          headers: [{ name: "Content-Type", value: "text/plain" }],
        },
        retries: 0,
      }),
      checkIo
    );
    const init = requests[1]?.init;
    return {
      body: init?.body,
      contentType: new Headers(init?.headers).get("content-type"),
      method: init?.method,
      url: requests[1]?.url,
    };
  }

  test("a 303 turns the request into a GET with no body", async () => {
    const hops = await Promise.all(
      (["POST", "PUT", "DELETE"] as const).map((method) =>
        hopAfter(303, method)
      )
    );
    for (const hop of hops) {
      expect(hop).toEqual({
        body: undefined,
        contentType: null,
        method: "GET",
        url: "https://example.test/next",
      });
    }
  });

  test("a 301 or 302 after a POST is a GET with no body, and after any other method keeps the method and the body", async () => {
    const [post301, put301, post302, put302] = await Promise.all([
      hopAfter(301, "POST"),
      hopAfter(301, "PUT"),
      hopAfter(302, "POST"),
      hopAfter(302, "PUT"),
    ]);
    for (const hop of [post301, post302]) {
      expect(hop).toMatchObject({
        body: undefined,
        contentType: null,
        method: "GET",
      });
    }
    for (const hop of [put301, put302]) {
      expect(hop).toMatchObject({
        body: "payload",
        contentType: "text/plain",
        method: "PUT",
      });
    }
  });

  test("a 307 or 308 keeps the method and the body", async () => {
    const hops = await Promise.all([
      hopAfter(307, "POST"),
      hopAfter(308, "POST"),
    ]);
    for (const hop of hops) {
      expect(hop).toMatchObject({
        body: "payload",
        contentType: "text/plain",
        method: "POST",
      });
    }
  });

  test("every hop shares the attempt's one timeout signal and carries ignore TLS errors", async () => {
    const { io: checkIo, requests } = io([
      redirect(302),
      redirect(307),
      ok(10),
    ]);
    await runHttpCheck(
      monitor({ config: { ignoreTlsErrors: true }, retries: 0 }),
      checkIo
    );
    expect(requests).toHaveLength(3);
    const signal = requests[0]?.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    for (const { init } of requests) {
      expect(init?.signal).toBe(signal);
      expect(init?.tls).toEqual({ rejectUnauthorized: false });
    }
  });

  test("each redirect response's body is cancelled so its connection is freed", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        controller.enqueue(new Uint8Array(16));
      },
    });
    const { io: checkIo } = io([redirect(302, "/next", stream), ok(10)]);
    const outcome = await runHttpCheck(monitor({ retries: 0 }), checkIo);
    expect(outcome.check.result).toBe("up");
    expect(cancelled).toBe(true);
  });

  test("the response time covers the whole chain", async () => {
    const { io: checkIo } = io([
      { ...redirect(302), ms: 100 },
      { ...redirect(302), ms: 200 },
      ok(300),
    ]);
    const outcome = await runHttpCheck(monitor({ retries: 0 }), checkIo);
    expect(outcome.check.responseMs).toBe(600);
  });

  test("with redirects off the 3xx is the answer and nothing is followed", async () => {
    const { seen, server } = chainServer();
    using _ = server;
    const outcome = await runHttpCheck(
      monitor({
        config: {
          assertions: [{ codes: ["3xx"], kind: "status" }],
          followRedirects: false,
          url: `${server.url}hop/3`,
        },
        retries: 0,
      }),
      live
    );
    expect(outcome.check).toMatchObject({ result: "up", statusCode: 302 });
    expect(seen).toHaveLength(1);
  });

  test("a relative Location in a later hop resolves against that hop's URL, not the monitor's", async () => {
    const { io: checkIo, requests } = io([
      redirect(302, "https://other.test/b/second"),
      redirect(302, "next"),
      ok(10),
    ]);
    await runHttpCheck(monitor({ retries: 0 }), checkIo);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://example.test/health",
      "https://other.test/b/second",
      "https://other.test/b/next",
    ]);
  });

  test("Authorization left behind on another origin stays off when the chain comes back", async () => {
    const { io: checkIo, requests } = io([
      redirect(302, "https://other.test/x"),
      redirect(302, "https://example.test/back"),
      ok(10),
    ]);
    await runHttpCheck(
      monitor({
        credentials: { auth: { kind: "bearer", token: "tok-1" }, headers: [] },
        retries: 0,
      }),
      checkIo
    );
    expect(
      requests.map(({ init }) =>
        new Headers(init?.headers).has("authorization")
      )
    ).toEqual([true, false, false]);
  });

  test("a 303 after a HEAD stays a HEAD", async () => {
    expect(await hopAfter(303, "HEAD")).toMatchObject({ method: "HEAD" });
  });

  test("a 3xx without a Location, or a 300 or 304, is the answer and is not followed", async () => {
    const threeXx = monitor({
      config: { assertions: [{ codes: ["3xx"], kind: "status" }] },
      retries: 0,
    });
    const answers: Answer[] = [
      { ms: 10, response: () => new Response(null, { status: 302 }) },
      redirect(300),
      redirect(304),
    ];
    const runs = answers.map((answer) => io([answer]));
    const outcomes = await Promise.all(
      runs.map((run) => runHttpCheck(threeXx, run.io))
    );
    expect(outcomes.map(({ check }) => check.statusCode)).toEqual([
      302, 300, 304,
    ]);
    expect(runs.map(({ requests }) => requests.length)).toEqual([1, 1, 1]);
  });

  test("a Location that is not a URL fails the attempt without another request", async () => {
    const { io: checkIo, requests } = io([redirect(302, "http://[")]);
    const outcome = await runHttpCheck(monitor({ retries: 0 }), checkIo);
    expect(outcome.check).toMatchObject({
      reason: reasons.unknown,
      result: "down",
    });
    expect(requests).toHaveLength(1);
  });

  test("a redirect to a scheme other than http or https fails the attempt, as fetch refuses it, and reads nothing", async () => {
    for (const location of [
      `file://${import.meta.path}`,
      "s3://bucket/key",
      "data:text/plain,secret",
    ]) {
      using origin = Bun.serve({
        fetch: () => new Response(null, { headers: { location }, status: 302 }),
        hostname: "127.0.0.1",
        port: 0,
      });
      // biome-ignore lint/performance/noAwaitInLoops: one server at a time keeps each Location's failure apart
      const outcome = await runHttpCheck(
        monitor({
          config: { captureMode: "always", url: origin.url.href },
          retries: 0,
        }),
        {
          fetch,
          now: () => Date.now(),
          sleep: (ms) => Bun.sleep(ms),
        }
      );
      expect(outcome.check).toMatchObject({
        bytes: 0,
        reason: reasons.unknown,
        result: "down",
      });
      expect(outcome.capture).toBeUndefined();
      expect(outcome.detail?.error).toBe(
        `UnsupportedRedirectProtocol fetching "${origin.url.href}".`
      );
    }
  });
});

describe("a TLS handshake the server ends before any certificate", () => {
  /** A local port that answers the ClientHello by closing, or by a plain HTTP reply. */
  function dropping(reply: string) {
    return Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.end(reply);
        },
      },
    });
  }

  for (const [what, reply] of [
    ["a server that closes after the ClientHello", ""],
    ["a server that answers in plain HTTP", "HTTP/1.1 400 Bad Request\r\n\r\n"],
  ] as const) {
    test(`${what} is connection failed, never an invalid certificate`, async () => {
      const server = dropping(reply);
      try {
        const outcome = await runHttpCheck(
          monitor({
            config: { url: `https://127.0.0.1:${server.port}/` },
            retries: 0,
          }),
          live
        );
        expect(outcome.check).toMatchObject({
          reason: reasons.connection_failed,
          result: "down",
        });
        expect(outcome.detail).toMatchObject({
          params: { reason: "connection_failed" },
        });
      } finally {
        server.stop(true);
      }
    });
  }
});

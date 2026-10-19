/**
 * The outbound proxy (CONTEXT.md "Outbound proxy") on the real `fetch`, with a
 * recording proxy and real servers on loopback: which checks the install's
 * environment routes, which it never does, and how a monitor's own proxy
 * overrides it. Bun reads the proxy variables at each request, so a test sets
 * them for its own run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import type { HttpConfig } from "@/shared/schemas/monitor.ts";
import { requestDocker } from "./docker-io.ts";
import { proxyOf } from "./http.ts";
import { liveIo } from "./io.ts";
import {
  setProxyEnvironment,
  startProxy,
  type TestProxy,
} from "./proxy-fixture.ts";
import { type CheckedMonitor, runCheck } from "./run.ts";

const proxies: TestProxy[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  for (const each of proxies.splice(0)) {
    each.stop();
  }
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function proxy(reply?: Parameters<typeof startProxy>[0]): TestProxy {
  const started = startProxy(reply);
  proxies.push(started);
  return started;
}

/** A real HTTP server on loopback that answers 200 `direct`. */
function target(): string {
  const server = Bun.serve({
    fetch: () => new Response("direct"),
    hostname: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/`;
}

const config: HttpConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: "http://web.example.test:8080/health",
};

function http(
  overrides: Partial<HttpConfig> = {},
  credentials?: Credentials
): CheckedMonitor {
  return {
    config: { ...config, ...overrides },
    credentials,
    degradedMs: undefined,
    id: "m1",
    retries: 0,
    timeoutMs: 3000,
  };
}

async function check(monitor: CheckedMonitor) {
  const outcome = await runCheck(monitor, liveIo());
  if (!outcome) {
    throw new Error("no check ran");
  }
  return outcome.check;
}

describe("the install's proxy environment on an HTTP check", () => {
  test("an http target is requested through HTTP_PROXY", async () => {
    const seen = proxy();
    restore = setProxyEnvironment({ HTTP_PROXY: seen.url });
    const result = await check(http());
    expect(seen.requests.map((request) => request.line)).toEqual([
      "GET http://web.example.test:8080/health HTTP/1.1",
    ]);
    expect(result.result).toBe("up");
  });

  test("an https target is tunnelled through HTTPS_PROXY, even with TLS errors ignored", async () => {
    const seen = proxy();
    restore = setProxyEnvironment({ HTTPS_PROXY: seen.url });
    await check(http({ url: "https://secure.example.test/" }));
    await check(
      http({ ignoreTlsErrors: true, url: "https://lax.example.test/" })
    );
    expect(seen.requests.map((request) => request.line)).toEqual([
      "CONNECT secure.example.test:443 HTTP/1.1",
      "CONNECT lax.example.test:443 HTTP/1.1",
    ]);
  });

  test("ALL_PROXY serves both schemes when the scheme's own variable is unset", async () => {
    const seen = proxy();
    restore = setProxyEnvironment({ ALL_PROXY: seen.url });
    await check(http());
    expect(seen.requests).toHaveLength(1);
  });

  test("a redirect's next hop goes through the proxy too", async () => {
    const seen = proxy((request) =>
      request.line.includes("web.example.test")
        ? { headers: { location: "http://other.example.test/" }, status: 302 }
        : { status: 200 }
    );
    restore = setProxyEnvironment({ HTTP_PROXY: seen.url });
    const result = await check(http());
    expect(seen.requests.map((request) => request.line)).toEqual([
      "GET http://web.example.test:8080/health HTTP/1.1",
      "GET http://other.example.test/ HTTP/1.1",
    ]);
    expect(result.result).toBe("up");
  });

  test("NO_PROXY keeps a host off the proxy, and with no variable set the check goes direct", async () => {
    const seen = proxy();
    const url = target();
    restore = setProxyEnvironment({
      HTTP_PROXY: seen.url,
      NO_PROXY: "127.0.0.1",
    });
    expect((await check(http({ url }))).result).toBe("up");
    restore();
    restore = setProxyEnvironment({});
    expect((await check(http({ url }))).result).toBe("up");
    expect(seen.requests).toEqual([]);
  });
});

describe("an HTTP monitor's own proxy", () => {
  test("is used in place of the environment's", async () => {
    const environment = proxy();
    const own = proxy();
    restore = setProxyEnvironment({ HTTP_PROXY: environment.url });
    const result = await check(http({ proxy: own.url }));
    expect(own.requests.map((request) => request.line)).toEqual([
      "GET http://web.example.test:8080/health HTTP/1.1",
    ]);
    expect(environment.requests).toEqual([]);
    expect(result.result).toBe("up");
  });

  test("is used with no environment at all, for an https target too", async () => {
    const own = proxy();
    restore = setProxyEnvironment({});
    await check(http({ proxy: own.url, url: "https://secure.example.test/" }));
    expect(own.requests.map((request) => request.line)).toEqual([
      "CONNECT secure.example.test:443 HTTP/1.1",
    ]);
  });

  test("is used for a host NO_PROXY lists, since the operator asked for it on this monitor", async () => {
    const own = proxy();
    restore = setProxyEnvironment({ NO_PROXY: "*" });
    await check(http({ proxy: own.url, url: target() }));
    expect(own.requests).toHaveLength(1);
  });

  test("sends its sealed user name and password as the proxy's Basic authorization", async () => {
    const own = proxy();
    restore = setProxyEnvironment({});
    await check(
      http(
        { proxy: own.url },
        { headers: [], proxyAuth: { password: "p:w d", user: "ops" } }
      )
    );
    expect(own.requests[0]?.headers["proxy-authorization"]).toBe(
      `Basic ${btoa("ops:p:w d")}`
    );
  });

  test("sends no proxy authorization without credentials, and never to the target", async () => {
    const own = proxy();
    restore = setProxyEnvironment({});
    await check(http({ proxy: own.url }));
    expect(own.requests[0]?.headers["proxy-authorization"]).toBeUndefined();
  });

  test("a proxy that refuses the tunnel fails the check and names the refusal", async () => {
    const own = proxy();
    restore = setProxyEnvironment({});
    const outcome = await runCheck(
      http({ proxy: own.url, url: "https://secure.example.test/" }),
      liveIo()
    );
    expect(outcome?.check.result).toBe("down");
    expect(outcome?.detail?.error).toContain("Proxy refused");
  });
});

describe("what the proxy never covers", () => {
  test("a TCP check opens its own connection", async () => {
    const seen = proxy();
    restore = setProxyEnvironment({
      ALL_PROXY: seen.url,
      HTTP_PROXY: seen.url,
      HTTPS_PROXY: seen.url,
    });
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
    servers.push(listener);
    const result = await check({
      config: { host: "127.0.0.1", port: listener.port, type: "tcp" },
      degradedMs: undefined,
      id: "t1",
      retries: 0,
      timeoutMs: 3000,
    });
    expect(result.result).toBe("up");
    expect(seen.requests).toEqual([]);
  });

  test("a Docker endpoint's URL is asked directly, never through the environment's proxy", async () => {
    const seen = proxy((request) => ({
      status: request.line.startsWith("CONNECT") ? 502 : 503,
    }));
    restore = setProxyEnvironment({ HTTP_PROXY: seen.url });
    const daemon = Bun.serve({
      fetch: () => Response.json({ State: { Running: true } }),
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(daemon);
    const answer = await requestDocker({
      endpoint: `http://127.0.0.1:${daemon.port}`,
      path: "/containers/web/json",
      timeoutMs: 3000,
    });
    expect(answer).toEqual({ body: { State: { Running: true } }, status: 200 });
    expect(seen.requests).toEqual([]);
  });
});

describe("the proxy option of a monitor's own proxy", () => {
  test("is nothing for a monitor with none, so the environment decides", () => {
    expect(proxyOf(config, undefined)).toBeUndefined();
    expect(
      proxyOf(config, { headers: [], proxyAuth: { password: "x", user: "u" } })
    ).toBeUndefined();
  });

  test("is the address, with NO_PROXY not applied and the sealed credentials as Basic authorization", () => {
    expect(
      proxyOf(
        { ...config, proxy: "http://proxy.example.test:3128" },
        { headers: [], proxyAuth: { password: "pw", user: "ops" } }
      )
    ).toEqual({
      headers: { "Proxy-Authorization": `Basic ${btoa("ops:pw")}` },
      respectNoProxy: false,
      url: "http://proxy.example.test:3128",
    });
    expect(
      proxyOf({ ...config, proxy: "https://proxy.example.test" }, undefined)
    ).toEqual({ respectNoProxy: false, url: "https://proxy.example.test" });
  });

  test("encodes a user name and password that are not Latin-1 as UTF-8", () => {
    const option = proxyOf(
      { ...config, proxy: "http://proxy.example.test" },
      { headers: [], proxyAuth: { password: "كلمة", user: "مشغل" } }
    );
    const pair = new TextEncoder().encode("مشغل:كلمة");
    expect(option).toMatchObject({
      headers: { "Proxy-Authorization": `Basic ${pair.toBase64()}` },
    });
  });
});

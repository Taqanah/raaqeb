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
import { reasons } from "@/shared/schemas/reason.ts";
import { requestDocker } from "./docker-io.ts";
import { environmentProxySecrets, proxyFor, proxyOf } from "./http.ts";
import { liveIo } from "./io.ts";
import {
  deadProxyUrl,
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
  test.each(["HTTP_PROXY", "ALL_PROXY"] as const)(
    "a sign-in written into %s that the proxy repeats is in neither the capture nor the detail, decoded or as written",
    async (variable) => {
      // The URL carries the password percent-encoded; the platform sends it decoded.
      const password = "env@pass-77";
      const pair = btoa(`ops:${password}`);
      const echoing = proxy(() => ({
        body: `you sent Basic ${pair}, that is ops:${password} from ops:env%40pass-77`,
        headers: { "x-echo": `Basic ${pair}` },
        status: 200,
      }));
      restore = setProxyEnvironment({
        [variable]: echoing.url.replace("//", "//ops:env%40pass-77@"),
      });
      const outcome = await runCheck(
        http({
          assertions: [{ kind: "body_contains", text: "never" }],
          captureMode: "always",
        }),
        liveIo()
      );
      expect(echoing.requests[0]?.headers["proxy-authorization"]).toBe(
        `Basic ${pair}`
      );
      const written = JSON.stringify({
        ...outcome,
        body: new TextDecoder().decode(outcome?.capture?.body),
      });
      expect(written).toContain("you sent Basic");
      expect(written).toContain("x-echo");
      expect(written).not.toContain(pair);
      expect(written).not.toContain(password);
      expect(written).not.toContain("env%40pass-77");
    }
  );
});

describe("the sign-in of the environment's proxy, as masked", () => {
  test.each([
    // A user alone still sends the pair, with an empty password.
    { expected: ["b3BzOg=="], value: "http://ops@127.0.0.1:3128" },
    { expected: [], value: "http://127.0.0.1:3128" },
    // Not a URL, as a proxy written without its scheme is: nothing, and nothing thrown.
    { expected: [], value: "127.0.0.1:3128" },
    // A malformed escape: Bun sends no sign-in, but the password as written is still a secret.
    { expected: ["pa%zz"], value: "http://ops:pa%zz@127.0.0.1:3128" },
  ] satisfies { expected: string[]; value: string }[])(
    "$value gives $expected",
    ({ expected, value }) => {
      expect(environmentProxySecrets({ HTTP_PROXY: value })).toStrictEqual(
        expected
      );
    }
  );
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

  test("sends no proxy authorization without credentials", async () => {
    const own = proxy();
    restore = setProxyEnvironment({});
    await check(http({ proxy: own.url }));
    expect(own.requests).toHaveLength(1);
    expect(own.requests[0]?.headers["proxy-authorization"]).toBeUndefined();
  });

  // A hostile proxy repeats what it was sent; the capture, the failure detail and the error must not keep it.
  test.each([
    { assertions: config.assertions, captureMode: "always", status: 200 },
    { assertions: config.assertions, captureMode: "always", status: 407 },
    // With no capture, only the failed assertion's detail quotes the body.
    {
      assertions: [{ kind: "body_contains", text: "never" }],
      captureMode: "off",
      status: 200,
    },
  ] satisfies (Pick<HttpConfig, "assertions" | "captureMode"> & {
    status: number;
  })[])(
    "a proxy that answers $status with its own credentials, capture $captureMode, puts neither the password nor its Basic pair in the outcome",
    async ({ assertions, captureMode, status }) => {
      const password = "proxy-pass-77";
      const pair = btoa(`ops:${password}`);
      const own = proxy(() => ({
        body: `you sent Basic ${pair}, that is ops:${password}`,
        headers: { "x-echo": pair },
        status,
      }));
      restore = setProxyEnvironment({});
      const outcome = await runCheck(
        http(
          { assertions, captureMode, proxy: own.url },
          { headers: [], proxyAuth: { password, user: "ops" } }
        ),
        liveIo()
      );
      expect(own.requests[0]?.headers["proxy-authorization"]).toBe(
        `Basic ${pair}`
      );
      const written = JSON.stringify({
        ...outcome,
        body: new TextDecoder().decode(outcome?.capture?.body),
      });
      expect(written).toContain("you sent Basic");
      expect(written).not.toContain(password);
      expect(written).not.toContain(pair);
    }
  );
});

describe("a proxy that fails the check", () => {
  test("a monitor's own proxy that is down is the proxy's failure, never the target refusing the connection", async () => {
    restore = setProxyEnvironment({});
    const outcomes = await Promise.all(
      [config.url, "https://secure.example.test/"].map((url) =>
        runCheck(http({ proxy: deadProxyUrl(), url }), liveIo())
      )
    );
    for (const outcome of outcomes) {
      expect(outcome?.check.reason).toBe(reasons.proxy_failed);
      expect(outcome?.detail?.params).toEqual({ reason: "proxy_failed" });
    }
  });

  test("the install's proxy that is down is the proxy's failure too", async () => {
    restore = setProxyEnvironment({
      HTTP_PROXY: deadProxyUrl(),
      HTTPS_PROXY: deadProxyUrl(),
    });
    const outcomes = await Promise.all(
      [config.url, "https://secure.example.test/"].map((url) =>
        runCheck(http({ url }), liveIo())
      )
    );
    for (const outcome of outcomes) {
      expect(outcome?.detail?.params).toEqual({ reason: "proxy_failed" });
    }
  });

  test("a proxy whose name does not resolve is the proxy's failure, not the target's DNS", async () => {
    restore = setProxyEnvironment({});
    const outcome = await runCheck(
      http({ proxy: "http://proxy.example.invalid:3128" }),
      liveIo()
    );
    expect(outcome?.detail?.params).toEqual({ reason: "proxy_failed" });
  });

  test("a tunnel the proxy refuses is the proxy's failure with its status, never unknown", async () => {
    const own = proxy();
    restore = setProxyEnvironment({});
    const outcome = await runCheck(
      http({ proxy: own.url, url: "https://secure.example.test/" }),
      liveIo()
    );
    expect(outcome?.check.reason).toBe(reasons.proxy_failed);
    expect(outcome?.detail?.params).toEqual({
      reason: "proxy_failed",
      status: 502,
    });
  });

  test("a plain http request the proxy answers with 407 is the proxy asking for its sign-in, not the target's status", async () => {
    const own = proxy(() => ({ status: 407 }));
    restore = setProxyEnvironment({});
    const outcome = await runCheck(http({ proxy: own.url }), liveIo());
    expect(outcome?.check.result).toBe("down");
    expect(outcome?.check.statusCode).toBe(407);
    expect(outcome?.detail?.params).toEqual({
      reason: "proxy_failed",
      status: 407,
    });
  });

  test("a 407 from a target reached with no proxy between is the target's own status", async () => {
    const server = Bun.serve({
      fetch: () => new Response("sign in", { status: 407 }),
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    restore = setProxyEnvironment({});
    const outcome = await runCheck(
      http({ url: `http://127.0.0.1:${server.port}/` }),
      liveIo()
    );
    expect(outcome?.detail?.params).toMatchObject({
      observed: 407,
      reason: "unexpected_status",
    });
  });

  test("a plain http request the proxy answers with another error status is that status, since a proxy relays the target's own", async () => {
    const own = proxy(() => ({ status: 502 }));
    restore = setProxyEnvironment({});
    const outcome = await runCheck(http({ proxy: own.url }), liveIo());
    expect(outcome?.detail?.params).toMatchObject({
      observed: 502,
      reason: "unexpected_status",
    });
  });

  test("a target NO_PROXY sends direct that refuses the connection is still the target's refusal, the install's proxy down or not", async () => {
    const closed = new URL(deadProxyUrl());
    restore = setProxyEnvironment({
      HTTP_PROXY: deadProxyUrl(),
      NO_PROXY: "127.0.0.1",
    });
    const outcome = await runCheck(
      http({ url: `http://127.0.0.1:${closed.port}/` }),
      liveIo()
    );
    expect(outcome?.detail?.params).toEqual({
      host: "127.0.0.1",
      port: Number(closed.port),
      reason: "connection_refused",
    });
  });

  test("a redirect to a host NO_PROXY sends direct is judged by that hop: its refusal is the target's", async () => {
    const closed = new URL(deadProxyUrl());
    const own = proxy(() => ({
      headers: { location: `http://127.0.0.1:${closed.port}/` },
      status: 302,
    }));
    restore = setProxyEnvironment({
      HTTP_PROXY: own.url,
      NO_PROXY: "127.0.0.1",
    });
    const outcome = await runCheck(http(), liveIo());
    expect(outcome?.detail?.params).toMatchObject({
      reason: "connection_refused",
    });
  });
});

describe("the proxy a request goes through", () => {
  const url = new URL("https://web.example.test/health");
  const plain = new URL("http://web.example.test/health");

  test("is the monitor's own when it has one, whatever the environment and NO_PROXY say", () => {
    expect(
      proxyFor(url, "http://own.example.test:3128", {
        HTTPS_PROXY: "http://install.example.test:3128",
        NO_PROXY: "*",
      })
    ).toBe("http://own.example.test:3128");
  });

  test("is the environment's for the URL's scheme, either case, then ALL_PROXY", () => {
    const env = {
      HTTP_PROXY: "http://plain.example.test",
      https_proxy: "http://secure.example.test",
    };
    expect(proxyFor(url, undefined, env)).toBe("http://secure.example.test");
    expect(proxyFor(plain, undefined, env)).toBe("http://plain.example.test");
    expect(
      proxyFor(url, undefined, { all_proxy: "http://all.example.test" })
    ).toBe("http://all.example.test");
    expect(
      proxyFor(plain, undefined, { ALL_PROXY: "http://all.example.test" })
    ).toBe("http://all.example.test");
  });

  test("is nothing for a host NO_PROXY exempts, or with no proxy set", () => {
    const env = {
      HTTPS_PROXY: "http://secure.example.test",
      no_proxy: ".example.test",
    };
    expect(proxyFor(url, undefined, env)).toBeUndefined();
    expect(proxyFor(url, undefined, {})).toBeUndefined();
    expect(proxyFor(url, undefined, { HTTPS_PROXY: "" })).toBeUndefined();
  });

  test("reads NO_PROXY as the runtime does: any case, a leading `*.`, a port that must match, an address range", () => {
    const through = (noProxy: string, address: string) =>
      proxyFor(new URL(address), undefined, {
        HTTP_PROXY: "http://install.example.test",
        HTTPS_PROXY: "http://install.example.test",
        NO_PROXY: noProxy,
      }) !== undefined;
    expect(through("EXAMPLE.test", "http://web.example.test/")).toBe(false);
    expect(through("*.example.test", "http://example.test/")).toBe(false);
    expect(through("xample.test", "http://example.test/")).toBe(true);
    expect(through("example.test:8080", "http://example.test:8080/")).toBe(
      false
    );
    expect(through("example.test:8080", "http://example.test/")).toBe(true);
    expect(through("example.test:443", "https://example.test/")).toBe(false);
    expect(through("10.0.0.0/8", "http://10.1.2.3/")).toBe(false);
    expect(through("10.0.0.0/8", "http://11.1.2.3/")).toBe(true);
    expect(through("::1", "http://[::1]:8080/")).toBe(false);
    expect(through("[::1]:8080", "http://[::1]:8080/")).toBe(false);
    expect(through("fd00::/8", "http://[fd12::1]/")).toBe(false);
    expect(through("a.test example.test", "http://example.test/")).toBe(false);
    expect(through("*", "http://anything.test/")).toBe(false);
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

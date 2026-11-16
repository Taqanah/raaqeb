import { afterEach, describe, expect, test } from "bun:test";
import type { HttpConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { credentialMask } from "./capture.ts";
import { type CheckIo, type HttpMonitor, runHttpCheck } from "./http.ts";
import {
  type FakeApi,
  type FakeTokenServer,
  startApi,
  startTokenServer,
  tokenJson,
} from "./oauth-fixture.ts";
import { createTokenCache } from "./oauth2.ts";
import { startProxy } from "./proxy-fixture.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
});

function tokenEndpoint(...answers: Parameters<typeof startTokenServer>[0]) {
  const server = startTokenServer(answers);
  stops.push(server.stop);
  return server;
}

function api(options?: Parameters<typeof startApi>[0]) {
  const server = startApi(options);
  stops.push(server.stop);
  return server;
}

const secret = "client-secret-9";

function monitor(
  endpoint: FakeTokenServer,
  target: FakeApi,
  config: Partial<HttpConfig> = {}
): HttpMonitor {
  return {
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "always",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: target.url,
      ...config,
    },
    credentials: {
      auth: {
        clientId: "raaqeb",
        clientSecret: secret,
        kind: "oauth2",
        method: "basic",
        tokenUrl: endpoint.url,
      },
      headers: [{ name: "Authorization", value: "Bearer custom-one" }],
    },
    degradedMs: undefined,
    id: "m1",
    retries: 0,
    timeoutMs: 3000,
  };
}

function live(cache = createTokenCache()): {
  advance: (ms: number) => void;
  io: CheckIo;
} {
  const state = { at: Date.now() };
  return {
    advance: (ms) => {
      state.at += ms;
    },
    io: {
      fetch,
      now: () => state.at,
      sleep: () => Promise.resolve(),
      tokens: cache,
    },
  };
}

describe("an HTTP check with OAuth 2.0 client credentials", () => {
  test("asks the token endpoint, calls the target with the token as a bearer, and the OAuth Authorization wins over a custom header", async () => {
    const endpoint = tokenEndpoint({ body: tokenJson("tok-one") });
    const target = api();
    const { io } = live();
    const outcome = await runHttpCheck(monitor(endpoint, target), io);
    expect(outcome.check.result).toBe("up");
    expect(target.authorizations).toEqual(["Bearer tok-one"]);
    expect(endpoint.calls).toHaveLength(1);
  });

  test("keeps the token between checks, and asks again once it is near its expiry", async () => {
    const endpoint = tokenEndpoint(
      { body: tokenJson("tok-one", { expires_in: 600 }) },
      { body: tokenJson("tok-two", { expires_in: 600 }) }
    );
    const target = api();
    const { advance, io } = live();
    const m = monitor(endpoint, target);
    await runHttpCheck(m, io);
    await runHttpCheck(m, io);
    expect(endpoint.calls).toHaveLength(1);
    advance(560_000);
    await runHttpCheck(m, io);
    expect(endpoint.calls).toHaveLength(2);
    expect(target.authorizations).toEqual([
      "Bearer tok-one",
      "Bearer tok-one",
      "Bearer tok-two",
    ]);
  });

  test("forgets a kept token the target refused with 401, so the next check asks for another; a fresh token's 401 is not the token's fault", async () => {
    const endpoint = tokenEndpoint(
      { body: tokenJson("tok-old") },
      { body: tokenJson("tok-new") }
    );
    const state = { status: 200 };
    const target = api({ status: () => state.status });
    const { io } = live();
    const m = monitor(endpoint, target);
    expect((await runHttpCheck(m, io)).check.result).toBe("up");
    state.status = 401;
    expect((await runHttpCheck(m, io)).check.reason).toBe(
      reasons.unexpected_status
    );
    state.status = 200;
    expect((await runHttpCheck(m, io)).check.result).toBe("up");
    expect(target.authorizations).toEqual([
      "Bearer tok-old",
      "Bearer tok-old",
      "Bearer tok-new",
    ]);
    expect(endpoint.calls).toHaveLength(2);
  });

  test("keeps a fresh token the target refused, which only a kept one is judged by", async () => {
    const endpoint = tokenEndpoint({ body: tokenJson("tok-one") });
    const state = { status: 401 };
    const target = api({ status: () => state.status });
    const { io } = live();
    const m = monitor(endpoint, target);
    await runHttpCheck(m, io);
    state.status = 200;
    await runHttpCheck(m, io);
    expect(endpoint.calls).toHaveLength(1);
  });

  test("a token endpoint that refuses is its own reason with its status and error, and the target is never called", async () => {
    const endpoint = tokenEndpoint({
      body: JSON.stringify({ error: "invalid_client" }),
      status: 401,
    });
    const target = api();
    const { io } = live();
    const outcome = await runHttpCheck(monitor(endpoint, target), io);
    expect(outcome.check.result).toBe("down");
    expect(outcome.check.reason).toBe(reasons.oauth2_token_failed);
    expect(outcome.detail?.params).toEqual({
      code: "invalid_client",
      reason: "oauth2_token_failed",
      status: 401,
    });
    expect(target.authorizations).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  test("a token endpoint nothing answers is the same reason with no status", async () => {
    const endpoint = tokenEndpoint({});
    endpoint.stop();
    const target = api();
    const { io } = live();
    const outcome = await runHttpCheck(monitor(endpoint, target), io);
    expect(outcome.check.reason).toBe(reasons.oauth2_token_failed);
    expect(outcome.detail?.params).toEqual({ reason: "oauth2_token_failed" });
  });

  test("a token endpoint that is too slow is the attempt's timeout, not a token failure", async () => {
    const slow = Bun.serve({
      fetch: async () => {
        await Bun.sleep(1500);
        return new Response(tokenJson("late"));
      },
      port: 0,
    });
    stops.push(() => slow.stop(true));
    const target = api();
    const { io } = live();
    const outcome = await runHttpCheck(
      {
        ...monitor(
          { url: `http://127.0.0.1:${slow.port}/` } as FakeTokenServer,
          target
        ),
        timeoutMs: 300,
      },
      io
    );
    expect(outcome.check.reason).toBe(reasons.timeout);
    expect(target.authorizations).toEqual([]);
  });

  test("an endpoint that answers with the client secret as its error code puts it nowhere in the outcome", async () => {
    const endpoint = tokenEndpoint({
      body: JSON.stringify({ error: secret }),
      status: 401,
    });
    const target = api();
    const { io } = live();
    const outcome = await runHttpCheck(monitor(endpoint, target), io);
    expect(outcome.check.reason).toBe(reasons.oauth2_token_failed);
    expect(outcome.detail?.params).toEqual({
      reason: "oauth2_token_failed",
      status: 401,
    });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  test("never writes the token or the client secret into the outcome, a capture of a response that echoes them included", async () => {
    const endpoint = tokenEndpoint({ body: tokenJson("tok-secret-xyz") });
    const target = api({ echo: true });
    const { io } = live();
    const outcome = await runHttpCheck(monitor(endpoint, target), io);
    const body = new TextDecoder().decode(outcome.capture?.body);
    expect(body).toBe(`you sent Bearer ${credentialMask}`);
    const written = JSON.stringify(outcome);
    expect(written).not.toContain("tok-secret-xyz");
    expect(written).not.toContain(secret);
  });

  test("masks the client ID and the client secret wherever the target's answer repeats them, but not a client ID too short to be told from a word", async () => {
    const endpoint = tokenEndpoint({ body: tokenJson("tok-x") });
    const target = api({
      body: `id raaqeb-client-id-0042 secret ${secret} word raaqeb`,
    });
    const { io } = live();
    const long = monitor(endpoint, target);
    const withLongId: HttpMonitor = {
      ...long,
      credentials: {
        ...long.credentials,
        auth: {
          clientId: "raaqeb-client-id-0042",
          clientSecret: secret,
          kind: "oauth2",
          method: "basic",
          tokenUrl: endpoint.url,
        },
        headers: [],
      },
    };
    const outcome = await runHttpCheck(withLongId, io);
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(
      `id ${credentialMask} secret ${credentialMask} word raaqeb`
    );
  });

  test("masks a client ID of eight characters, the shortest it masks", async () => {
    const endpoint = tokenEndpoint({ body: tokenJson("tok-z") });
    const target = api({ body: "id raaqeb-8" });
    const base = monitor(endpoint, target);
    const outcome = await runHttpCheck(
      {
        ...base,
        credentials: {
          auth: {
            clientId: "raaqeb-8",
            clientSecret: secret,
            kind: "oauth2",
            method: "basic",
            tokenUrl: endpoint.url,
          },
          headers: [],
        },
      },
      live().io
    );
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(
      `id ${credentialMask}`
    );
  });

  test("masks the client secret as typed and as form-encoded, and leaves a short client ID alone", async () => {
    const odd = "p@ss word+9";
    const endpoint = tokenEndpoint({ body: tokenJson("tok-y") });
    const target = api({
      body: `plain ${odd} encoded ${encodeURIComponent(odd)} id raaqeb`,
    });
    const { io } = live();
    const base = monitor(endpoint, target);
    const outcome = await runHttpCheck(
      {
        ...base,
        credentials: {
          auth: {
            clientId: "raaqeb",
            clientSecret: odd,
            kind: "oauth2",
            method: "basic",
            tokenUrl: endpoint.url,
          },
          headers: [],
        },
      },
      io
    );
    expect(new TextDecoder().decode(outcome.capture?.body)).toBe(
      `plain ${credentialMask} encoded ${credentialMask} id raaqeb`
    );
  });

  test("a token endpoint whose certificate does not verify gets no secret, unless the monitor ignores TLS errors", async () => {
    const asked: string[] = [];
    const endpoint = Bun.serve({
      fetch: (request) => {
        asked.push(request.headers.get("authorization") ?? "");
        return new Response(tokenJson("tok-tls"));
      },
      port: 0,
      tls: {
        cert: Bun.file(`${import.meta.dir}/fixtures/tls-cert.pem`),
        key: Bun.file(`${import.meta.dir}/fixtures/tls-key.pem`),
      },
    });
    stops.push(() => endpoint.stop(true));
    const target = api();
    const tokenUrl = { url: `https://127.0.0.1:${endpoint.port}/token` };
    const verified = await runHttpCheck(
      monitor(tokenUrl as FakeTokenServer, target),
      live().io
    );
    expect(verified.check.reason).toBe(reasons.oauth2_token_failed);
    expect(asked).toEqual([]);
    const ignored = await runHttpCheck(
      monitor(tokenUrl as FakeTokenServer, target, { ignoreTlsErrors: true }),
      live().io
    );
    expect(ignored.check.result).toBe("up");
    expect(target.authorizations).toEqual(["Bearer tok-tls"]);
  });

  test("an unreadable token request reads through the monitor's own proxy, as its checks do", async () => {
    const seen = startProxy(() => ({ status: 200 }));
    stops.push(seen.stop);
    const target = api();
    const { io } = live();
    await runHttpCheck(
      monitor(
        { url: "http://token.proxied.test/token" } as FakeTokenServer,
        target,
        { proxy: seen.url }
      ),
      io
    );
    expect(seen.requests.map((request) => request.line)).toContain(
      "POST http://token.proxied.test/token HTTP/1.1"
    );
  });
});

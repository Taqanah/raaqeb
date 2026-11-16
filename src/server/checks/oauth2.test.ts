import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeTokenServer,
  startTokenServer,
  tokenJson,
} from "./oauth-fixture.ts";
import {
  createTokenCache,
  dropToken,
  type OAuth2Grant,
  tokenBodyMaxBytes,
  tokenFor,
  tokenLifetimeDefaultMs,
  tokenLifetimeMaxMs,
  tokenRefreshMarginMs,
} from "./oauth2.ts";

const servers: FakeTokenServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

function endpoint(...answers: Parameters<typeof startTokenServer>[0]) {
  const server = startTokenServer(answers);
  servers.push(server);
  return server;
}

const grant = (server: { url: string }, over: Partial<OAuth2Grant> = {}) =>
  ({
    clientId: "my client",
    clientSecret: "s:e/c+ret=",
    kind: "oauth2",
    method: "basic",
    tokenUrl: server.url,
    ...over,
  }) as OAuth2Grant;

/** A clock the test moves. */
function clock(start = 1_700_000_000_000) {
  const state = { at: start };
  return {
    advance: (ms: number) => {
      state.at += ms;
    },
    now: () => state.at,
  };
}

const signal = () => AbortSignal.timeout(5000);

function ask(
  server: FakeTokenServer,
  options: {
    cache?: ReturnType<typeof createTokenCache>;
    grant?: Partial<OAuth2Grant>;
    monitorId?: string;
    now?: () => number;
  } = {}
) {
  return tokenFor({
    cache: options.cache,
    fetch,
    grant: grant(server, options.grant),
    monitorId: options.monitorId ?? "m1",
    now: options.now ?? Date.now,
    signal: signal(),
  });
}

describe("the token request", () => {
  test("by HTTP basic carries the client ID and secret, each form-encoded, as the Authorization and asks for the client credentials grant", async () => {
    const server = endpoint({});
    await ask(server);
    const [call] = server.calls;
    expect(call?.method).toBe("POST");
    expect(call?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(call?.headers.accept).toBe("application/json");
    const pair = `${encodeURIComponent("my client")}:${encodeURIComponent("s:e/c+ret=")}`;
    expect(call?.headers.authorization).toBe(
      `Basic ${new TextEncoder().encode(pair).toBase64()}`
    );
    expect(new URLSearchParams(call?.body).get("grant_type")).toBe(
      "client_credentials"
    );
    expect(call?.body).not.toContain("client_secret");
    expect(call?.body).not.toContain("client_id");
  });

  test("by body carries them as fields and no Authorization", async () => {
    const server = endpoint({});
    await ask(server, { grant: { method: "body" } });
    const [call] = server.calls;
    const fields = new URLSearchParams(call?.body);
    expect(fields.get("client_id")).toBe("my client");
    expect(fields.get("client_secret")).toBe("s:e/c+ret=");
    expect(call?.headers.authorization).toBeUndefined();
  });

  test("sends the scope and the audience when the grant has them, and neither when it has none", async () => {
    const server = endpoint({});
    await ask(server, {
      grant: { audience: "https://api.example.test", scope: "read write" },
    });
    await ask(server, { monitorId: "m2" });
    const [withBoth, without] = server.calls.map(
      (call) => new URLSearchParams(call.body)
    );
    expect(withBoth?.get("scope")).toBe("read write");
    expect(withBoth?.get("audience")).toBe("https://api.example.test");
    expect(without?.has("scope")).toBe(false);
    expect(without?.has("audience")).toBe(false);
  });

  test("does not follow a redirect, which would carry the secret to another address", async () => {
    const other = endpoint({});
    const server = endpoint({
      headers: { location: other.url },
      status: 302,
    });
    const result = await ask(server);
    expect(result).toMatchObject({ ok: false, status: 302 });
    expect(other.calls).toHaveLength(0);
  });
});

describe("the token as the endpoint answers it", () => {
  test("is the access token of a bearer answer, whatever the case of its type", async () => {
    const server = endpoint(
      { body: tokenJson("one", { token_type: "bearer" }) },
      { body: tokenJson("two", { token_type: "BEARER" }) }
    );
    expect(await ask(server, { monitorId: "a" })).toEqual({
      cached: false,
      ok: true,
      token: "one",
    });
    expect(await ask(server, { monitorId: "b" })).toMatchObject({
      ok: true,
      token: "two",
    });
  });

  test("is as long as a header carries and no longer", async () => {
    const server = endpoint(
      { body: tokenJson("x".repeat(8192)) },
      { body: tokenJson("x".repeat(8193)) }
    );
    expect(await ask(server, { monitorId: "a" })).toMatchObject({ ok: true });
    expect(await ask(server, { monitorId: "b" })).toMatchObject({
      ok: false,
      status: 200,
    });
  });

  test("is no token when the answer has none, names another type, or holds one a header cannot carry", async () => {
    for (const body of [
      JSON.stringify({ expires_in: 60 }),
      JSON.stringify({ access_token: "", token_type: "Bearer" }),
      tokenJson("t", { token_type: "mac" }),
      tokenJson("two\nlines"),
      "not json",
      "[]",
    ]) {
      const server = endpoint({ body });
      // biome-ignore lint/performance/noAwaitInLoops: one endpoint after the other
      const result = await ask(server);
      expect(result, body.slice(0, 40)).toMatchObject({
        code: undefined,
        ok: false,
        status: 200,
      });
    }
  });

  test("is refused with the endpoint's status and the error it named, when it reads as a code", async () => {
    const server = endpoint({
      body: JSON.stringify({ error: "invalid_client" }),
      status: 401,
    });
    expect(await ask(server)).toEqual({
      code: "invalid_client",
      error: expect.stringContaining("401"),
      ok: false,
      status: 401,
    });
  });

  test("names only the codes RFC 6749 section 5.2 and the common ones give, so an endpoint can put nothing else in a failure", async () => {
    for (const code of [
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
      "access_denied",
      "server_error",
      "temporarily_unavailable",
    ]) {
      const server = endpoint({
        body: JSON.stringify({ error: code }),
        status: 400,
      });
      // biome-ignore lint/performance/noAwaitInLoops: one endpoint after the other
      expect(await ask(server), code).toMatchObject({ code, status: 400 });
    }
  });

  test("keeps a status alone when the error is not a code, so no text of the endpoint's is shown", async () => {
    for (const error of ["client_secret=abc", 7]) {
      const server = endpoint({ body: JSON.stringify({ error }), status: 400 });
      // biome-ignore lint/performance/noAwaitInLoops: one endpoint after the other
      expect(await ask(server)).toMatchObject({
        code: undefined,
        status: 400,
      });
    }
    const down = endpoint({ body: "<html>boom</html>", status: 502 });
    expect(await ask(down)).toMatchObject({ code: undefined, status: 502 });
  });

  test("never repeats the client secret in the failure's sentence, even when the endpoint echoes it", async () => {
    const server = endpoint({
      body: JSON.stringify({
        error: "invalid_client",
        error_description: "bad secret s:e/c+ret=",
      }),
      status: 401,
    });
    const result = await ask(server);
    expect(JSON.stringify(result)).not.toContain("s:e/c+ret=");
  });

  test("is a failure with no status when nothing answers", async () => {
    const server = endpoint({});
    server.stop();
    const result = await ask(server);
    expect(result).toMatchObject({ ok: false, status: undefined });
  });

  test("reads at most the bytes it allows of a huge answer", async () => {
    const server = endpoint({
      body: `{"access_token":"${"a".repeat(tokenBodyMaxBytes * 4)}"}`,
    });
    expect(await ask(server)).toMatchObject({ ok: false, status: 200 });
  });

  test("lets an attempt's timeout through: the signal ending is thrown, not a token failure", async () => {
    const server = endpoint({});
    const ended = AbortSignal.timeout(1);
    await Bun.sleep(5);
    await expect(
      tokenFor({
        cache: undefined,
        fetch,
        grant: grant(server),
        monitorId: "m1",
        now: Date.now,
        signal: ended,
      })
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("the token kept in memory", () => {
  test("is reused while it has more than its refresh margin left, one request for many attempts", async () => {
    const server = endpoint({ body: tokenJson("one", { expires_in: 3600 }) });
    const cache = createTokenCache();
    const time = clock();
    const options = { cache, now: time.now };
    expect(await ask(server, options)).toMatchObject({
      cached: false,
      ok: true,
    });
    time.advance(3_600_000 - tokenRefreshMarginMs - 1000);
    expect(await ask(server, options)).toEqual({
      cached: true,
      ok: true,
      token: "one",
    });
    expect(server.calls).toHaveLength(1);
  });

  test("is renewed once it is within the margin of its expiry", async () => {
    const server = endpoint(
      { body: tokenJson("one", { expires_in: 3600 }) },
      { body: tokenJson("two", { expires_in: 3600 }) }
    );
    const cache = createTokenCache();
    const time = clock();
    const options = { cache, now: time.now };
    await ask(server, options);
    time.advance(3_600_000 - tokenRefreshMarginMs);
    expect(await ask(server, options)).toEqual({
      cached: false,
      ok: true,
      token: "two",
    });
    expect(server.calls).toHaveLength(2);
  });

  test("a short lifetime is renewed a tenth before its end, not a whole margin, which would be before it began", async () => {
    const server = endpoint(
      { body: tokenJson("one", { expires_in: 100 }) },
      { body: tokenJson("two", { expires_in: 100 }) }
    );
    const cache = createTokenCache();
    const time = clock();
    const options = { cache, now: time.now };
    await ask(server, options);
    time.advance(89_000);
    expect(await ask(server, options)).toMatchObject({ cached: true });
    time.advance(1000);
    expect(await ask(server, options)).toMatchObject({
      cached: false,
      token: "two",
    });
  });

  test("lives the default time when the endpoint names none or one that is no number, an answer in text counts, and no lifetime is kept past the maximum", async () => {
    const none = endpoint(
      { body: JSON.stringify({ access_token: "one", token_type: "Bearer" }) },
      { body: tokenJson("two") }
    );
    const cache = createTokenCache();
    const time = clock();
    await ask(none, { cache, now: time.now });
    time.advance(tokenLifetimeDefaultMs - tokenLifetimeDefaultMs / 10 - 1000);
    expect(await ask(none, { cache, now: time.now })).toMatchObject({
      cached: true,
    });
    time.advance(1000);
    expect(await ask(none, { cache, now: time.now })).toMatchObject({
      cached: false,
    });

    const unreadable = endpoint({
      body: tokenJson("u", { expires_in: "soon" }),
    });
    const unreadableCache = createTokenCache();
    const unreadableTime = clock();
    await ask(unreadable, { cache: unreadableCache, now: unreadableTime.now });
    unreadableTime.advance(tokenLifetimeDefaultMs / 2);
    expect(
      await ask(unreadable, { cache: unreadableCache, now: unreadableTime.now })
    ).toMatchObject({ cached: true });

    const text = endpoint({ body: tokenJson("t", { expires_in: "7200" }) });
    const textCache = createTokenCache();
    const textTime = clock();
    await ask(text, { cache: textCache, now: textTime.now });
    textTime.advance(7_200_000 - tokenRefreshMarginMs - 1000);
    expect(
      await ask(text, { cache: textCache, now: textTime.now })
    ).toMatchObject({ cached: true });

    const long = endpoint(
      { body: tokenJson("a", { expires_in: 10 ** 9 }) },
      { body: tokenJson("b") }
    );
    const longCache = createTokenCache();
    const longTime = clock();
    await ask(long, { cache: longCache, now: longTime.now });
    longTime.advance(tokenLifetimeMaxMs - tokenRefreshMarginMs);
    expect(
      await ask(long, { cache: longCache, now: longTime.now })
    ).toMatchObject({ cached: false });
  });

  test("a lifetime of zero or less is used once and never kept", async () => {
    const server = endpoint({ body: tokenJson("t", { expires_in: 0 }) });
    const cache = createTokenCache();
    await ask(server, { cache });
    await ask(server, { cache });
    expect(server.calls).toHaveLength(2);
  });

  test("lives from the moment it was asked for, not from the moment a slow answer arrived", async () => {
    // A lifetime of one second, renewed a tenth before its end, answered 400 ms after it was asked for.
    const time = clock();
    const asked = time.now();
    const slow = ((): Promise<Response> => {
      time.advance(400);
      return Promise.resolve(
        new Response(tokenJson("slow", { expires_in: 1 }))
      );
    }) as unknown as typeof fetch;
    const request = {
      cache: createTokenCache(),
      fetch: slow,
      grant: grant({ url: "http://token.example.test/token" }),
      monitorId: "m1",
      now: time.now,
      signal: signal(),
    };
    await tokenFor(request);
    // 900 ms after it was asked for is its renewal; 950 ms is after, though only 550 ms after the answer.
    time.advance(asked + 950 - time.now());
    expect(await tokenFor(request)).toMatchObject({ cached: false });
  });

  test("drops the expired tokens of other monitors when any token is read, so a deleted monitor's does not stay", async () => {
    const server = endpoint(
      { body: tokenJson("short", { expires_in: 100 }) },
      { body: tokenJson("short", { expires_in: 100 }) },
      { body: tokenJson("long", { expires_in: 86_400 }) }
    );
    const cache = createTokenCache();
    const time = clock();
    await ask(server, { cache, monitorId: "a", now: time.now });
    await ask(server, { cache, monitorId: "b", now: time.now });
    await ask(server, { cache, monitorId: "c", now: time.now });
    expect(cache.tokens.size).toBe(3);
    time.advance(200_000);
    // A hit on the long one is a read, and the two short ones are gone.
    expect(
      await ask(server, { cache, monitorId: "c", now: time.now })
    ).toMatchObject({
      cached: true,
    });
    expect([...cache.tokens.keys()]).toEqual(["c"]);
  });

  test("is one per monitor, and a changed grant is a new one", async () => {
    const server = endpoint(
      { body: tokenJson("one") },
      { body: tokenJson("two") },
      { body: tokenJson("three") }
    );
    const cache = createTokenCache();
    expect(await ask(server, { cache, monitorId: "a" })).toMatchObject({
      token: "one",
    });
    expect(await ask(server, { cache, monitorId: "b" })).toMatchObject({
      cached: false,
      token: "two",
    });
    expect(await ask(server, { cache, monitorId: "a" })).toMatchObject({
      cached: true,
      token: "one",
    });
    for (const changed of [
      { clientSecret: "another" },
      { scope: "write" },
      { audience: "api" },
      { clientId: "other" },
      { method: "body" as const },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one change after the other
      const result = await ask(server, {
        cache,
        grant: changed,
        monitorId: "a",
      });
      expect(result, JSON.stringify(Object.keys(changed))).toMatchObject({
        cached: false,
      });
      // Back to the first grant, which is now another's token to renew.
      await ask(server, { cache, monitorId: "a" });
    }
  });

  test("is forgotten by dropToken, and a token that failed is never kept", async () => {
    const server = endpoint(
      { body: tokenJson("one") },
      { body: JSON.stringify({ error: "invalid_client" }), status: 401 },
      { body: tokenJson("three") }
    );
    const cache = createTokenCache();
    await ask(server, { cache });
    dropToken(cache, "m1");
    expect(await ask(server, { cache })).toMatchObject({ ok: false });
    expect(await ask(server, { cache })).toMatchObject({
      cached: false,
      ok: true,
      token: "three",
    });
    dropToken(undefined, "m1");
  });

  test("with no cache asks the endpoint every time", async () => {
    const server = endpoint({});
    await ask(server);
    await ask(server);
    expect(server.calls).toHaveLength(2);
  });

  test("attempts at the same moment share one request", async () => {
    const server = endpoint({});
    const cache = createTokenCache();
    const [first, second] = await Promise.all([
      ask(server, { cache }),
      ask(server, { cache }),
    ]);
    expect(server.calls).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, token: "token-1" });
    expect(second).toMatchObject({ ok: true, token: "token-1" });
  });
});

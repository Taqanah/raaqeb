/**
 * The outbound proxy (CONTEXT.md "Outbound proxy") on the notification
 * channels' real sends: every channel that posts over HTTP goes through the
 * install's proxy environment, a subscriber's pinned webhook is judged by the
 * address it was pinned to, and an SMTP send never goes through it. A recording
 * proxy and the platform's `fetch`; Bun reads the variables at each request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  deadProxyUrl,
  setProxyEnvironment,
  startProxy,
  type TestProxy,
} from "@/server/checks/proxy-fixture.ts";
import type { ChannelType } from "@/shared/schemas/channel.ts";
import { attempt, type DeliverIo, deliver } from "./channel.ts";
import { sampleDown, sampleSend } from "./fixture.ts";
import { notificationChannels } from "./registry.ts";

const live: DeliverIo = { fetch, now: Date.now };

let seen: TestProxy | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  seen?.stop();
  seen = undefined;
});

function through(
  variables: "HTTP_PROXY" | "HTTPS_PROXY",
  extra: Record<string, string> = {}
): TestProxy {
  seen = startProxy();
  restore = setProxyEnvironment({ [variables]: seen.url, ...extra });
  return seen;
}

const secret = `whsec_${new Uint8Array(32).toBase64()}`;

/** What each posting channel is configured with, and the proxy line its send makes. */
const channels: readonly {
  readonly line: string;
  readonly type: ChannelType;
  readonly values: Readonly<Record<string, string>>;
}[] = [
  {
    line: "POST http://hook.example.test:9000/hook HTTP/1.1",
    type: "webhook",
    values: { secret, url: "http://hook.example.test:9000/hook" },
  },
  {
    line: "CONNECT hooks.slack.example.test:443 HTTP/1.1",
    type: "slack",
    values: { url: "https://hooks.slack.example.test/services/T0/B0/X" },
  },
  {
    line: "CONNECT discord.example.test:443 HTTP/1.1",
    type: "discord",
    values: { url: "https://discord.example.test/api/webhooks/1/abc" },
  },
  {
    line: "CONNECT ntfy.example.test:443 HTTP/1.1",
    type: "ntfy",
    values: { server: "https://ntfy.example.test", topic: "raaqeb-topic-123" },
  },
  {
    line: "CONNECT api.telegram.org:443 HTTP/1.1",
    type: "telegram",
    values: {
      botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
      chatId: "42",
    },
  },
];

describe("a channel's send under the install's proxy environment", () => {
  for (const { line, type, values } of channels) {
    test(`${type} goes through the proxy`, async () => {
      const variable = line.startsWith("POST") ? "HTTP_PROXY" : "HTTPS_PROXY";
      const proxy = through(variable);
      await deliver(
        notificationChannels[type],
        values,
        sampleSend(sampleDown, "en"),
        live
      );
      expect(proxy.requests.map((request) => request.line)).toEqual([line]);
    });
  }

  test("a subscriber's webhook, pinned to the address it resolved to, is tunnelled to that address", async () => {
    const proxy = through("HTTPS_PROXY");
    await attempt(live, [], (transport) =>
      transport.post("https://hooks.subscriber.example.test/x", {
        address: "203.0.113.9",
        body: "{}",
        headers: {},
      })
    );
    expect(proxy.requests.map((request) => request.line)).toEqual([
      "CONNECT 203.0.113.9:443 HTTP/1.1",
    ]);
  });

  test("NO_PROXY is judged against that pinned address, so a host name there does not match and an address range does", async () => {
    const byName = through("HTTPS_PROXY", {
      NO_PROXY: "hooks.subscriber.example.test",
    });
    // Pinned to loopback on a closed port, so a send that goes direct is refused at once.
    const post = () =>
      attempt(live, [], (transport) =>
        transport.post("https://hooks.subscriber.example.test:1/x", {
          address: "127.0.0.1",
          body: "{}",
          headers: {},
        })
      );
    await post();
    expect(byName.requests.map((request) => request.line)).toEqual([
      "CONNECT 127.0.0.1:1 HTTP/1.1",
    ]);
    restore?.();
    restore = setProxyEnvironment({
      HTTPS_PROXY: byName.url,
      NO_PROXY: "127.0.0.0/8",
    });
    const direct = await post();
    expect(direct.ok).toBe(false);
    expect(byName.requests).toHaveLength(1);
    // Sent direct, its refusal is the destination's, not the proxy's.
    expect(!direct.ok && direct.failure.reason).toBe("connection_refused");
  });
});

describe("a channel's send the install's proxy fails", () => {
  const send = () =>
    deliver(
      notificationChannels.telegram,
      { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef", chatId: "42" },
      sampleSend(sampleDown, "en"),
      live
    );

  test("a tunnel the proxy refuses is the proxy's failure with its status, never unknown", async () => {
    through("HTTPS_PROXY");
    const outcome = await send();
    expect(outcome.ok || outcome.failure).toMatchObject({
      error: "Proxy refused to open a tunnel: 502 X",
      params: { reason: "proxy_failed", status: 502 },
      reason: "proxy_failed",
    });
  });

  test("a proxy that is down is the proxy's failure, never the destination refusing the connection", async () => {
    restore = setProxyEnvironment({ HTTPS_PROXY: deadProxyUrl() });
    const outcome = await send();
    expect(outcome.ok || outcome.failure).toMatchObject({
      params: { reason: "proxy_failed" },
      reason: "proxy_failed",
    });
  });

  test("a plain http webhook the proxy answers with 407 is the proxy asking for its sign-in", async () => {
    seen = startProxy(() => ({ status: 407 }));
    restore = setProxyEnvironment({ HTTP_PROXY: seen.url });
    const outcome = await deliver(
      notificationChannels.webhook,
      { secret, url: "http://hook.example.test:9000/hook" },
      sampleSend(sampleDown, "en"),
      live
    );
    expect(outcome.ok || outcome.failure).toMatchObject({
      params: { reason: "proxy_failed", status: 407 },
      reason: "proxy_failed",
    });
    // The proxy's own text is the error.
    expect(!outcome.ok && outcome.failure.error).toBe("ok");
  });

  test("a sign-in written into HTTP_PROXY that the proxy repeats in its refusal is not in the delivery failure, decoded or as written", async () => {
    const password = "env@pass-77";
    const pair = btoa(`ops:${password}`);
    seen = startProxy(() => ({
      body: `you sent Basic ${pair}, that is ops:${password} from ops:env%40pass-77`,
      status: 407,
    }));
    restore = setProxyEnvironment({
      HTTP_PROXY: seen.url.replace("//", "//ops:env%40pass-77@"),
    });
    const outcome = await deliver(
      notificationChannels.webhook,
      { secret, url: "http://hook.example.test:9000/hook" },
      sampleSend(sampleDown, "en"),
      live
    );
    expect(seen.requests[0]?.headers["proxy-authorization"]).toBe(
      `Basic ${pair}`
    );
    const error = outcome.ok ? "" : (outcome.failure.error ?? "");
    expect(error).toContain("you sent Basic");
    expect(error).not.toContain(pair);
    expect(error).not.toContain(password);
    expect(error).not.toContain("env%40pass-77");
  });

  test("a 407 from a destination reached with no proxy between is the destination's own status", async () => {
    const server = Bun.serve({
      fetch: () => new Response("", { status: 407 }),
      hostname: "127.0.0.1",
      port: 0,
    });
    restore = setProxyEnvironment({});
    const outcome = await attempt(live, [], (transport) =>
      transport.post(`http://127.0.0.1:${server.port}/hook`, {
        body: "{}",
        headers: {},
      })
    );
    server.stop(true);
    expect(outcome.ok || outcome.failure).toMatchObject({
      params: { observed: 407, reason: "unexpected_status" },
      reason: "unexpected_status",
    });
  });
});

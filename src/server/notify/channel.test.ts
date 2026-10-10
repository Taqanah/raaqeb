import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { webhookDeclaration } from "@/shared/schemas/channel.ts";
import { errorMaxLength } from "@/shared/schemas/check.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import {
  type ChannelPayload,
  type DeliverIo,
  deliver,
  type NotificationChannel,
  sendTimeoutMs,
} from "./channel.ts";
import { emailChannel } from "./email.ts";
import { fakeSmtp } from "./fixture.ts";
// biome-ignore lint/performance/noNamespaceImport: spyOn watches the SMTP send through its module object, to read the timeout the base gives it
import * as smtp from "./smtp.ts";

const notification: NotificationPayload = {
  data: { channel: { id: "c1", name: "Ops" } },
  timestamp: "2026-09-25T10:00:00.000Z",
  type: "channel.test",
};
const payload: ChannelPayload = {
  id: "n1",
  locale: "ar",
  notification,
  time: { calendar: "gregorian", clock: "24h", timeZone: "UTC" },
};

/** A channel that posts the body to its URL, as the webhook does, unsigned. */
const posting: NotificationChannel = {
  declaration: webhookDeclaration,
  generate: {},
  send: (config, sent, transport) =>
    transport.post(config.url ?? "", {
      body: JSON.stringify(sent.notification),
      headers: { "content-type": "application/json" },
    }),
};

/** Every request the receiver got, in order. */
const got: { body: string; method: string; type: string | null }[] = [];

/** A receiver whose answer each path chooses. */
const receiver: Bun.Server<undefined> = Bun.serve({
  fetch: async (request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    got.push({
      body: await request.text(),
      method: request.method,
      type: request.headers.get("content-type"),
    });
    if (pathname === "/ok") {
      return new Response("fine");
    }
    if (pathname === "/accepted") {
      return new Response(null, { status: 202 });
    }
    if (pathname === "/refused") {
      return new Response("invalid_token", { status: 403 });
    }
    if (pathname === "/empty") {
      return new Response(null, { status: 404 });
    }
    if (pathname === "/moved") {
      return Response.redirect(`${new URL(request.url).origin}/ok`, 302);
    }
    return new Response("broken", { status: 500 });
  },
  port: 0,
});
const receiverOrigin = `http://127.0.0.1:${receiver.port}`;
afterAll(() => receiver.stop(true));

const live: DeliverIo = { fetch, now: Date.now };

/** A fetch the test scripts; the cast is the test's own, as the check tests do. */
const scripted = (
  run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): DeliverIo => ({ fetch: run as typeof fetch, now: Date.now });

const at = (path: string) => ({ url: `${receiverOrigin}${path}` });

describe("one delivery through the channel base", () => {
  test("a 2xx answer is a sent notification, and the receiver got the channel's POST as the channel made it", async () => {
    got.length = 0;
    expect(await deliver(posting, at("/ok"), payload, live)).toEqual({
      ok: true,
    });
    expect(got).toEqual([
      {
        body: JSON.stringify(notification),
        method: "POST",
        type: "application/json",
      },
    ]);
    expect(await deliver(posting, at("/accepted"), payload, live)).toEqual({
      ok: true,
    });
  });

  test("an answer outside 2xx is a failed attempt with the unexpected status it saw", async () => {
    const outcome = await deliver(posting, at("/broken"), payload, live);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe("unexpected_status");
      expect(outcome.failure.params).toMatchObject({
        observed: 500,
        reason: "unexpected_status",
      });
    }
  });

  test("a redirect is not followed, so the body never lands at another address", async () => {
    let reached = 0;
    const counting = scripted((input, init) => {
      reached += 1;
      return fetch(input, init);
    });
    const outcome = await deliver(posting, at("/moved"), payload, counting);
    expect(reached).toBe(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.params).toMatchObject({ observed: 302 });
    }
  });

  test("a refused connection is a failed attempt naming the host and port", async () => {
    const outcome = await deliver(
      posting,
      { url: "http://127.0.0.1:1/hook" },
      payload,
      live
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe("connection_refused");
      expect(outcome.failure.params).toEqual({
        host: "127.0.0.1",
        port: 1,
        reason: "connection_refused",
      });
    }
  });

  test("an attempt gives up after the send timeout", async () => {
    const timeouts = spyOn(AbortSignal, "timeout");
    let signal: AbortSignal | undefined;
    const stalled = scripted((_input, init) => {
      signal = init?.signal ?? undefined;
      return Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError")
      );
    });
    const outcome = await deliver(posting, at("/ok"), payload, stalled);
    const { calls, results } = timeouts.mock;
    timeouts.mockRestore();
    expect(calls).toEqual([[sendTimeoutMs]]);
    expect(results.map((each) => each.value)).toEqual([signal]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toMatchObject({
        params: { reason: "timeout", timeoutMs: sendTimeoutMs },
        reason: "timeout",
      });
    }
  });

  test("a secret never appears in the recorded error, even when the driver's text repeats it", async () => {
    const url = "https://hooks.example.test/services/T0/B0/topsecrettoken";
    const leaky = scripted(() =>
      Promise.reject(
        Object.assign(new Error(`could not reach ${url}`), {
          code: "ECONNRESET",
        })
      )
    );
    const outcome = await deliver(
      posting,
      { secret: "whsec_abc", url },
      payload,
      leaky
    );
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("topsecrettoken");
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe("connection_failed");
    }
  });

  test("a send that throws something other than an Error is an unknown failure, and deliver never throws", async () => {
    const throwing: NotificationChannel = {
      ...posting,
      send: () => Promise.reject("nope"),
    };
    const outcome = await deliver(throwing, at("/ok"), payload, live);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe("unknown");
    }
    const synchronous: NotificationChannel = {
      ...posting,
      send: () => {
        throw new Error("synchronous");
      },
    };
    expect((await deliver(synchronous, at("/ok"), payload, live)).ok).toBe(
      false
    );
  });
});

describe("what a refused answer records", () => {
  test("the start of its body is the recorded error beside the status, so the receiver's reason shows", async () => {
    const outcome = await deliver(posting, at("/refused"), payload, live);
    expect(outcome).toEqual({
      failure: {
        error: "invalid_token",
        params: {
          expected: ["2xx"],
          observed: 403,
          reason: "unexpected_status",
        },
        reason: "unexpected_status",
      },
      ok: false,
    });
  });

  test("the body's surrounding white space is not kept, as ntfy ends its JSON with a line break", async () => {
    const answering = scripted(() =>
      Promise.resolve(
        new Response('{"code":40301,"http":403,"error":"forbidden"}\n', {
          status: 403,
        })
      )
    );
    const outcome = await deliver(posting, at("/ok"), payload, answering);
    expect(!outcome.ok && outcome.failure.error).toBe(
      '{"code":40301,"http":403,"error":"forbidden"}'
    );
  });

  test("an empty body records no error", async () => {
    const outcome = await deliver(posting, at("/empty"), payload, live);
    expect(!outcome.ok && outcome.failure.error).toBeUndefined();
    expect(!outcome.ok && outcome.failure.params).toMatchObject({
      observed: 404,
    });
  });

  test("a secret the body repeats is taken out", async () => {
    const url = "https://api.telegram.org/bot123:topsecrettoken/sendMessage";
    const echoing = scripted(() =>
      Promise.resolve(
        new Response(`{"ok":false,"description":"bad bot ${url}"}`, {
          status: 401,
        })
      )
    );
    const outcome = await deliver(posting, { url }, payload, echoing);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("topsecrettoken");
    expect(!outcome.ok && outcome.failure.error).toContain("bad bot");
  });

  test("a secret URL's query that the body repeats alone is taken out too", async () => {
    const url = "https://hooks.example.test/raaqeb?key=topsecretquery";
    const echoing = scripted(() =>
      Promise.resolve(
        new Response("refused ?key=topsecretquery", { status: 403 })
      )
    );
    const outcome = await deliver(posting, { url }, payload, echoing);
    expect(JSON.stringify(outcome)).not.toContain("topsecretquery");
    expect(!outcome.ok && outcome.failure.error).toContain("refused");
  });

  test("a secret the one-kilobyte cut splits is taken out too, since the body may echo it", async () => {
    const url =
      "https://hooks.slack.com/services/T0001/B0001/topsecrettoken0123456789";
    const copy = `${url} `;
    // Padding so the cut lands ten characters before the end of a copy.
    const pad = "p".repeat(
      (((1024 - (copy.length - 10)) % copy.length) + copy.length) % copy.length
    );
    const body = new TextEncoder().encode(pad + copy.repeat(40));
    const first = new TextDecoder().decode(body.subarray(0, 1024));
    expect(first).toEndWith(url.slice(0, copy.length - 10));
    let offset = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        controller.enqueue(body.subarray(offset, offset + 1024));
        offset += 1024;
      },
    });
    const echoing = scripted(() =>
      Promise.resolve(new Response(chunked, { status: 403 }))
    );
    const outcome = await deliver(posting, { url }, payload, echoing);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failure.error).toStartWith(pad);
    expect(JSON.stringify(outcome)).not.toContain("/services/");
  });

  test("a body is read no further than one kilobyte, and the error keeps the recorded error's length", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(256)));
      },
    });
    const flooding = scripted(() =>
      Promise.resolve(new Response(endless, { status: 500 }))
    );
    const outcome = await deliver(posting, at("/ok"), payload, flooding);
    expect(outcome.ok).toBe(false);
    expect(pulled).toBeLessThanOrEqual(1024 / 256 + 2);
    expect(!outcome.ok && outcome.failure.error).toBe(
      "x".repeat(errorMaxLength)
    );
  });
});

describe("what a failed delivery records", () => {
  const url = "https://hooks.example.test/services/T0/B0/topsecrettoken";

  test("a secret the driver repeats is taken out every time, and a value in clear stays", async () => {
    const withRoom: NotificationChannel = {
      ...posting,
      declaration: {
        ...webhookDeclaration,
        fields: [
          ...webhookDeclaration.fields,
          {
            kind: "text",
            label: "channel_field_url",
            name: "room",
            secret: false,
            value: z.string(),
          },
        ],
      },
    };
    const leaky = scripted(() =>
      Promise.reject(
        Object.assign(
          new Error(`${url} failed for room-ops, then ${url}, then ${url}`),
          {
            code: "ECONNRESET",
          }
        )
      )
    );
    const outcome = await deliver(
      withRoom,
      { room: "room-ops", url },
      payload,
      leaky
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.error).not.toContain("topsecrettoken");
      expect(outcome.failure.error).not.toContain(
        "hooks.example.test/services"
      );
      expect(outcome.failure.error).toContain("room-ops");
    }
  });

  test("a refused https URL with no port names port 443", async () => {
    const refusing = scripted(() =>
      Promise.reject(
        Object.assign(new Error("Unable to connect"), {
          code: "ConnectionRefused",
        })
      )
    );
    const outcome = await deliver(posting, { url }, payload, refusing);
    expect(!outcome.ok && outcome.failure.params).toEqual({
      host: "hooks.example.test",
      port: 443,
      reason: "connection_refused",
    });
  });
});

describe("one email delivery over SMTP through the channel base", () => {
  const values = (port: number) => ({
    from: "alerts@example.test",
    host: "127.0.0.1",
    port: String(port),
    security: "none",
    to: "ops@example.test",
  });

  test("a message the server accepts is a sent notification", async () => {
    const server = fakeSmtp();
    try {
      expect(
        await deliver(emailChannel, values(server.port), payload, live)
      ).toEqual({ ok: true });
      expect(server.messages.length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a refusal is a failed attempt with the reply code it saw and the server's text", async () => {
    const server = fakeSmtp({ replies: { RCPT: "550 5.1.1 no such user" } });
    try {
      const outcome = await deliver(
        emailChannel,
        values(server.port),
        payload,
        live
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure.reason).toBe("unexpected_status");
        expect(outcome.failure.params).toEqual({
          expected: ["2xx"],
          observed: 550,
          reason: "unexpected_status",
        });
        expect(outcome.failure.error).toContain("no such user");
      }
    } finally {
      server.stop();
    }
  });

  test("a refused connection is a failed attempt naming the SMTP server's host and port", async () => {
    const server = fakeSmtp();
    const { port } = server;
    server.stop();
    const outcome = await deliver(emailChannel, values(port), payload, live);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.params).toEqual({
        host: "127.0.0.1",
        port,
        reason: "connection_refused",
      });
    }
  });

  test("an SMTP attempt gets thirty seconds", async () => {
    const server = fakeSmtp();
    const sends = spyOn(smtp, "sendSmtp");
    try {
      expect(
        await deliver(emailChannel, values(server.port), payload, live)
      ).toEqual({ ok: true });
      expect(sends.mock.calls.map((call) => call[2])).toEqual([30_000]);
    } finally {
      sends.mockRestore();
      server.stop();
    }
  });
});

describe("one send over the platform, without a channel", () => {
  test("answers the failure with its reason and every secret taken out of the text", async () => {
    const { attempt } = await import("./channel.ts");
    const outcome = await attempt(
      {
        fetch: Object.assign(
          () =>
            Promise.resolve(new Response("bad key hunter2", { status: 401 })),
          { preconnect: () => undefined }
        ),
        now: () => 0,
      },
      ["hunter2"],
      (transport) =>
        transport.post("https://api.example.com/send", {
          body: "{}",
          headers: {},
        })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe("unexpected_status");
      expect(outcome.failure.error ?? "").not.toContain("hunter2");
    }
  });

  test("answers ok when the send resolves", async () => {
    const { attempt } = await import("./channel.ts");
    expect(
      await attempt({ fetch, now: () => 0 }, [], () => Promise.resolve())
    ).toEqual({ ok: true });
  });
});

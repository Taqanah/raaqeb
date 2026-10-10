import { describe, expect, test } from "bun:test";
import { signingSecretShape } from "@/shared/schemas/channel.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import type { ChannelPayload, Transport } from "./channel.ts";
import { recordPosts } from "./fixture.ts";
import { newSigningSecret, signWebhook, webhookChannel } from "./webhook.ts";

const notification: NotificationPayload = {
  data: {
    monitor: {
      adminUrl: "https://status.example.test/admin/monitors/0199",
      checkType: "http",
      id: "0199",
      name: "الموقع",
      target: "https://example.test/",
    },
    reason: "timeout",
  },
  timestamp: "2026-09-25T10:00:00.000Z",
  type: "monitor.down",
};

const payload: ChannelPayload = {
  id: "01999a3c-0000-7000-8000-000000000001",
  locale: "ar",
  notification,
  time: { calendar: "gregorian", clock: "24h", timeZone: "UTC" },
};

describe("the webhook's signature", () => {
  test("follows the Standard Webhooks scheme: the published test vector signs to its published value", async () => {
    // The vector of the Svix and Standard Webhooks libraries' tests.
    expect(
      await signWebhook(
        "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        "msg_p5jXN8AQM9LWM0D4loKWxJek",
        1_614_265_330,
        '{"test": 2432232314}'
      )
    ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  test("a signing secret is whsec_ and 32 random bytes, a new one each time", () => {
    const first = newSigningSecret();
    const second = newSigningSecret();
    expect(first).toMatch(signingSecretShape);
    expect(second).toMatch(signingSecretShape);
    expect(first).not.toBe(second);
    expect(Object.keys(webhookChannel.generate)).toEqual(["secret"]);
    for (const make of Object.values(webhookChannel.generate)) {
      expect(make()).toMatch(signingSecretShape);
    }
  });
});

describe("the webhook's send", () => {
  test("posts the payload as JSON to the URL with the three Standard Webhooks headers, signed over id, timestamp and body", async () => {
    const secret = newSigningSecret();
    const { posts, transport } = recordPosts(1_758_794_400_123);
    await webhookChannel.send(
      { secret, url: "https://hooks.example.test/raaqeb" },
      payload,
      transport
    );
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post?.url).toBe("https://hooks.example.test/raaqeb");
    expect(post?.body).toBe(JSON.stringify(notification));
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(post?.headers["webhook-id"]).toBe(payload.id);
    expect(post?.headers["webhook-timestamp"]).toBe("1758794400");
    expect(post?.headers["webhook-signature"]).toBe(
      await signWebhook(secret, payload.id, 1_758_794_400, post?.body ?? "")
    );
  });

  test("a receiver verifies the signature with the secret's bytes and a plain HMAC", async () => {
    const secret = newSigningSecret();
    const { posts, transport } = recordPosts(1_758_794_400_000);
    await webhookChannel.send(
      { secret, url: "https://hooks.example.test/raaqeb" },
      payload,
      transport
    );
    const [post] = posts;
    const headers = post?.headers ?? {};
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.fromBase64(secret.slice("whsec_".length)),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["verify"]
    );
    const { "webhook-signature": signature = "" } = headers;
    expect(signature.startsWith("v1,")).toBe(true);
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.fromBase64(signature.slice(3)),
      new TextEncoder().encode(
        `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${post?.body}`
      )
    );
    expect(verified).toBe(true);
  });

  test("the body is machine values whatever the channel language", async () => {
    const { posts, transport } = recordPosts(0);
    const values = {
      secret: newSigningSecret(),
      url: "https://h.example.test/",
    };
    await webhookChannel.send(values, payload, transport);
    await webhookChannel.send(values, { ...payload, locale: "en" }, transport);
    expect(posts[0]?.body).toBe(posts[1]?.body);
  });

  test("a failed post fails the send", async () => {
    const transport: Transport = {
      now: () => 0,
      post: () => Promise.reject(new Error("refused")),
      smtp: () => Promise.reject(new Error("the webhook sends no email")),
    };
    await expect(
      webhookChannel.send(
        { secret: newSigningSecret(), url: "https://h.example.test/" },
        payload,
        transport
      )
    ).rejects.toThrow("refused");
  });
});

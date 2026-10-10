/**
 * The email channel's send end to end through the compose Mailpit. It runs under `bun run test:postgres`, which sets
 * both addresses and fails when Mailpit does not listen; the SQLite gate runs
 * the same path against the fake server in fixture.ts.
 */
import { describe, expect, test } from "bun:test";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import { type ChannelPayload, type DeliverIo, deliver } from "./channel.ts";
import { emailChannel } from "./email.ts";

const api = process.env.RAAQEB_TEST_MAILPIT_API;
const smtp = process.env.RAAQEB_TEST_MAILPIT_SMTP;

const live: DeliverIo = { fetch, now: Date.now };

const notification: NotificationPayload = {
  data: { channel: { id: "c1", name: "بريد الفريق" } },
  timestamp: "2026-09-25T18:49:00.000Z",
  type: "channel.test",
};

const values = (port: string, security = "none") => ({
  from: "راقب <alerts@example.test>",
  host: "127.0.0.1",
  port,
  security,
  to: "ops@example.test, oncall@example.test",
});

interface MailpitMessage {
  readonly ID: string;
  readonly MessageID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

/** The messages Mailpit holds with this Message-ID. */
async function received(id: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${api}/api/v1/search?query=${encodeURIComponent(`message-id:"${id}@example.test"`)}`
  );
  const { messages } = (await response.json()) as {
    messages: MailpitMessage[];
  };
  return messages;
}

describe.if(api !== undefined && smtp !== undefined)(
  "an email through Mailpit",
  () => {
    const { port } = new URL(smtp ?? "smtp://127.0.0.1:1025");

    test("a send test arrives once, in the channel language, to every recipient, its HTML part right to left in Arabic beside the plain text, as a client shows it", async () => {
      const payload: ChannelPayload = {
        id: Bun.randomUUIDv7(),
        locale: "ar",
        notification,
        time: { calendar: "gregorian", clock: "12h", timeZone: "Asia/Riyadh" },
      };
      expect(await deliver(emailChannel, values(port), payload, live)).toEqual({
        ok: true,
      });
      const [message, ...more] = await received(payload.id);
      expect(more).toEqual([]);
      expect(message?.Subject).toBe("رسالة تجريبية من راقب");
      expect(message?.To.map((each) => each.Address)).toEqual([
        "ops@example.test",
        "oncall@example.test",
      ]);
      const read = (await (
        await fetch(`${api}/api/v1/message/${message?.ID}`)
      ).json()) as { HTML: string; Text: string };
      expect(read.Text).toContain("القناة: بريد الفريق");
      expect(read.HTML).toContain('<html lang="ar" dir="rtl">');
      expect(read.HTML).toContain("القناة: بريد الفريق");
    });

    test("a certificate the install cannot verify fails the send and nothing arrives", async () => {
      const payload: ChannelPayload = {
        id: Bun.randomUUIDv7(),
        locale: "en",
        notification,
        time: { calendar: "gregorian", clock: "24h", timeZone: "UTC" },
      };
      const outcome = await deliver(
        emailChannel,
        values(port, "starttls"),
        payload,
        live
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure.reason).toBe("certificate_invalid");
      }
      expect(await received(payload.id)).toEqual([]);
    });
  }
);

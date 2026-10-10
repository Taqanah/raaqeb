import { describe, expect, test } from "bun:test";
import {
  formatDateTimeWithZone,
  formatDuration,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import {
  type ChannelType,
  channelTypes,
  type NotificationLink,
  type NotificationPreview,
} from "@/shared/schemas/channel.ts";
import {
  type NotificationPayload,
  notificationPayloadSchema,
} from "@/shared/schemas/notification.ts";
import type { MailMessage, Transport } from "./channel.ts";
import { recordPosts } from "./fixture.ts";
import { type PreviewContext, previewNotifications } from "./preview.ts";
import { notificationChannels } from "./registry.ts";

const now = Date.parse("2026-10-01T09:00:00.000Z");
const utc: TimeOptions = {
  calendar: "gregorian",
  clock: "24h",
  timeZone: "UTC",
};
const riyadh: TimeOptions = {
  calendar: "gregorian",
  clock: "12h",
  timeZone: "Asia/Riyadh",
};
const address = "https://status.example.com";

const english: PreviewContext = {
  locale: "en",
  publicAddress: address,
  time: utc,
};

function byType(
  previews: readonly NotificationPreview[],
  type: NotificationPreview["type"]
): NotificationPreview {
  const found = previews.find((each) => each.type === type);
  if (!found) {
    throw new Error(`no preview of ${type}`);
  }
  return found;
}

/** The notifications the preview was built from, read back from the webhook's bodies. */
async function samples(
  context: PreviewContext
): Promise<NotificationPayload[]> {
  const previews = await previewNotifications("webhook", context, now);
  return previews.map((each) =>
    notificationPayloadSchema.parse(JSON.parse(each.body))
  );
}

/** A transport that keeps every POST and every mail a send makes. */
function recording(): {
  readonly mails: MailMessage[];
  readonly posts: { body: string; url: string }[];
  readonly transport: Transport;
} {
  const { posts, transport } = recordPosts(now);
  const mails: MailMessage[] = [];
  return {
    mails,
    posts,
    transport: {
      ...transport,
      smtp: (_server, message) => {
        mails.push(message);
        return Promise.resolve();
      },
    },
  };
}

/** Values each type's send needs to reach a recording transport. */
const values: Readonly<Record<ChannelType, Record<string, string>>> = {
  discord: { url: "https://discord.example.com/api/webhooks/1/t" },
  email: {
    from: "alerts@example.com",
    host: "smtp.example.com",
    port: "587",
    security: "starttls",
    to: "ops@example.com",
  },
  ntfy: { server: "https://ntfy.example.com", topic: "ops" },
  slack: { url: "https://hooks.slack.example.com/services/T/B/x" },
  telegram: { botToken: "1:x", chatId: "1" },
  webhook: { secret: `whsec_${"A".repeat(43)}=`, url: "https://example.com" },
};

type Carried = Omit<NotificationPreview, "type">;

/** A chat message read as its receiver shows it: the text before the links, with `readBack` undoing its markup's escapes, and each link's words and URL as `link` finds them on the lines after it. */
function chatOf(
  message: string,
  link: RegExp,
  readBack: (text: string) => string
): Carried {
  const links: NotificationLink[] = [];
  const body = message.replace(link, (_, url: string, words: string) => {
    links.push({ url: readBack(url), words: readBack(words) });
    return "";
  });
  return {
    body: readBack(body),
    buttons: [],
    html: undefined,
    links,
    subject: undefined,
  };
}

const htmlEntities = /&(lt|gt|quot|amp);/g;
const htmlCharacters: Readonly<Record<string, string>> = {
  amp: "&",
  gt: ">",
  lt: "<",
  quot: '"',
};

/** What a type's send carried, as the preview shows it: the subject apart, the text, and the links or buttons. */
async function carried(
  type: ChannelType,
  notification: NotificationPayload,
  context: PreviewContext
): Promise<Carried> {
  const { mails, posts, transport } = recording();
  await notificationChannels[type].send(
    values[type],
    { id: "n1", locale: context.locale, notification, time: context.time },
    transport
  );
  const [mail] = mails;
  if (mail) {
    return {
      body: mail.text,
      buttons: [],
      html: mail.html,
      links: [],
      subject: mail.subject,
    };
  }
  const sent = JSON.parse(posts[0]?.body ?? "{}");
  switch (type) {
    case "telegram":
      return chatOf(sent.text, /\n<a href="([^"]*)">([^<]*)<\/a>/g, (text) =>
        text.replace(
          htmlEntities,
          (_, name: string) => htmlCharacters[name] ?? ""
        )
      );
    case "slack":
      return chatOf(sent.text, /\n<([^|>]*)\|([^>]*)>/g, (text) =>
        text
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&")
      );
    case "discord":
      // Discord's link is the words, then the URL: swapped to the order the others give.
      return chatOf(
        sent.content.replace(/\n\[(.*?)\]\(<(.*?)>\)/g, "\n[$2]($1)"),
        /\n\[(.*?)\]\((.*?)\)/g,
        (text) => text.replace(/\\(.)/g, "$1")
      );
    case "ntfy":
      return {
        body: sent.message,
        buttons: (sent.actions ?? []).map(
          (each: { label: string; url: string }) => ({
            url: each.url,
            words: each.label,
          })
        ),
        html: undefined,
        links: [],
        subject: sent.title,
      };
    default:
      return {
        body: JSON.stringify(sent),
        buttons: [],
        html: undefined,
        links: [],
        subject: undefined,
      };
  }
}

describe("the notification preview", () => {
  test("a channel previews down, its reminder, recovered, degraded started, degraded ended and certificate expiring", async () => {
    for (const type of channelTypes) {
      // biome-ignore lint/performance/noAwaitInLoops: six types, one after the other
      const previews = await previewNotifications(type, english, now);
      expect(previews.map((each) => each.type)).toEqual([
        "monitor.down",
        "monitor.reminder",
        "monitor.recovered",
        "monitor.degraded_started",
        "monitor.degraded_ended",
        "monitor.certificate_expiring",
      ]);
    }
  });

  test("each preview shows what its type's own send carries for the same notification", async () => {
    const contexts: PreviewContext[] = [
      english,
      { locale: "ar", publicAddress: address, time: riyadh },
      { ...english, publicAddress: "http://localhost:3000" },
    ];
    const cases = contexts.flatMap((context) =>
      channelTypes.map((type) => ({ context, type }))
    );
    await Promise.all(
      cases.map(async ({ context, type }) => {
        const [notifications, previews] = await Promise.all([
          samples(context),
          previewNotifications(type, context, now),
        ]);
        const sent = await Promise.all(
          notifications.map((each) => carried(type, each, context))
        );
        expect(previews).toHaveLength(6);
        expect(sent).toHaveLength(6);
        for (const [index, preview] of previews.entries()) {
          const carriedText = sent[index];
          if (type === "webhook") {
            expect(JSON.parse(preview.body)).toEqual(
              JSON.parse(carriedText?.body ?? "")
            );
            expect(preview.subject).toBeUndefined();
          } else {
            const { type: _, ...shown } = preview;
            expect(shown).toEqual(carriedText ?? shown);
          }
        }
      })
    );
  });

  test("the text is in the channel language, about a sample monitor and target, at now on the install's clock", async () => {
    const arabic = byType(
      await previewNotifications(
        "telegram",
        { locale: "ar", publicAddress: undefined, time: riyadh },
        now
      ),
      "monitor.down"
    );
    expect(arabic.body).toContain("المراقبة متعطّلة.");
    expect(arabic.body).toContain("الهدف: https://example.com");
    expect(arabic.body).toContain(
      `الوقت: ${formatDateTimeWithZone("ar", now, riyadh)}`
    );
    const down = byType(
      await previewNotifications("slack", english, now),
      "monitor.down"
    );
    expect(down.body).toContain("Target: https://example.com");
    expect(down.body).toContain("Reason: Timed out");
    expect(down.body).toContain(
      `Time: ${formatDateTimeWithZone("en", now, utc)}`
    );
  });

  test("the samples carry a downtime, a time down, a slow response and a certificate's time left", async () => {
    const previews = await previewNotifications("slack", english, now);
    expect(byType(previews, "monitor.recovered").body).toContain(
      `Downtime: ${formatDuration("en", 12 * 60_000)}`
    );
    expect(byType(previews, "monitor.reminder").body).toContain(
      `Down for: ${formatDuration("en", 3_600_000)}`
    );
    expect(byType(previews, "monitor.degraded_started").body).toContain(
      "Reason: Slow response"
    );
    const certificate = byType(previews, "monitor.certificate_expiring").body;
    expect(certificate).toContain("Time left: 14 days");
    expect(certificate).toContain(
      `Expires: ${formatDateTimeWithZone("en", now + 14 * 86_400_000, utc)}`
    );
  });

  test("the links start from the stored public address, and an install with none shows no link", async () => {
    const sampleLinks: NotificationLink[] = [
      {
        url: `${address}/admin/monitors/00000000-0000-7000-8000-000000000000`,
        words: "Open the monitor",
      },
      {
        url: `${address}/admin/incidents/new?monitor=00000000-0000-7000-8000-000000000000`,
        words: "Open an incident",
      },
    ];
    const linked = byType(
      await previewNotifications("slack", english, now),
      "monitor.down"
    );
    expect(linked.links).toEqual(sampleLinks);
    expect(linked.buttons).toEqual([]);
    expect(linked.body).not.toContain(address);
    const unlinked = byType(
      await previewNotifications(
        "slack",
        { ...english, publicAddress: undefined },
        now
      ),
      "monitor.down"
    );
    expect(unlinked.links).toEqual([]);
    expect(unlinked.buttons).toEqual([]);
  });

  test("the webhook's preview is its machine payload, never localized", async () => {
    const previews = await previewNotifications(
      "webhook",
      { locale: "ar", publicAddress: address, time: riyadh },
      now
    );
    const down = notificationPayloadSchema.parse(
      JSON.parse(byType(previews, "monitor.down").body)
    );
    expect(down).toMatchObject({
      data: { monitor: { target: "https://example.com" }, reason: "timeout" },
      timestamp: new Date(now).toISOString(),
      type: "monitor.down",
    });
    expect(previews.map((each) => each.body).join("")).not.toContain(
      "انتهت مهلة الانتظار"
    );
  });
});

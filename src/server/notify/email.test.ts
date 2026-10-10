import { describe, expect, test } from "bun:test";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import type {
  ChannelPayload,
  MailMessage,
  SmtpServer,
  Transport,
} from "./channel.ts";
import { emailChannel, notificationHtml, sendMail } from "./email.ts";
import { htmlLinks, htmlText } from "./fixture.ts";
import { notificationText, plainText } from "./text.ts";

const notification: NotificationPayload = {
  data: {
    monitor: {
      adminUrl: "https://status.example.test/admin/monitors/0199",
      checkType: "http",
      id: "0199",
      name: "API",
      target: "https://api.example.test/health",
    },
    reason: "timeout",
  },
  timestamp: "2026-09-25T18:49:00.000Z",
  type: "monitor.down",
};

const payload: ChannelPayload = {
  id: "01999a3c-0000-7000-8000-000000000001",
  locale: "ar",
  notification,
  time: { calendar: "gregorian", clock: "12h", timeZone: "Asia/Riyadh" },
};

/** The plain-text body the channel should send for the payload. */
const bodyOf = async (): Promise<string> =>
  plainText(await notificationText(payload));

const common = {
  from: "راقب <alerts@example.test>",
  to: "ops@example.test، oncall@example.test",
};

const server = {
  host: "smtp.example.test",
  port: "587",
  security: "starttls",
};

/** A transport that records every post and every SMTP message, at a fixed clock. */
function recorder(now = Date.parse("2026-09-25T18:49:05.000Z")) {
  const posts: string[] = [];
  const mails: { message: MailMessage; server: SmtpServer }[] = [];
  const transport: Transport = {
    now: () => now,
    post: (url) => {
      posts.push(url);
      return Promise.resolve();
    },
    smtp: (smtp, message) => {
      mails.push({ message, server: smtp });
      return Promise.resolve();
    },
  };
  return { mails, posts, transport };
}

describe("the email channel over SMTP", () => {
  test("sends one message from the sender to every recipient, with the notification's id, its plain-text body and its HTML part", async () => {
    const { mails, posts, transport } = recorder();
    await emailChannel.send(
      {
        ...common,
        host: "smtp.example.test",
        port: "587",
        security: "starttls",
      },
      payload,
      transport
    );
    expect(posts).toEqual([]);
    expect(mails).toEqual([
      {
        message: {
          from: { address: "alerts@example.test", name: "راقب" },
          html: notificationHtml(payload, await notificationText(payload)),
          id: payload.id,
          subject: "API: متعطّل",
          text: await bodyOf(),
          to: ["ops@example.test", "oncall@example.test"],
        },
        server: {
          host: "smtp.example.test",
          password: undefined,
          port: 587,
          security: "starttls",
          username: undefined,
        },
      },
    ]);
  });

  test("the links stay label-value lines at the end of the plain-text body, since a plain-text email cannot hold words that open a URL", async () => {
    const { mails, transport } = recorder();
    await emailChannel.send(
      { ...common, ...server },
      {
        ...payload,
        notification: {
          ...notification,
          data: {
            ...notification.data,
            incidentUrl:
              "https://status.example.test/admin/incidents/new?monitor=0199",
          },
        },
      },
      transport
    );
    expect(mails[0]?.message.text).toEndWith(
      "\nالرابط: https://status.example.test/admin/monitors/0199\nفتح حادثة: https://status.example.test/admin/incidents/new?monitor=0199\n"
    );
  });

  test("a user name and its password go to a protected connection", async () => {
    const { mails, transport } = recorder();
    await emailChannel.send(
      {
        ...common,
        host: "smtp.example.test",
        password: "s3cret",
        port: "465",
        security: "tls",
        username: "alerts",
      },
      payload,
      transport
    );
    expect(mails[0]?.server).toEqual({
      host: "smtp.example.test",
      password: "s3cret",
      port: 465,
      security: "tls",
      username: "alerts",
    });
  });

  test("a plain connection is never given a user name or a password, even when some are stored", async () => {
    const { mails, transport } = recorder();
    await emailChannel.send(
      {
        ...common,
        host: "127.0.0.1",
        password: "s3cret",
        port: "25",
        security: "none",
        username: "alerts",
      },
      payload,
      transport
    );
    expect(mails.map((each) => each.server)).toEqual([
      {
        host: "127.0.0.1",
        password: undefined,
        port: 25,
        security: "none",
        username: undefined,
      },
    ]);
  });

  test("a refused message fails the send", async () => {
    const { transport } = recorder();
    await expect(
      emailChannel.send(
        {
          ...common,
          host: "smtp.example.test",
          port: "587",
          security: "starttls",
        },
        payload,
        { ...transport, smtp: () => Promise.reject(new Error("550 refused")) }
      )
    ).rejects.toThrow("550 refused");
  });
});

describe("the email channel's message", () => {
  test("the text follows the channel language", async () => {
    const { mails, transport } = recorder();
    await emailChannel.send(
      { ...common, ...server },
      { ...payload, locale: "en" },
      transport
    );
    expect(mails[0]?.message.subject).toBe("API is down");
  });

  test("a sender that is not an address fails the send before anything is sent", async () => {
    const { mails, posts, transport } = recorder();
    await expect(
      emailChannel.send(
        { ...common, ...server, from: "nobody" },
        payload,
        transport
      )
    ).rejects.toThrow("the channel's sender is not an address");
    expect([...mails, ...posts]).toEqual([]);
  });

  test("a channel stored before SMTP alone, with no server, fails the send before anything is sent, never falling back to this host", async () => {
    const { mails, posts, transport } = recorder();
    await expect(
      emailChannel.send(
        { ...common, providerApiKey: "key_1", transport: "provider" },
        payload,
        transport
      )
    ).rejects.toThrow("the channel has no SMTP server");
    expect([...mails, ...posts]).toEqual([]);
  });

  test("a channel stored with a sending method from before SMTP alone still sends over SMTP", async () => {
    const { mails, posts, transport } = recorder();
    await emailChannel.send(
      { ...common, ...server, transport: "smtp" },
      payload,
      transport
    );
    expect(posts).toEqual([]);
    expect(mails).toHaveLength(1);
  });
});

describe("a subscriber's email carries its extra headers", () => {
  const unsubscribe = {
    "List-Unsubscribe":
      "<https://status.example.test/subscriptions/abc/unsubscribe>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  const message: MailMessage = {
    from: { address: "status@example.test", name: "حالة المثال" },
    headers: unsubscribe,
    html: "<p>نص الرسالة</p>\n",
    id: "01999a3c-0000-7000-8000-000000000009",
    subject: "كبير: تعطل الدفع",
    text: "نص الرسالة\n",
    to: ["reader@example.test"],
  };

  test("SMTP hands them to the server with the message", async () => {
    const { mails, transport } = recorder();
    await sendMail({ ...common, ...server }, message, transport);
    expect(mails[0]?.message.headers).toEqual(unsubscribe);
  });

  test("an operator notification carries no extra header", async () => {
    const { mails, transport } = recorder();
    await sendMail(
      { ...common, ...server },
      { ...message, headers: undefined },
      transport
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]?.message.headers).toBeUndefined();
  });
});

describe("a notification's HTML part", () => {
  const incidentUrl =
    "https://status.example.test/admin/incidents/new?monitor=0199";
  const withIncident: ChannelPayload = {
    ...payload,
    notification: {
      ...notification,
      data: { ...notification.data, incidentUrl },
    },
  };
  const htmlOf = async (sent: ChannelPayload) =>
    notificationHtml(sent, await notificationText(sent));

  test("has the monitor's name as its heading in place of the line that names it, and no name above the card", async () => {
    const shown = htmlText(await htmlOf(payload)).split("\n");
    expect(shown).not.toContain("راقب");
    expect(shown).toContain("API");
    expect(shown).toContain("المراقبة متعطّلة.");
    expect(shown).not.toContain("المراقبة: API");
  });

  test("shows every other line as the plain-text part writes it, the target left to right", async () => {
    const text = await notificationText(payload);
    const html = notificationHtml(payload, text);
    const shown = htmlText(html).split("\n");
    for (const line of text.lines.slice(1)) {
      expect(shown).toContain(line);
    }
    expect(html).toContain('<span dir="ltr" style="unicode-bidi:isolate;');
    expect(html).toContain("https://<wbr>api.example.test/<wbr>health</span>");
  });

  test("opens each link from a button with its words, and shows no address as text", async () => {
    const text = await notificationText(withIncident);
    const html = notificationHtml(withIncident, text);
    expect(htmlLinks(html)).toEqual([
      {
        url: "https://status.example.test/admin/monitors/0199",
        words: "فتح المراقبة",
      },
      { url: incidentUrl, words: "فتح حادثة" },
    ]);
    expect(htmlText(html)).not.toContain("https://status.example.test");
  });

  test("follows the channel language", async () => {
    const html = await htmlOf({ ...payload, locale: "en" });
    expect(html).toContain('<html lang="en" dir="ltr">');
    const shown = htmlText(html).split("\n");
    expect(shown).toContain("The monitor is down.");
  });

  test("a test send shows its lines with no heading and no button", async () => {
    const testSend: ChannelPayload = {
      ...payload,
      notification: {
        data: { channel: { id: "c1", name: "بريد الفريق" } },
        timestamp: "2026-09-25T18:49:00.000Z",
        type: "channel.test",
      },
    };
    const text = await notificationText(testSend);
    const html = notificationHtml(testSend, text);
    expect(htmlText(html).split("\n")).toEqual([
      text.sentence,
      text.sentence,
      ...text.lines,
    ]);
    expect(htmlLinks(html)).toEqual([]);
  });

  test("shows everything the plain-text part says: each line as written, but the monitor's own, which is its heading, and the link lines, whose addresses its buttons open", async () => {
    const { monitor } = notification.data;
    const sends: ChannelPayload[] = [
      withIncident,
      {
        ...payload,
        locale: "en",
        notification: {
          data: { downtimeMs: 754_000, monitor },
          timestamp: "2026-09-25T18:49:00.000Z",
          type: "monitor.recovered",
        },
      },
      {
        ...payload,
        notification: {
          data: {
            certificate: { daysLeft: 13, notAfter: "2026-10-08T12:00:00.000Z" },
            monitor: { ...monitor, adminUrl: undefined },
          },
          timestamp: "2026-09-25T18:49:00.000Z",
          type: "monitor.certificate_expiring",
        },
      },
    ];
    for (const sent of sends) {
      // biome-ignore lint/performance/noAwaitInLoops: one notification after the other
      const text = await notificationText(sent);
      const html = notificationHtml(sent, text);
      const shown = htmlText(html).split("\n");
      const [named = "", ...lines] = text.lines;
      expect(shown).toContain(monitor.name);
      expect(named).toContain(monitor.name);
      for (const line of [text.sentence, ...lines]) {
        expect(shown).toContain(line);
      }
      expect(htmlLinks(html).map((each) => each.url)).toEqual(
        text.links.map((each) => each.url)
      );
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import {
  recordPosts,
  sampleDown,
  sampleDownOf,
  sampleDownText,
  sampleIncidentUrl,
  sampleMonitor,
  sampleSend,
} from "./fixture.ts";
import { telegramChannel } from "./telegram.ts";

const botToken = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

const monitorLink =
  '<a href="https://status.example.test/admin/monitors/0199">فتح المراقبة</a>';

/** The text the channel sent for a notification, as the Bot API gets it. */
async function textFor(notification: NotificationPayload): Promise<string> {
  const { posts, transport } = recordPosts();
  await telegramChannel.send(
    { botToken, chatId: "123456789" },
    sampleSend(notification),
    transport
  );
  return JSON.parse(posts[0]?.body ?? "{}").text;
}

/** The text a chat shows once Telegram reads its HTML: the tags gone, the entities read back. */
function shown(html: string): string {
  return html
    .replaceAll(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

describe("the Telegram channel", () => {
  test("a down notification in Arabic is sent by the bot to the chat as the recorded sample: HTML whose link is the words that open the monitor, no link preview", async () => {
    const { posts, transport } = recordPosts();
    await telegramChannel.send(
      { botToken, chatId: "-1001234567890" },
      sampleSend(sampleDown),
      transport
    );
    expect(
      posts.map((each) => ({ ...each, body: JSON.parse(each.body) }))
    ).toEqual([
      {
        body: {
          chat_id: "-1001234567890",
          link_preview_options: { is_disabled: true },
          parse_mode: "HTML",
          text: `${sampleDownText}\n${monitorLink}`,
        },
        headers: { "content-type": "application/json", "user-agent": "Raaqeb" },
        url: `https://api.telegram.org/bot${botToken}/sendMessage`,
      },
    ]);
  });

  test("a public channel's @name is sent as typed", async () => {
    const { posts, transport } = recordPosts();
    await telegramChannel.send(
      { botToken, chatId: "@raaqeb_ops" },
      sampleSend(sampleDown),
      transport
    );
    expect(JSON.parse(posts[0]?.body ?? "{}").chat_id).toBe("@raaqeb_ops");
  });

  test("the open-incident link follows the monitor's, each the words that open it on a line of its own", async () => {
    const text = await textFor({
      data: {
        incidentUrl: sampleIncidentUrl,
        monitor: sampleMonitor,
        reason: "timeout",
      },
      timestamp: sampleDown.timestamp,
      type: "monitor.down",
    });
    expect(text).toEndWith(
      `\n${monitorLink}\n<a href="https://status.example.test/admin/incidents/new?monitor=0199">فتح حادثة</a>`
    );
  });

  test("a monitor with no admin link sends no link", async () => {
    const text = await textFor(sampleDownOf({ adminUrl: undefined }));
    expect(text).toBe(sampleDownText);
  });

  test("a name with HTML's characters is escaped, so it shows as typed and breaks no parse", async () => {
    const text = await textFor(
      sampleDownOf({ name: '<b>API</b> & "v2" &amp; <a href="x">' })
    );
    expect(text.split("\n")[0]).toBe(
      '&lt;b&gt;API&lt;/b&gt; &amp; "v2" &amp;amp; &lt;a href="x"&gt;: متعطّل'
    );
    expect(shown(text).split("\n")[0]).toBe(
      '<b>API</b> & "v2" &amp; <a href="x">: متعطّل'
    );
  });

  test("a message past Telegram's 4,096 characters is cut to 4,096 as a chat shows it, the cut ending in an ellipsis before the link, which stays whole", async () => {
    const text = await textFor(
      sampleDownOf({ target: `https://api.example.test/${"a".repeat(5000)}` })
    );
    expect(shown(text).length).toBe(4096);
    expect(text).toEndWith(`…\n${monitorLink}`);
  });

  test("a cut counts an escaped character once and never splits an entity, since Telegram counts the text after reading its HTML", async () => {
    const text = await textFor(sampleDownOf({ name: "&<".repeat(3000) }));
    expect(shown(text).length).toBe(4096);
    expect(text).toEndWith(`…\n${monitorLink}`);
    expect(text.replaceAll(/&(amp|lt|gt|quot);/g, "")).not.toContain("&");
  });

  test("with no link the whole text is cut to 4,096 as a chat shows it", async () => {
    const text = await textFor(
      sampleDownOf({ adminUrl: undefined, name: "&".repeat(5000) })
    );
    expect(shown(text).length).toBe(4096);
    expect(text).toEndWith("…");
  });

  test("a link's address is escaped inside its attribute, so a quote or an ampersand cannot end it", async () => {
    const text = await textFor(
      sampleDownOf({ adminUrl: 'https://status.example.test/a?b=1&c="d"' })
    );
    expect(text).toEndWith(
      '\n<a href="https://status.example.test/a?b=1&amp;c=&quot;d&quot;">فتح المراقبة</a>'
    );
  });

  test("a link whose host has no dot is its plain line, since Telegram drops such a link and would show the words with no address", async () => {
    const text = await textFor(
      sampleDownOf({ adminUrl: "http://localhost:3000/admin/monitors/0199" })
    );
    expect(text).toBe(
      `${sampleDownText}\nالرابط: http://localhost:3000/admin/monitors/0199`
    );
  });

  test("an IPv6 or a dotted address stays the words that open it, as Telegram links both", async () => {
    const texts = await Promise.all(
      ["http://[::1]:3000/admin/monitors/0199", "http://10.0.0.5/m"].map(
        (adminUrl) => textFor(sampleDownOf({ adminUrl }))
      )
    );
    expect(texts.map((text) => text.split("\n").at(-1))).toEqual([
      '<a href="http://[::1]:3000/admin/monitors/0199">فتح المراقبة</a>',
      '<a href="http://10.0.0.5/m">فتح المراقبة</a>',
    ]);
  });

  test("a link written as its plain line counts by that line in the cut, and stays whole", async () => {
    const text = await textFor(
      sampleDownOf({
        adminUrl: "http://localhost:3000/admin/monitors/0199",
        target: `https://api.example.test/${"a".repeat(5000)}`,
      })
    );
    expect(shown(text).length).toBe(4096);
    expect(text).toEndWith(
      "…\nالرابط: http://localhost:3000/admin/monitors/0199"
    );
  });

  test("a channel's test is HTML too, its channel's name escaped, with no link", async () => {
    const text = await textFor({
      data: { channel: { id: "c1", name: "<ops> & on-call" } },
      timestamp: sampleDown.timestamp,
      type: "channel.test",
    });
    expect(text).toContain("&lt;ops&gt; &amp; on-call");
    expect(text).not.toContain("<a ");
  });
});

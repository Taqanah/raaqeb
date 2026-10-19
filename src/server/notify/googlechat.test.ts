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
import { googlechatChannel } from "./googlechat.ts";

const url =
  "https://chat.googleapis.com/v1/spaces/AAAA1234/messages?key=AIzaSyDdI0hCZtE6vySjMm&token=secrettoken";

/** What the channel posted for a notification, as the space's webhook gets it. */
async function posted(
  notification: NotificationPayload,
  locale: "ar" | "en" = "en"
) {
  const { posts, transport } = recordPosts();
  await googlechatChannel.send(
    { url },
    sampleSend(notification, locale),
    transport
  );
  expect(posts).toHaveLength(1);
  const [post] = posts;
  const body = JSON.parse(post?.body ?? "{}");
  return { ...post, body, card: body.cardsV2?.[0]?.card };
}

const paragraph = (card: {
  sections: { widgets: { textParagraph?: { text: string } }[] }[];
}) => card.sections[0]?.widgets[0]?.textParagraph?.text;

describe("the Google Chat channel", () => {
  test("a down notification in Arabic is posted to the space's webhook as the recorded sample: a card of the subject as its title, the text as one paragraph and the monitor's page as a button, and the plain text with its link line as the fallback", async () => {
    expect(await posted(sampleDown, "ar")).toEqual({
      body: {
        cardsV2: [
          {
            card: {
              header: { title: "API: متعطّل" },
              sections: [
                {
                  widgets: [
                    {
                      textParagraph: {
                        text: "المراقبة متعطّلة.<br><br>المراقبة: API<br>الهدف: https://api.example.test/health<br>العلة: انتهت مهلة الانتظار<br>الوقت: 25 سبتمبر 2026، 9:49 م (غرينتش+3)",
                      },
                    },
                    {
                      buttonList: {
                        buttons: [
                          {
                            onClick: {
                              openLink: {
                                url: "https://status.example.test/admin/monitors/0199",
                              },
                            },
                            text: "فتح المراقبة",
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
        fallbackText: `${sampleDownText}\nالرابط: https://status.example.test/admin/monitors/0199`,
      },
      card: expect.anything(),
      headers: { "content-type": "application/json", "user-agent": "Raaqeb" },
      url,
    });
  });

  test("the open-incident link follows the monitor's, each a button of the words that open it and each a line of the fallback", async () => {
    const { body, card } = await posted({
      data: {
        incidentUrl: sampleIncidentUrl,
        monitor: sampleMonitor,
        reason: "timeout",
      },
      timestamp: sampleDown.timestamp,
      type: "monitor.down",
    });
    expect(
      card.sections[0].widgets[1].buttonList.buttons.map(
        (each: { onClick: { openLink: { url: string } }; text: string }) => [
          each.text,
          each.onClick.openLink.url,
        ]
      )
    ).toEqual([
      ["Open the monitor", "https://status.example.test/admin/monitors/0199"],
      ["Open an incident", sampleIncidentUrl],
    ]);
    expect(body.fallbackText).toEndWith(
      `\nLink: https://status.example.test/admin/monitors/0199\nOpen an incident: ${sampleIncidentUrl}`
    );
  });

  test("a monitor with no admin link sends no buttons, and its fallback is the text alone", async () => {
    const { body, card } = await posted(
      sampleDownOf({ adminUrl: undefined }),
      "ar"
    );
    expect(card.sections[0].widgets).toHaveLength(1);
    expect(body.fallbackText).toBe(sampleDownText);
  });

  test("the characters Chat reads as HTML are escaped in the paragraph, so a name cannot make a tag or a link, while the title and the fallback carry it as typed", async () => {
    const name = '<b>x</b> & <a href="https://evil.example">y</a>';
    const { body, card } = await posted(sampleDownOf({ name }));
    expect(paragraph(card)).toContain(
      'Monitor: &lt;b&gt;x&lt;/b&gt; &amp; &lt;a href="https://evil.example"&gt;y&lt;/a&gt;'
    );
    expect(paragraph(card)).not.toContain("<b>");
    expect(card.header.title).toBe(`${name} is down`);
    expect(body.fallbackText).toStartWith(`${name} is down\n`);
  });

  test("a URL's ampersand is escaped in the paragraph like any other, which Chat reads back", async () => {
    const { card } = await posted(
      sampleDownOf({ target: "https://api.example.test/a?b=1&c=2" })
    );
    expect(paragraph(card)).toContain(
      "Target: https://api.example.test/a?b=1&amp;c=2<br>"
    );
  });

  test("a channel's test is a card with the sample's title and no buttons", async () => {
    const { body, card } = await posted({
      data: { channel: { id: "ch1", name: "Ops space" } },
      timestamp: sampleDown.timestamp,
      type: "channel.test",
    });
    expect(card.header.title).toBe("Test message from Raaqeb");
    expect(paragraph(card)).toContain("Channel: Ops space");
    expect(card.sections[0].widgets).toHaveLength(1);
    expect(body.fallbackText).toStartWith("Test message from Raaqeb\n\n");
  });
});

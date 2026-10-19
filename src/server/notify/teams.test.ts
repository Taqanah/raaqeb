import { describe, expect, test } from "bun:test";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import {
  recordPosts,
  sampleDown,
  sampleDownOf,
  sampleIncidentUrl,
  sampleMonitor,
  sampleSend,
} from "./fixture.ts";
import { teamsChannel } from "./teams.ts";

const url =
  "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=secretsignature";
const timestamp = "2026-09-25T18:49:00.000Z";

/** What the channel posted for a notification, as the workflow gets it. */
async function posted(
  notification: NotificationPayload,
  locale: "ar" | "en" = "en"
) {
  const { posts, transport } = recordPosts();
  await teamsChannel.send({ url }, sampleSend(notification, locale), transport);
  expect(posts).toHaveLength(1);
  const [post] = posts;
  const body = JSON.parse(post?.body ?? "{}");
  return { ...post, body, card: body.attachments?.[0]?.content };
}

const texts = (card: { body: { text: string }[] }) =>
  card.body.map((each) => each.text);

describe("the Teams channel", () => {
  test("a down notification in Arabic is posted to the workflow's URL as the recorded sample: an Adaptive Card of the subject, the sentence and one text block a line, the monitor's page as a button, read right to left", async () => {
    expect(await posted(sampleDown, "ar")).toEqual({
      body: {
        attachments: [
          {
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              actions: [
                {
                  title: "فتح المراقبة",
                  type: "Action.OpenUrl",
                  url: "https://status.example.test/admin/monitors/0199",
                },
              ],
              body: [
                {
                  color: "Attention",
                  size: "Medium",
                  text: "API: متعطّل",
                  type: "TextBlock",
                  weight: "Bolder",
                  wrap: true,
                },
                {
                  text: "المراقبة متعطّلة.",
                  type: "TextBlock",
                  wrap: true,
                },
                ...[
                  "المراقبة: API",
                  "الهدف: https://api.example.test/health",
                  "العلة: انتهت مهلة الانتظار",
                  "الوقت: 25 سبتمبر 2026، 9:49 م (غرينتش+3)",
                ].map((text) => ({
                  spacing: "None",
                  text,
                  type: "TextBlock",
                  wrap: true,
                })),
              ],
              msteams: { width: "Full" },
              rtl: true,
              type: "AdaptiveCard",
              version: "1.5",
            },
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
          },
        ],
        type: "message",
      },
      card: expect.anything(),
      headers: { "content-type": "application/json", "user-agent": "Raaqeb" },
      url,
    });
  });

  test("a card in English is read left to right, so it says nothing of direction", async () => {
    const { card } = await posted(sampleDown);
    expect(card.rtl).toBeUndefined();
    expect(texts(card)[0]).toBe("API is down");
  });

  test("the open-incident link follows the monitor's, each a button of the words that open it", async () => {
    const { card } = await posted({
      data: {
        incidentUrl: sampleIncidentUrl,
        monitor: sampleMonitor,
        reason: "timeout",
      },
      timestamp,
      type: "monitor.down",
    });
    expect(card.actions).toEqual([
      {
        title: "Open the monitor",
        type: "Action.OpenUrl",
        url: "https://status.example.test/admin/monitors/0199",
      },
      {
        title: "Open an incident",
        type: "Action.OpenUrl",
        url: sampleIncidentUrl,
      },
    ]);
  });

  test("a monitor with no admin link sends no buttons", async () => {
    const { card } = await posted(sampleDownOf({ adminUrl: undefined }));
    expect(card.actions).toBeUndefined();
  });

  test("the characters Teams reads as markdown are escaped outside URLs, so a monitor's name cannot make a link, a mention or a style", async () => {
    const { card } = await posted(
      sampleDownOf({
        name: "*b* [x](https://evil.example) <at>x</at> `c` ~d~ #e | _f_",
      })
    );
    expect(texts(card)[0]).toBe(
      "\\*b\\* \\[x\\](https://evil.example) \\<at\\>x\\</at\\> \\`c\\` \\~d\\~ \\#e \\| \\_f\\_ is down"
    );
    expect(texts(card).join("\n")).toContain(
      "Monitor: \\*b\\* \\[x\\](https://evil.example)"
    );
  });

  test("a URL is left whole, so an underscore in a target does not turn into emphasis or a backslash", async () => {
    const { card } = await posted(
      sampleDownOf({ target: "https://api.example.test/a_b_c?x=*1" })
    );
    expect(texts(card)).toContain(
      "Target: https://api.example.test/a_b_c?x=*1"
    );
  });

  test("the title's colour says how the event went: attention for down and its reminder, good for recovered and degraded ended, warning for degraded and an expiring certificate", async () => {
    const colourOf = async (notification: NotificationPayload) =>
      (await posted(notification)).card.body[0].color;
    const event = (type: string, data: object) =>
      ({
        data: { monitor: sampleMonitor, ...data },
        timestamp,
        type,
      }) as NotificationPayload;
    expect(await colourOf(sampleDown)).toBe("Attention");
    expect(
      await colourOf(
        event("monitor.reminder", { downForMs: 60_000, reason: "timeout" })
      )
    ).toBe("Attention");
    expect(
      await colourOf(event("monitor.recovered", { downtimeMs: 60_000 }))
    ).toBe("Good");
    expect(await colourOf(event("monitor.degraded_ended", {}))).toBe("Good");
    expect(
      await colourOf(event("monitor.degraded_started", { reason: "slow" }))
    ).toBe("Warning");
    expect(
      await colourOf(
        event("monitor.certificate_expiring", {
          certificate: { daysLeft: 14, notAfter: "2026-10-09T18:49:00.000Z" },
        })
      )
    ).toBe("Warning");
  });

  test("an expiring domain registration is a warning, as an expiring certificate is", async () => {
    const { card } = await posted({
      data: {
        domain: {
          daysLeft: 29,
          expiresAt: "2026-10-25T12:00:00.000Z",
          name: "raaqeb.dev",
        },
        monitor: sampleMonitor,
      },
      timestamp,
      type: "monitor.domain_expiring",
    });
    expect(card.body[0].color).toBe("Warning");
  });

  test("a channel's test is a card with no colour and no buttons", async () => {
    const { card } = await posted({
      data: { channel: { id: "ch1", name: "Ops chat" } },
      timestamp,
      type: "channel.test",
    });
    expect(texts(card)[0]).toBe("Test message from Raaqeb");
    expect(card.body[0].color).toBeUndefined();
    expect(card.actions).toBeUndefined();
    expect(texts(card).join("\n")).toContain("Channel: Ops chat");
  });
});

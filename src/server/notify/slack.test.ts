import { describe, expect, test } from "bun:test";
import {
  recordPosts,
  sampleDown,
  sampleDownOf,
  sampleDownText,
  sampleIncidentUrl,
  sampleMonitor,
  sampleSend,
} from "./fixture.ts";
import { slackChannel } from "./slack.ts";

const url =
  "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstuvwx";

describe("the Slack channel", () => {
  test("a down notification in Arabic is posted to the incoming webhook as the recorded sample, with Slack's formatting off and the monitor's link the words that open it", async () => {
    const { posts, transport } = recordPosts();
    await slackChannel.send({ url }, sampleSend(sampleDown), transport);
    expect(
      posts.map((each) => ({ ...each, body: JSON.parse(each.body) }))
    ).toEqual([
      {
        body: {
          mrkdwn: false,
          text: `${sampleDownText}\n<https://status.example.test/admin/monitors/0199|فتح المراقبة>`,
        },
        headers: { "content-type": "application/json", "user-agent": "Raaqeb" },
        url,
      },
    ]);
  });

  test("the characters Slack reads as markup are escaped, so a monitor's name cannot make a link or a mention", async () => {
    const { posts, transport } = recordPosts();
    await slackChannel.send(
      { url },
      sampleSend(
        sampleDownOf({ name: "<!channel> & <https://evil.example|API>" })
      ),
      transport
    );
    const { text } = JSON.parse(posts[0]?.body ?? "{}");
    expect(text).toStartWith(
      "&lt;!channel&gt; &amp; &lt;https://evil.example|API&gt;: متعطّل\n"
    );
    const lines = text.split("\n");
    expect(lines.slice(0, -1).join("\n")).not.toContain("<");
    expect(lines.at(-1)).toBe(
      "<https://status.example.test/admin/monitors/0199|فتح المراقبة>"
    );
  });

  test("the open-incident link follows the monitor's, each the words that open it on a line of its own", async () => {
    const { posts, transport } = recordPosts();
    await slackChannel.send(
      { url },
      sampleSend({
        data: {
          incidentUrl: sampleIncidentUrl,
          monitor: sampleMonitor,
          reason: "timeout",
        },
        timestamp: sampleDown.timestamp,
        type: "monitor.down",
      }),
      transport
    );
    expect(JSON.parse(posts[0]?.body ?? "{}").text).toEndWith(
      `\n<https://status.example.test/admin/monitors/0199|فتح المراقبة>\n<${sampleIncidentUrl}|فتح حادثة>`
    );
  });

  test("a link's address has Slack's markup characters escaped too, as Slack reads them back", async () => {
    const { posts, transport } = recordPosts();
    await slackChannel.send(
      { url },
      sampleSend(
        sampleDownOf({ adminUrl: "https://status.example.test/a?b=1&c=2" })
      ),
      transport
    );
    expect(JSON.parse(posts[0]?.body ?? "{}").text).toEndWith(
      "\n<https://status.example.test/a?b=1&amp;c=2|فتح المراقبة>"
    );
  });

  test("a monitor with no admin link sends no link", async () => {
    const { posts, transport } = recordPosts();
    await slackChannel.send(
      { url },
      sampleSend(sampleDownOf({ adminUrl: undefined })),
      transport
    );
    expect(JSON.parse(posts[0]?.body ?? "{}").text).toBe(sampleDownText);
  });
});

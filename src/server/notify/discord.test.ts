import { describe, expect, test } from "bun:test";
import { discordChannel } from "./discord.ts";
import {
  recordPosts,
  sampleDown,
  sampleDownOf,
  sampleDownText,
  sampleIncidentUrl,
  sampleMonitor,
  sampleSend,
} from "./fixture.ts";

const monitorLink =
  "[فتح المراقبة](<https://status.example.test/admin/monitors/0199>)";

const url =
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz";

/** What the channel posted for a monitor of this name, as the content Discord gets. */
async function contentFor(
  monitor: Partial<typeof sampleMonitor>
): Promise<string> {
  const { posts, transport } = recordPosts();
  await discordChannel.send(
    { url },
    sampleSend(sampleDownOf(monitor)),
    transport
  );
  return JSON.parse(posts[0]?.body ?? "{}").content;
}

describe("the Discord channel", () => {
  test("a down notification in Arabic is posted to the webhook as the recorded sample: the monitor's link a masked link of the words that open it, no one mentioned, no link preview", async () => {
    const { posts, transport } = recordPosts();
    await discordChannel.send({ url }, sampleSend(sampleDown), transport);
    expect(
      posts.map((each) => ({ ...each, body: JSON.parse(each.body) }))
    ).toEqual([
      {
        body: {
          allowed_mentions: { parse: [] },
          content: `${sampleDownText}\n${monitorLink}`,
          flags: 4,
        },
        headers: { "content-type": "application/json", "user-agent": "Raaqeb" },
        url,
      },
    ]);
  });

  test("markdown in a monitor's name is escaped, so it shows as typed and makes no link", async () => {
    const content = await contentFor({
      name: "# **API** _v2_ ~x~ `y` ||z|| > [open](https://evil.example) <@123>",
    });
    expect(content.split("\n")[0]).toBe(
      "\\# \\*\\*API\\*\\* \\_v2\\_ \\~x\\~ \\`y\\` \\|\\|z\\|\\| \\> \\[open\\](https://evil.example) \\<@123\\>: متعطّل"
    );
  });

  test("a URL ends where Discord's link ends, at <, so a mention glued to it is escaped", async () => {
    const content = await contentFor({ name: "x https://a.b/y<@&1> **b**" });
    expect(content.split("\n")[0]).toBe(
      "x https://a.b/y\\<@&1\\> \\*\\*b\\*\\*: متعطّل"
    );
  });

  test("a backslash and a dash are escaped too, so a name cannot undo an escape or start a list", async () => {
    const content = await contentFor({ name: "- a\\b" });
    expect(content.split("\n")[0]).toBe("\\- a\\\\b: متعطّل");
  });

  test("a URL stays whole, its underscores unescaped, so the link still opens", async () => {
    const plain = await contentFor({ target: "http://10.0.0.5/health_check" });
    expect(plain).toContain("\nالهدف: http://10.0.0.5/health_check\n");
    const content = await contentFor({
      target: "https://api.example.test/health_check?a=1&b=*",
    });
    expect(content).toContain(
      "\nالهدف: https://api.example.test/health_check?a=1&b=*\n"
    );
  });

  test("the open-incident link follows the monitor's, each a masked link on a line of its own", async () => {
    const { posts, transport } = recordPosts();
    await discordChannel.send(
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
    expect(JSON.parse(posts[0]?.body ?? "{}").content).toEndWith(
      `\n${monitorLink}\n[فتح حادثة](<${sampleIncidentUrl}>)`
    );
  });

  test("a parenthesis in a link's address is percent-encoded, so it cannot end the masked link", async () => {
    const content = await contentFor({
      adminUrl: "https://status.example.test/admin/monitors/a(b)c",
    });
    expect(content.split("\n").at(-1)).toBe(
      "[فتح المراقبة](<https://status.example.test/admin/monitors/a%28b%29c>)"
    );
  });

  test("a cut never ends inside an escape, so no lone backslash escapes the ellipsis (Fledge review)", async () => {
    const contents = await Promise.all(
      ["*".repeat(3000), `a${"*".repeat(3000)}`].map((name) =>
        contentFor({ name })
      )
    );
    for (const content of contents) {
      expect(content.length).toBeLessThanOrEqual(2000);
      expect(content).toEndWith(`…\n${monitorLink}`);
      expect(content.split("…")[0]).toEndWith("\\*");
    }
  });

  test("a monitor with no admin link sends no link", async () => {
    expect(await contentFor({ adminUrl: undefined })).toBe(sampleDownText);
  });

  test("a message past Discord's 2,000 characters is cut to 2,000, the cut ending in an ellipsis before the link, which stays whole", async () => {
    const content = await contentFor({
      target: `https://api.example.test/${"a".repeat(3000)}`,
    });
    expect(content.length).toBe(2000);
    expect(content).toEndWith(`…\n${monitorLink}`);
  });
});

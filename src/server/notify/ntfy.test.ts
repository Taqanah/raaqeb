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
import { ntfyChannel } from "./ntfy.ts";

const values = {
  server: "https://ntfy.sh",
  token: "tk_21ehc0ketei2tixtux2xcqx3mhx3e",
  topic: "raaqeb-alerts-7f3k",
};

/** What the channel published for a notification, as ntfy gets it. */
async function published(
  notification: NotificationPayload,
  config: Record<string, string> = values
) {
  const { posts, transport } = recordPosts();
  await ntfyChannel.send(config, sampleSend(notification), transport);
  const [post] = posts;
  return { ...post, body: JSON.parse(post?.body ?? "{}") };
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("the ntfy channel", () => {
  test("a down notification in Arabic is published as the recorded sample: the subject as its title, the body without its link as its message, the monitor's page on a tap and on a button of the words that open it, high priority", async () => {
    expect(await published(sampleDown)).toEqual({
      body: {
        actions: [
          {
            action: "view",
            label: "فتح المراقبة",
            url: "https://status.example.test/admin/monitors/0199",
          },
        ],
        click: "https://status.example.test/admin/monitors/0199",
        message:
          "المراقبة متعطّلة.\n\nالمراقبة: API\nالهدف: https://api.example.test/health\nالعلة: انتهت مهلة الانتظار\nالوقت: 25 سبتمبر 2026، 9:49 م (غرينتش+3)",
        priority: 4,
        title: "API: متعطّل",
        topic: "raaqeb-alerts-7f3k",
      },
      headers: {
        authorization: "Bearer tk_21ehc0ketei2tixtux2xcqx3mhx3e",
        "content-type": "application/json",
        "user-agent": "Raaqeb",
      },
      url: "https://ntfy.sh/",
    });
  });

  test("with no access token no authorization is sent", async () => {
    const { headers } = await published(sampleDown, {
      server: "https://ntfy.sh",
      topic: "raaqeb-alerts-7f3k",
    });
    expect(headers).toEqual({
      "content-type": "application/json",
      "user-agent": "Raaqeb",
    });
  });

  test("the publish goes to the server's root, whether or not its address ends in a slash", async () => {
    const urls = await Promise.all(
      ["http://10.0.0.5:8080", "http://10.0.0.5:8080/"].map(
        async (server) =>
          (await published(sampleDown, { ...values, server })).url
      )
    );
    expect(urls).toEqual(["http://10.0.0.5:8080/", "http://10.0.0.5:8080/"]);
  });

  test("down and its reminder are high priority, as the monitor is still down; recovered, degraded, the certificate warning and a test are the default", async () => {
    const reminder: NotificationPayload = {
      data: { downForMs: 3_600_000, monitor: sampleMonitor, reason: "timeout" },
      timestamp: sampleDown.timestamp,
      type: "monitor.reminder",
    };
    const recovered: NotificationPayload = {
      data: { downtimeMs: 754_000, monitor: sampleMonitor },
      timestamp: sampleDown.timestamp,
      type: "monitor.recovered",
    };
    const degraded: NotificationPayload = {
      data: { monitor: sampleMonitor, reason: "slow" },
      timestamp: sampleDown.timestamp,
      type: "monitor.degraded_started",
    };
    const ended: NotificationPayload = {
      data: { monitor: sampleMonitor },
      timestamp: sampleDown.timestamp,
      type: "monitor.degraded_ended",
    };
    const certificate: NotificationPayload = {
      data: {
        certificate: { daysLeft: 1, notAfter: "2026-09-26T18:49:00.000Z" },
        monitor: sampleMonitor,
      },
      timestamp: sampleDown.timestamp,
      type: "monitor.certificate_expiring",
    };
    const channelTest: NotificationPayload = {
      data: { channel: { id: "c1", name: "هاتف المناوب" } },
      timestamp: sampleDown.timestamp,
      type: "channel.test",
    };
    const all = await Promise.all(
      [
        sampleDown,
        reminder,
        recovered,
        degraded,
        ended,
        certificate,
        channelTest,
      ].map((each) => published(each))
    );
    expect(all.map((each) => each.body.priority)).toEqual([
      4, 4, 3, 3, 3, 3, 3,
    ]);
  });

  test("the open-incident link is a second button after the monitor's, and leaves the message", async () => {
    const { body } = await published({
      data: {
        incidentUrl: sampleIncidentUrl,
        monitor: sampleMonitor,
        reason: "timeout",
      },
      timestamp: sampleDown.timestamp,
      type: "monitor.down",
    });
    expect(body.actions).toEqual([
      {
        action: "view",
        label: "فتح المراقبة",
        url: "https://status.example.test/admin/monitors/0199",
      },
      { action: "view", label: "فتح حادثة", url: sampleIncidentUrl },
    ]);
    expect(body.message).not.toContain("https://status.example.test");
  });

  test("a test, or a monitor with no admin link, opens nothing on a tap and has no button", async () => {
    const channelTest = await published({
      data: { channel: { id: "c1", name: "هاتف المناوب" } },
      timestamp: sampleDown.timestamp,
      type: "channel.test",
    });
    expect(channelTest.body).not.toHaveProperty("click");
    expect(channelTest.body).not.toHaveProperty("actions");
    const unlinked = await published(sampleDownOf({ adminUrl: undefined }));
    expect(unlinked.body).not.toHaveProperty("click");
    expect(unlinked.body).not.toHaveProperty("actions");
  });

  test("a message past 4,095 UTF-8 bytes and a title past 1,024 are cut to fit, since ntfy never cuts and refuses them", async () => {
    const { body } = await published(
      sampleDownOf({
        name: "م".repeat(700),
        target: `https://api.example.test/${"a".repeat(5000)}`,
      })
    );
    expect(bytes(body.message)).toBeLessThanOrEqual(4095);
    expect(bytes(body.message)).toBeGreaterThan(4090);
    expect(body.message).toEndWith("…");
    expect(bytes(body.title)).toBeLessThanOrEqual(1024);
    expect(body.title).toEndWith("…");
  });
});

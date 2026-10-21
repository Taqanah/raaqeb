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
import { pagerdutyChannel } from "./pagerduty.ts";

const values = { routingKey: "R0uT1nGk3yR0uT1nGk3yR0uT1nGk3yAb" };
const timestamp = "2026-09-25T18:49:00.000Z";

/** What the channel posted for a notification, as PagerDuty gets it: every post, in order. */
async function postedAll(
  notification: NotificationPayload,
  locale: "ar" | "en" = "en"
) {
  const { posts, transport } = recordPosts();
  await pagerdutyChannel.send(
    values,
    sampleSend(notification, locale),
    transport
  );
  return posts.map((post) => ({ ...post, body: JSON.parse(post.body) }));
}

/** The event a notification is about, its first post; a down notification sends a second, which its own test reads. */
async function posted(
  notification: NotificationPayload,
  locale: "ar" | "en" = "en"
) {
  const posts = await postedAll(notification, locale);
  expect(posts).toHaveLength(notification.type === "monitor.down" ? 2 : 1);
  return posts[0] ?? { body: undefined, headers: {}, url: "" };
}

const recovered: NotificationPayload = {
  data: { downtimeMs: 12 * 60_000, monitor: sampleMonitor },
  timestamp,
  type: "monitor.recovered",
};
const reminder: NotificationPayload = {
  data: { downForMs: 3_600_000, monitor: sampleMonitor, reason: "timeout" },
  timestamp,
  type: "monitor.reminder",
};
const degradedStarted: NotificationPayload = {
  data: { monitor: sampleMonitor, reason: "slow" },
  timestamp,
  type: "monitor.degraded_started",
};
const degradedEnded: NotificationPayload = {
  data: { monitor: sampleMonitor },
  timestamp,
  type: "monitor.degraded_ended",
};
const certificate: NotificationPayload = {
  data: {
    certificate: { daysLeft: 14, notAfter: "2026-10-09T18:49:00.000Z" },
    monitor: sampleMonitor,
  },
  timestamp,
  type: "monitor.certificate_expiring",
};
const domain: NotificationPayload = {
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
};

describe("the PagerDuty channel", () => {
  test("a down notification in Arabic triggers a critical alert on the Events API as the recorded sample: the subject as its summary, the target as its source, the text as its details and the monitor's page as a link", async () => {
    expect(await posted(sampleDown, "ar")).toEqual({
      body: {
        dedup_key: "raaqeb:0199:down",
        event_action: "trigger",
        links: [
          {
            href: "https://status.example.test/admin/monitors/0199",
            text: "فتح المراقبة",
          },
        ],
        payload: {
          custom_details: {
            details:
              "المراقبة متعطّلة.\n\nالمراقبة: API\nالهدف: https://api.example.test/health\nالعلة: انتهت مهلة الانتظار\nالوقت: 25 سبتمبر 2026، 9:49 م (غرينتش+3)",
          },
          severity: "critical",
          source: "https://api.example.test/health",
          summary: "API: متعطّل",
          timestamp: "2026-09-25T18:49:00.000Z",
        },
        routing_key: values.routingKey,
      },
      headers: { "content-type": "application/json", "user-agent": "Raaqeb" },
      url: "https://events.pagerduty.com/v2/enqueue",
    });
  });

  test("a down notification also resolves the monitor's degraded alert, since a degraded monitor that goes down sends no degraded-ended notification and the alert would stay open", async () => {
    const [trigger, resolve] = await postedAll(sampleDown);
    expect(trigger?.body.event_action).toBe("trigger");
    expect(trigger?.body.dedup_key).toBe("raaqeb:0199:down");
    expect(resolve?.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(resolve?.body).toMatchObject({
      dedup_key: "raaqeb:0199:degraded",
      event_action: "resolve",
      routing_key: values.routingKey,
    });
    expect(resolve?.body.payload.summary).toBe("API is down");
  });

  test("the open-incident link follows the monitor's, each with the words that open it", async () => {
    const { body } = await posted({
      data: {
        incidentUrl: sampleIncidentUrl,
        monitor: sampleMonitor,
        reason: "timeout",
      },
      timestamp,
      type: "monitor.down",
    });
    expect(body.links).toEqual([
      {
        href: "https://status.example.test/admin/monitors/0199",
        text: "Open the monitor",
      },
      { href: sampleIncidentUrl, text: "Open an incident" },
    ]);
  });

  test("a monitor with no admin link sends no links", async () => {
    const { body } = await posted(sampleDownOf({ adminUrl: undefined }));
    expect(body.links).toBeUndefined();
  });

  test("recovered resolves the alert its outage's down notification opened, under the same dedup key and routing key", async () => {
    const opened = (await posted(sampleDown)).body;
    const { body } = await posted(recovered);
    expect(body.event_action).toBe("resolve");
    expect(body.dedup_key).toBe(opened.dedup_key);
    expect(body.routing_key).toBe(opened.routing_key);
    expect(body.payload.summary).toBe("API is up again");
  });

  test("a probe gone silent is a warning under the probe's own dedup key, and reporting again resolves it", async () => {
    const silent: NotificationPayload = {
      data: {
        lastHeardAt: "2026-09-25T18:47:00.000Z",
        probe: { id: "p1", name: "Frankfurt" },
      },
      timestamp,
      type: "probe.silent",
    };
    const opened = (await posted(silent)).body;
    expect(opened.event_action).toBe("trigger");
    expect(opened.payload.severity).toBe("warning");
    expect(opened.dedup_key).toBe("raaqeb:probe:p1:silent");
    const closed = (await posted({ ...silent, type: "probe.reporting" })).body;
    expect(closed.event_action).toBe("resolve");
    expect(closed.dedup_key).toBe(opened.dedup_key);
  });

  test("a reminder triggers again under the outage's dedup key, so it joins the open alert instead of opening a second", async () => {
    const { body } = await posted(reminder);
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe((await posted(sampleDown)).body.dedup_key);
    expect(body.payload.severity).toBe("critical");
  });

  test("a degraded period is a warning under its own dedup key, and its end resolves it, so an outage's alert is not touched", async () => {
    const started = (await posted(degradedStarted)).body;
    const ended = (await posted(degradedEnded)).body;
    expect(started.event_action).toBe("trigger");
    expect(started.payload.severity).toBe("warning");
    expect(ended.event_action).toBe("resolve");
    expect(ended.dedup_key).toBe(started.dedup_key);
    expect(started.dedup_key).toBe("raaqeb:0199:degraded");
    expect(started.dedup_key).not.toBe(
      (await posted(sampleDown)).body.dedup_key
    );
  });

  test("an expiring certificate is a warning under its own dedup key, and a second warning for it joins the same alert", async () => {
    const { body } = await posted(certificate);
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("warning");
    expect(body.dedup_key).toBe("raaqeb:0199:certificate");
    expect(body.payload.custom_details.details).toContain("Time left: 14 days");
  });

  test("an expiring domain registration is a warning under its own dedup key, never the certificate's, and a second warning for it joins the same alert", async () => {
    const { body } = await posted(domain);
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("warning");
    expect(body.dedup_key).toBe("raaqeb:0199:domain");
    expect(body.dedup_key).not.toBe((await posted(certificate)).body.dedup_key);
    expect(body.payload.custom_details.details).toContain("raaqeb.dev");
    expect((await posted(domain)).body.dedup_key).toBe(body.dedup_key);
  });

  test("two monitors never share a dedup key", async () => {
    const other = await posted(sampleDownOf({ id: "0200" }));
    expect(other.body.dedup_key).toBe("raaqeb:0200:down");
  });

  test("a heartbeat monitor, which has no target, is its own source", async () => {
    const { body } = await posted({
      data: {
        monitor: { ...sampleMonitor, target: null },
        reason: "timeout",
      },
      timestamp,
      type: "monitor.down",
    });
    expect(body.payload.source).toBe("API");
  });

  test("a channel's test opens an info alert under the channel's own dedup key, with no links", async () => {
    const { body } = await posted({
      data: { channel: { id: "ch1", name: "On call" } },
      timestamp,
      type: "channel.test",
    });
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("info");
    expect(body.dedup_key).toBe("raaqeb:ch1:test");
    expect(body.payload.source).toBe("Raaqeb");
    expect(body.payload.summary).toBe("Test message from Raaqeb");
    expect(body.payload.custom_details.details).toContain("On call");
    expect(body.links).toBeUndefined();
  });

  test("the summary is cut to the 1024 characters the Events API takes, ending in an ellipsis", async () => {
    const { body } = await posted(sampleDownOf({ name: "x".repeat(3000) }));
    expect(body.payload.summary).toHaveLength(1024);
    expect(body.payload.summary).toEndWith("…");
  });
});

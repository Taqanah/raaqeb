/**
 * PagerDuty: one Events API v2 event to a service's integration, which
 * opens an alert for an outage, a degraded period, an expiring
 * certificate or an expiring domain registration and resolves it when the
 * monitor recovers. The alert's
 * dedup key is the monitor and the kind of problem, so a reminder joins the
 * open alert, the next outage opens a new one once this one is resolved, and
 * a certificate or domain warning stays open until someone resolves it, since
 * no notification says the certificate or the domain was renewed. A monitor that goes from
 * degraded to down sends no degraded-ended notification, so its down
 * notification also resolves the degraded alert; resolving a closed alert
 * does nothing.
 */
import { pagerdutyDeclaration } from "@/shared/schemas/channel.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import { jsonHeaders, type NotificationChannel } from "./channel.ts";
import { clip, notificationText, plainText } from "./text.ts";

/** The Events API v2 endpoint; PagerDuty forwards a key from its EU service region. */
export const pagerdutyUrl = "https://events.pagerduty.com/v2/enqueue";

/** The longest summary the Events API takes. */
const summaryMax = 1024;

/** What an event does to which alert: trigger or resolve the monitor's alert of one kind, at this severity. */
const alerts: Readonly<
  Record<
    Exclude<NotificationPayload["type"], "channel.test">,
    {
      readonly action: "resolve" | "trigger";
      readonly kind: "certificate" | "degraded" | "domain" | "down";
      readonly severity: "critical" | "info" | "warning";
    }
  >
> = {
  "monitor.certificate_expiring": {
    action: "trigger",
    kind: "certificate",
    severity: "warning",
  },
  "monitor.domain_expiring": {
    action: "trigger",
    kind: "domain",
    severity: "warning",
  },
  "monitor.degraded_ended": {
    action: "resolve",
    kind: "degraded",
    severity: "info",
  },
  "monitor.degraded_started": {
    action: "trigger",
    kind: "degraded",
    severity: "warning",
  },
  "monitor.down": { action: "trigger", kind: "down", severity: "critical" },
  "monitor.recovered": { action: "resolve", kind: "down", severity: "info" },
  "monitor.reminder": { action: "trigger", kind: "down", severity: "critical" },
};

/** The alert a notification is about: what to do to it, its dedup key, its severity and the system it names. A test opens an info alert of its own, which the next test joins. */
function alertOf(notification: NotificationPayload) {
  if (notification.type === "channel.test") {
    return {
      action: "trigger",
      key: `raaqeb:${notification.data.channel.id}:test`,
      severity: "info",
      source: "Raaqeb",
    };
  }
  const { monitor } = notification.data;
  const { action, kind, severity } = alerts[notification.type];
  return {
    action,
    key: `raaqeb:${monitor.id}:${kind}`,
    severity,
    source: monitor.target ?? monitor.name,
  };
}

export const pagerdutyChannel: NotificationChannel = {
  declaration: pagerdutyDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const { notification } = payload;
    const text = await notificationText(payload);
    const { action, key, severity, source } = alertOf(notification);
    const links = text.links.map(({ url, words }) => ({
      href: url,
      text: words,
    }));
    const post = (eventAction: string, dedupKey: string) =>
      transport.post(pagerdutyUrl, {
        body: JSON.stringify({
          dedup_key: dedupKey,
          event_action: eventAction,
          payload: {
            custom_details: {
              details: plainText({ ...text, links: [] }).trimEnd(),
            },
            severity,
            source,
            summary: clip(text.subject, summaryMax),
            timestamp: notification.timestamp,
          },
          routing_key: values.routingKey,
          ...(links.length === 0 ? {} : { links }),
        }),
        headers: jsonHeaders,
      });
    await post(action, key);
    // The trigger goes first, so the page is never held behind the resolve; a failed resolve retries both, which the dedup key makes harmless.
    if (notification.type === "monitor.down") {
      await post("resolve", `raaqeb:${notification.data.monitor.id}:degraded`);
    }
  },
};

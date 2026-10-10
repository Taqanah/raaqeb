/**
 * The notification preview (CONTEXT.md "Notification preview"):
 * each operator notification a channel can receive, built for a sample
 * monitor by the payload builders the scheduler uses (operator.ts) and
 * written by the text the channels send (text.ts), so a wording change
 * shows here at once. Sample values only: a made-up monitor and target, the
 * time `now` on the install's clock and calendar, a sample downtime and time left; never
 * a stored monitor and never a secret. It reads and writes nothing.
 */

import type { MonitorEvent } from "@/server/scheduler/schedule.ts";
import { loadCatalog } from "@/server/settings/language.ts";
import type { TimeOptions } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { tlsExpiryDefaultDays } from "@/shared/schemas/certificate.ts";
import type {
  ChannelType,
  NotificationPreview,
} from "@/shared/schemas/channel.ts";
import {
  type Monitor,
  monitorFieldsSchema,
  reminderDefaultMs,
} from "@/shared/schemas/monitor.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import type { ChannelPayload } from "./channel.ts";
import { notificationHtml } from "./email.ts";
import { notificationOf, reminderOf } from "./operator.ts";
import { telegramLinks } from "./telegram.ts";
import { chatText, notificationText, plainText } from "./text.ts";

/** What the preview is written with: the channel language, the install's clock and calendar, and the stored public address its links start from. */
export interface PreviewContext {
  readonly locale: Locale;
  readonly publicAddress: string | undefined;
  readonly time: TimeOptions;
}

const sampleId = "00000000-0000-7000-8000-000000000000";
const sampleTarget = "https://example.com";
const sampleDowntimeMs = 12 * 60_000;
const dayMs = 86_400_000;

type Shown = Pick<
  NotificationPreview,
  "body" | "buttons" | "html" | "links" | "subject"
>;

const chat = async (payload: ChannelPayload): Promise<Shown> => {
  const text = await notificationText(payload);
  return {
    body: chatText(text),
    buttons: [],
    html: undefined,
    links: text.links.map(({ url, words }) => ({ url, words })),
    subject: undefined,
  };
};

/** What each type's message carries of a notification, as its receiver shows it: a chat message's links as the words that open them, ntfy's as its buttons; Slack's, Discord's and Telegram's markup escapes and the length cuts are left out, since the receiver undoes the first and no sample reaches the second. */
const shownBy: Readonly<
  Record<ChannelType, (payload: ChannelPayload) => Promise<Shown>>
> = {
  discord: chat,
  email: async (payload) => {
    const text = await notificationText(payload);
    return {
      body: plainText(text),
      buttons: [],
      html: notificationHtml(payload, text),
      links: [],
      subject: text.subject,
    };
  },
  ntfy: async (payload) => {
    const text = await notificationText(payload);
    return {
      body: plainText({ ...text, links: [] }).trimEnd(),
      buttons: text.links.map(({ url, words }) => ({ url, words })),
      html: undefined,
      links: [],
      subject: text.subject,
    };
  },
  slack: chat,
  // Telegram writes a link it would drop as its plain line (telegram.ts).
  telegram: async (payload) => {
    const text = await notificationText(payload);
    const plain = text.links.filter((each) => !telegramLinks(each.url));
    return {
      body: [chatText(text), ...plain.map((each) => each.line)].join("\n"),
      buttons: [],
      html: undefined,
      links: text.links
        .filter((each) => telegramLinks(each.url))
        .map(({ url, words }) => ({ url, words })),
      subject: undefined,
    };
  },
  // The JSON body as sent, indented to be read.
  webhook: (payload) =>
    Promise.resolve({
      body: JSON.stringify(payload.notification, null, 2),
      buttons: [],
      html: undefined,
      links: [],
      subject: undefined,
    }),
};

/** An HTTPS monitor that notifies every event and reminds at the default interval. */
function sampleMonitor(name: string): Monitor {
  return {
    ...monitorFieldsSchema.parse({
      config: {
        tlsExpiryDays: tlsExpiryDefaultDays,
        type: "http",
        url: sampleTarget,
      },
      degradedMs: 1000,
      intervalMs: 60_000,
      name,
      reminderMs: reminderDefaultMs,
      retries: 0,
      timeoutMs: 10_000,
    }),
    createdAt: 0,
    id: sampleId,
    paused: false,
    target: sampleTarget,
    updatedAt: 0,
  };
}

function outage(startedAt: number, endedAt?: number): Outage {
  return { endedAt, monitorId: sampleId, reason: reasons.timeout, startedAt };
}

/** Every operator notification a channel of the type can receive, as that type carries it, the sample monitor's events happening at `now`. */
export async function previewNotifications(
  type: ChannelType,
  context: PreviewContext,
  now: number
): Promise<NotificationPreview[]> {
  const { locale, time } = context;
  const messages = createMessages(locale, await loadCatalog(locale));
  const monitor = sampleMonitor(messages._("channel_preview_monitor"));
  const base = { at: now, monitorId: sampleId };
  const events: MonitorEvent[] = [
    { ...base, kind: "down", outage: outage(now), reason: reasons.timeout },
    {
      ...base,
      kind: "recovered",
      outage: outage(now - sampleDowntimeMs, now),
      reason: reasons.ok,
    },
    { ...base, kind: "degraded_started", reason: reasons.slow },
    { ...base, kind: "degraded_ended", reason: reasons.ok },
    {
      ...base,
      kind: "certificate_expiring",
      validTo: now + tlsExpiryDefaultDays * dayMs,
      warning: "threshold",
    },
  ];
  const [down, ...others] = events.map((event) =>
    notificationOf(event, monitor, context)
  );
  // The reminder repeats the down notification, so it follows it.
  const notifications = [
    down,
    reminderOf(monitor, outage(now - reminderDefaultMs), context, now),
    ...others,
  ].filter((each) => each !== undefined && each.type !== "channel.test");
  return Promise.all(
    notifications.map(async (notification) => ({
      ...(await shownBy[type]({ id: sampleId, locale, notification, time })),
      type: notification.type,
    }))
  );
}

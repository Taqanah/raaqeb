/**
 * Subscriber notifications (CONTEXT.md "Subscriber notification"). An event (incident published,
 * incident updated, maintenance scheduled, rescheduled, started, completed
 * or cancelled) reaches every
 * confirmed subscription of every status page that shows a component it
 * touches, through the queue and its retry rule; a pending
 * subscription gets its confirmation and nothing else. Each page's copy of
 * the event is built in each subscription language, its content in that
 * locale and else in the page language, its links to that locale's
 * views, and is stored as it was
 * queued. At send time a subscription that no
 * longer takes the message is dropped without a send, and so is anything for
 * a page that is no longer published, a confirmation included, and no
 * event is queued for one.
 *
 * Email goes through the email channel that sends sign-in mail, in the
 * subscription language, with the `List-Unsubscribe` pair (RFC 8058). A
 * webhook gets Statuspage's body for an event and Raaqeb's own for its
 * confirmation, with `webhook-id` and `webhook-timestamp` and no signature,
 * and only while its host is on the public internet.
 */

import { authEmailChannelOf } from "@/server/auth/mail.ts";
import { decrypt, type InstallKey } from "@/server/boot/installkey.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import { canonicalPaths } from "@/server/pages/public.ts";
import {
  readIncidentEvent,
  readMaintenanceEvent,
  type WindowChange,
} from "@/server/pages/summary.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import { readClock } from "@/server/settings/clock.ts";
import { loadCatalog } from "@/server/settings/language.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { StoredSubscription } from "@/server/storage/subscriptions.ts";
import { affectedComponents } from "@/shared/domain/incidents.ts";
import {
  formatDateTimeWithZone,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import { type Locale, locales } from "@/shared/i18n/locale.ts";
import { createMessages, type MessageId } from "@/shared/i18n/messages.ts";
import { type ChannelValues, senderOf } from "@/shared/schemas/channel.ts";
import { contentIn } from "@/shared/schemas/content.ts";
import type { ImpactLevel, IncidentStage } from "@/shared/schemas/incident.ts";
import type {
  MaintenanceStage,
  MaintenanceWindow,
} from "@/shared/schemas/maintenance.ts";
import type { SendFailure } from "@/shared/schemas/notification.ts";
import { plainUrl } from "@/shared/schemas/overview.ts";
import {
  type ConfirmationWebhook,
  type SubscriberEventType,
  type SubscriberNotification,
  type SubscriberPayload,
  type SubscriberWebhook,
  subscriptionPath,
} from "@/shared/schemas/subscription.ts";
import {
  attempt,
  type DeliverIo,
  jsonHeaders,
  type SendOutcome,
  secretsOf,
  urlSecrets,
} from "./channel.ts";
import { lookupHost, webhookReachable } from "./destination.ts";
import { emailChannel, sendMail } from "./email.ts";
import { mailHtml } from "./html.ts";
import type { NotificationQueue } from "./queue.ts";
import { channelValues, unreadableSecrets } from "./secrets.ts";

/** One subscriber event as a module hands it on: what happened and to what. */
export type SubscriberEvent =
  | {
      readonly incidentId: string;
      readonly type: "incident.published" | "incident.updated";
    }
  | {
      readonly type:
        | "maintenance.scheduled"
        | "maintenance.rescheduled"
        | "maintenance.started"
        | "maintenance.completed";
      readonly windowId: string;
    }
  | {
      /** When the window was cancelled. */
      readonly at: number;
      readonly type: "maintenance.cancelled";
      /** The window as it was read before its delete, since the row is gone by the time the event is queued. */
      readonly window: MaintenanceWindow;
    };

/** How the incident and maintenance modules hand on an event; the routes pass the scheduler's, a test a recorder. */
export type Announce = (event: SubscriberEvent) => Promise<void>;

/** An announce that sends nothing: no scheduler runs (onboarding, `vite dev`). */
export const announceNothing: Announce = () => Promise.resolve();

/** The announce a route hands a module: the scheduler's subscriber notifications, at the moment of the write, or nothing when no scheduler runs. */
export function announceThrough(
  subscribers: Pick<SubscriberNotifications, "announce"> | undefined
): Announce {
  return subscribers
    ? (event) => subscribers.announce(event, Date.now())
    : announceNothing;
}

export type SubscriberStorage = Pick<
  Storage,
  | "channels"
  | "checks"
  | "components"
  | "incidents"
  | "maintenance"
  | "monitors"
  | "outages"
  | "pages"
  | "settings"
  | "subscriptions"
>;

export interface SubscriberNotifications {
  /** Queues the event for every confirmed subscription whose page shows a component it touches. Never throws; a failure is logged. */
  readonly announce: (event: SubscriberEvent, now: number) => Promise<void>;
  /** Queues the confirmation of a pending subscription; answers whether it was queued. */
  readonly confirm: (subscriptionId: string, now: number) => Promise<boolean>;
  /** Resolves once no announcement is being queued; stop waits on it. */
  readonly idle: () => Promise<void>;
}

export interface SubscriberOptions {
  /** Whether the scheduler has stopped; nothing more is queued. */
  readonly isStopped: () => boolean;
}

export function createSubscriberNotifications(
  storage: SubscriberStorage,
  queue: Pick<NotificationQueue, "enqueueSubscribers">,
  options: SubscriberOptions
): SubscriberNotifications {
  /** Announcements being queued, which stop waits for. */
  const underway = new Set<Promise<void>>();

  async function announced(event: SubscriberEvent, now: number) {
    try {
      // Each page's copy is built once per subscription language, its content in that locale.
      for (const locale of locales) {
        // biome-ignore lint/performance/noAwaitInLoops: one locale's copies after the other's
        const payloads = await subscriberPayloads(storage, event, locale);
        if (payloads.length === 0) {
          return;
        }
        const confirmed = await storage.subscriptions.confirmed(
          payloads.map(({ pageId }) => pageId)
        );
        for (const { pageId, payload } of payloads) {
          const ids = confirmed
            .filter((each) => each.pageId === pageId && each.locale === locale)
            .map((each) => each.id);
          if (ids.length > 0 && !options.isStopped()) {
            // biome-ignore lint/performance/noAwaitInLoops: each page's copy is queued after the one before it
            await queue.enqueueSubscribers(ids, payload, now);
          }
        }
      }
    } catch (error) {
      logError(
        `the ${event.type} event of ${subjectOf(event)} could not be queued for its subscribers: ${reasonOf(error)}`
      );
    }
  }

  return {
    announce: (event, now) => {
      const work = announced(event, now);
      underway.add(work);
      return work.finally(() => underway.delete(work));
    },
    confirm: async (subscriptionId, now) => {
      try {
        const subscription = await storage.subscriptions.find(subscriptionId);
        if (subscription?.status !== "pending" || options.isStopped()) {
          return false;
        }
        const [page, address] = await Promise.all([
          storage.pages.find(subscription.pageId),
          readPublicAddress(storage),
        ]);
        if (!page) {
          return false;
        }
        await queue.enqueueSubscribers(
          [subscription.id],
          {
            page: {
              id: page.id,
              name: contentIn(page.title, subscription.locale, page.locale),
              url: plainUrl(canonicalPaths(page, address), subscription.locale),
            },
            timestamp: iso(subscription.requestedAt),
            type: "subscription.confirmation",
          },
          now
        );
        return true;
      } catch {
        return false;
      }
    },
    idle: async () => {
      await Promise.all(underway);
    },
  };
}

/** The window events that say more than the move of its stage. */
const windowChanges: Partial<
  Record<SubscriberEventType, WindowChange["kind"]>
> = {
  "maintenance.cancelled": "cancelled",
  "maintenance.rescheduled": "rescheduled",
};

/** The event as each page it reaches stores it: one payload for every page that shows a component it touches, its content in `locale` and else in the page language, or each page's own language with none. */
export async function subscriberPayloads(
  storage: SubscriberStorage,
  event: SubscriberEvent,
  locale?: Locale
): Promise<{ readonly pageId: string; readonly payload: SubscriberPayload }[]> {
  const [pages, shown, address] = await Promise.all([
    storage.pages.list(),
    storage.pages.componentsShown(),
    readPublicAddress(storage),
  ]);
  // An unpublished page's subscribers hear nothing.
  const reaching = (componentIds: readonly string[]) =>
    pages.filter(
      (page) =>
        page.published &&
        (shown.get(page.id) ?? []).some((id) => componentIds.includes(id))
    );
  const payloads: { pageId: string; payload: SubscriberPayload }[] = [];
  if ("incidentId" in event) {
    const incident = await storage.incidents.find(event.incidentId);
    if (!incident) {
      return [];
    }
    const update =
      event.type === "incident.published"
        ? incident.updates[0]
        : incident.updates.at(-1);
    for (const page of reaching(affectedComponents(incident))) {
      // biome-ignore lint/performance/noAwaitInLoops: a few pages, each read on its own
      const reached = await readIncidentEvent(
        storage,
        page.id,
        canonicalPaths(page, address),
        incident,
        locale
      );
      if (reached) {
        payloads.push({
          pageId: page.id,
          payload: {
            ...reached,
            timestamp: iso(update?.createdAt ?? incident.createdAt),
            type: event.type,
          },
        });
      }
    }
    return payloads;
  }
  // A cancelled window's row is gone; the event carries it as read before the delete.
  const window =
    "window" in event
      ? event.window
      : await storage.maintenance.find(event.windowId);
  if (!window) {
    return [];
  }
  const at =
    event.type === "maintenance.cancelled"
      ? event.at
      : {
          "maintenance.completed": window.endsAt,
          "maintenance.rescheduled": window.updatedAt,
          "maintenance.scheduled": window.createdAt,
          "maintenance.started": window.startsAt,
        }[event.type];
  const kind = windowChanges[event.type];
  const change: WindowChange | undefined = kind && { at, kind };
  for (const page of reaching(window.componentIds)) {
    // biome-ignore lint/performance/noAwaitInLoops: a few pages, each read on its own
    const reached = await readMaintenanceEvent(
      storage,
      page.id,
      canonicalPaths(page, address),
      window,
      change,
      locale
    );
    if (reached) {
      payloads.push({
        pageId: page.id,
        payload: { ...reached, timestamp: iso(at), type: event.type },
      });
    }
  }
  return payloads;
}

/** A subscription's addresses: its page, where the subscriber confirms and unsubscribes, and the one-click unsubscribe. */
export interface SubscriptionLinks {
  readonly page: string;
  readonly unsubscribe: string;
}

/** The addresses of the subscription with this token, at the origin of its page's plain address; paths when that address is a path. */
export function subscriptionLinks(
  pageUrl: string,
  token: string
): SubscriptionLinks {
  const origin = URL.canParse(pageUrl) ? new URL(pageUrl).origin : "";
  const page = `${origin}${subscriptionPath(token)}`;
  return { page, unsubscribe: `${page}/unsubscribe` };
}

/** Each event's opening sentence, by its type; a resolving update has its own. */
const sentences: Readonly<
  Record<SubscriberEventType | "incident.resolved", MessageId>
> = {
  "incident.published": "subscription_text_published",
  "incident.resolved": "subscription_text_resolved",
  "incident.updated": "subscription_text_updated",
  "maintenance.cancelled": "subscription_text_cancelled",
  "maintenance.completed": "subscription_text_completed",
  "maintenance.rescheduled": "subscription_text_rescheduled",
  "maintenance.scheduled": "subscription_text_scheduled",
  "maintenance.started": "subscription_text_started",
};

/** The words of each stage, an incident's and a window's. */
const stageWords: Readonly<
  Record<IncidentStage | MaintenanceStage, MessageId>
> = {
  completed: "maintenance_stage_completed",
  identified: "incident_stage_identified",
  in_progress: "maintenance_stage_in_progress",
  investigating: "incident_stage_investigating",
  monitoring: "incident_stage_monitoring",
  resolved: "incident_stage_resolved",
  scheduled: "maintenance_stage_scheduled",
};

const impactWords: Readonly<Record<ImpactLevel, MessageId>> = {
  critical: "incident_impact_critical",
  major: "incident_impact_major",
  minor: "incident_impact_minor",
  none: "incident_impact_none",
};

/** One subscriber email in the subscription language: its subject, its plain-text body and its HTML part. A short sentence, then label-value lines with one link each, never a link mid-sentence; the update's text keeps a block of its own; an event's email ends with why it came and the unsubscribe line. The HTML part shows the same lines, the incident's title as its heading, and each link as a button or the footer's words. */
export async function subscriberMail(
  payload: SubscriberPayload,
  locale: Locale,
  time: TimeOptions,
  links: SubscriptionLinks
): Promise<{
  readonly html: string;
  readonly subject: string;
  readonly text: string;
}> {
  const messages = createMessages(locale, await loadCatalog(locale));
  const line = (label: MessageId, value: string) =>
    messages._(label, { value });
  const when = (value: string) =>
    formatDateTimeWithZone(locale, Date.parse(value), time);
  const body = (blocks: readonly (readonly string[])[]) =>
    `${blocks
      .filter((block) => block.length > 0)
      .map((block) => block.join("\n"))
      .join("\n\n")}\n`;
  const page = payload.page.name;
  if (payload.type === "subscription.confirmation") {
    const subject = messages._("subscription_confirm_subject", { page });
    const sentence = messages._("subscription_confirm_sentence");
    return {
      html: mailHtml({
        buttons: [
          { url: links.page, words: messages._("public_subscription_confirm") },
        ],
        heading: page,
        lines: [],
        locale,
        sentence,
        subject,
      }),
      subject,
      text: body([[sentence], [line("subscription_line_confirm", links.page)]]),
    };
  }
  const { incident } = payload;
  const resolved =
    payload.type === "incident.updated" && incident.status === "resolved";
  const sentence = messages._(
    sentences[resolved ? "incident.resolved" : payload.type],
    { page }
  );
  // A cancelled window is completed for Statuspage's sake; its sentence says what happened, so no stage line contradicts it.
  const stage =
    payload.type === "maintenance.cancelled"
      ? []
      : [
          line(
            "subscription_line_stage",
            messages._(stageWords[incident.status])
          ),
        ];
  const times =
    "scheduled_for" in incident
      ? [
          line("subscription_line_starts", when(incident.scheduled_for)),
          line("subscription_line_ends", when(incident.scheduled_until)),
        ]
      : [];
  const text = incident.incident_updates[0]?.body ?? "";
  const names = incident.components.map((each) => each.name);
  const components = line(
    "subscription_line_components",
    names.join(listSeparator[locale])
  );
  const at = line("subscription_line_time", when(payload.timestamp));
  const footer = messages._("subscription_footer", { page });
  const subject =
    incident.impact === "maintenance"
      ? messages._("subscription_subject_maintenance", {
          title: incident.name,
        })
      : messages._("subscription_subject_incident", {
          impact: messages._(impactWords[incident.impact]),
          title: incident.name,
        });
  return {
    html: mailHtml({
      buttons: [
        { url: incident.shortlink, words: messages._("monitor_check_open") },
      ],
      footer: {
        link: {
          url: links.page,
          words: messages._("public_subscription_unsubscribe"),
        },
        text: footer,
      },
      heading: incident.name,
      lines: [...stage, ...times, components, at].map((each) => ({
        text: each,
      })),
      locale,
      sentence,
      subject,
      update: text === "" ? undefined : text,
    }),
    subject,
    text: body([
      [sentence],
      [...stage, ...times],
      text === "" ? [] : [text],
      [components, line("subscription_line_link", incident.shortlink), at],
      [footer, line("subscription_line_unsubscribe", links.page)],
    ]),
  };
}

/** A list of names in running text: the locale's comma, since Arabic's list format glues its "and" onto a Latin name. */
const listSeparator: Readonly<Record<Locale, string>> = {
  ar: "، ",
  en: ", ",
};

/** The body a subscriber's webhook receives: Raaqeb's confirmation, or Statuspage's body for an event. */
export async function subscriberWebhookBody(
  payload: SubscriberPayload,
  links: SubscriptionLinks,
  locale: Locale,
  documentation: string
): Promise<string> {
  if (payload.type === "subscription.confirmation") {
    const messages = createMessages(locale, await loadCatalog(locale));
    const confirmation: ConfirmationWebhook = {
      confirmUrl: links.page,
      page: payload.page,
      text: messages._("subscription_confirm_webhook"),
      timestamp: payload.timestamp,
      type: payload.type,
    };
    return JSON.stringify(confirmation);
  }
  const event: SubscriberWebhook = {
    incident: payload.incident,
    meta: { documentation, event: payload.type, unsubscribe: links.page },
    page: {
      id: payload.page.id,
      status_description: payload.page.status_description,
      status_indicator: payload.page.status_indicator,
    },
  };
  return JSON.stringify(event);
}

export type SubscriberSendStorage = Pick<
  Storage,
  "channels" | "pages" | "settings" | "subscriptions"
>;

/** What an attempt records when no email channel exists to send a subscriber's mail. */
const noEmailChannel: SendFailure = {
  error: "no email channel",
  params: { reason: "unknown" },
  reason: "unknown",
};

/** What an attempt records when a webhook's host is not on the public internet; it is tried again, since a name may move. */
const notOnInternet: SendFailure = {
  error: "the webhook's host is not on the public internet",
  params: { reason: "unknown" },
  reason: "unknown",
};

/** One attempt of a subscriber notification: `dropped` when its subscription is gone or no longer takes it (a pending one takes only its confirmation, a confirmed one only events). Never throws. */
export async function sendToSubscriber(
  storage: SubscriberSendStorage,
  key: InstallKey,
  io: DeliverIo,
  notification: SubscriberNotification
): Promise<SendOutcome | "dropped"> {
  try {
    const subscription = await storage.subscriptions.find(
      notification.subscriptionId
    );
    const confirming =
      notification.payload.type === "subscription.confirmation";
    if (subscription?.status !== (confirming ? "pending" : "confirmed")) {
      return "dropped";
    }
    // Nothing goes out for a page taken off the public after it was queued, a confirmation included.
    if (!(await storage.pages.find(subscription.pageId))?.published) {
      return "dropped";
    }
    const { payload } = notification;
    const links = subscriptionLinks(payload.page.url, subscription.token);
    if (subscription.channel === "email") {
      return await mailTo(storage, key, io, notification, subscription, links);
    }
    const url =
      subscription.credentials === undefined
        ? undefined
        : await decrypt(key, subscription.credentials);
    if (url === undefined) {
      return { failure: unreadableSecrets, ok: false };
    }
    // ponytail: the POST resolves the name again, so an answer that changes between the two (DNS rebinding) is not caught; pin the checked address if an install is probed so.
    if (!(await webhookReachable(url, io.lookup ?? lookupHost))) {
      return { failure: notOnInternet, ok: false };
    }
    const origin = URL.canParse(payload.page.url)
      ? new URL(payload.page.url).origin
      : "";
    const body = await subscriberWebhookBody(
      payload,
      links,
      subscription.locale,
      `${origin}/api/openapi.json`
    );
    const secrets = urlSecrets(url).toSorted((a, b) => b.length - a.length);
    return await attempt(io, secrets, (transport) =>
      transport.post(url, {
        body,
        headers: {
          ...jsonHeaders,
          "webhook-id": notification.id,
          "webhook-timestamp": String(Math.floor(transport.now() / 1000)),
        },
      })
    );
  } catch (error) {
    return {
      failure: {
        error: reasonOf(error),
        params: { reason: "unknown" },
        reason: "unknown",
      },
      ok: false,
    };
  }
}

/** A subscriber's email through the channel that sends sign-in mail, to the subscriber alone, with the one-click unsubscribe (RFC 8058). */
async function mailTo(
  storage: SubscriberSendStorage,
  key: InstallKey,
  io: DeliverIo,
  notification: SubscriberNotification,
  subscription: StoredSubscription,
  links: SubscriptionLinks
): Promise<SendOutcome> {
  const channel = await authEmailChannelOf(storage);
  if (!channel) {
    return { failure: noEmailChannel, ok: false };
  }
  // A partial record, as auth mail reads it: a field that does not apply has no value.
  const values: ChannelValues | undefined = await channelValues(
    key,
    channel,
    await storage.channels.credentialsOf(channel.id)
  );
  if (!values) {
    return { failure: unreadableSecrets, ok: false };
  }
  const time = await readClock(storage);
  const mail = await subscriberMail(
    notification.payload,
    subscription.locale,
    time,
    links
  );
  return await attempt(io, secretsOf(emailChannel, values), (transport) => {
    const from = senderOf(values.from ?? "");
    if (!from) {
      throw new Error("the channel's sender is not an address");
    }
    return sendMail(
      values,
      {
        from,
        headers: {
          "List-Unsubscribe": `<${links.unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        html: mail.html,
        id: notification.id,
        subject: mail.subject,
        text: mail.text,
        to: [subscription.address],
      },
      transport
    );
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The id of the incident or window an event is about, for a log line. */
function subjectOf(event: SubscriberEvent): string {
  if ("incidentId" in event) {
    return event.incidentId;
  }
  return "window" in event ? event.window.id : event.windowId;
}

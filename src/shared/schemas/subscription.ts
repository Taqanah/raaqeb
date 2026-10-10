/**
 * A subscription and what it receives (CONTEXT.md "Subscriber",
 * "Subscription", "Subscriber notification", "Subscription language"). A subscription ties one subscriber to one
 * status page through email or a webhook. It is pending until the subscriber
 * presses the button on the page its one-time confirmation link opens, within
 * 48 hours of the link being sent, then confirmed until the subscriber unsubscribes. Its language is the
 * locale of the address the visitor subscribed from.
 *
 * What a subscriber notification carries is stored as the event was when
 * it was queued, the same for every subscriber of the event. A webhook
 * receives the event in the body Statuspage sends its webhook subscribers
 * (`meta`, `page`, `incident`; a maintenance window is an incident with
 * impact `maintenance`), and its confirmation in Raaqeb's own body. Both
 * are public contracts: a field is added, never changed.
 */
import { z } from "zod";
import { type Locale, localeSchema } from "@/shared/i18n/locale.ts";
import type { Content } from "./content.ts";
import { incidentStageSchema } from "./incident.ts";
import { maintenanceStageSchema } from "./maintenance.ts";
import type { NotificationStatus, SendFailure } from "./notification.ts";
import type { SubscriptionChannel } from "./page.ts";
import {
  indicatorSchema,
  summaryIncidentSchema,
  summaryMaintenanceSchema,
  summaryUpdateSchema,
} from "./summary.ts";

/** Pending until the button on the confirmation link's page is pressed, confirmed after, unsubscribed once the subscriber leaves. */
export const subscriptionStatuses = [
  "pending",
  "confirmed",
  "unsubscribed",
] as const;
export const subscriptionStatusSchema = z.enum(subscriptionStatuses);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** How long a confirmation link works after it was sent. */
export const confirmationLifetimeMs = 48 * 60 * 60 * 1000;

/** A pending subscription gets another confirmation no sooner than this after the last. */
export const confirmationCooldownMs = 10 * 60 * 1000;

/** The longest email address (RFC 5321's path limit) and webhook URL a visitor may type. */
export const subscriberEmailMaxLength = 254;
export const subscriberUrlMaxLength = 2048;

/** The path of a subscription's own page, on any host. */
export function subscriptionPath(token: string): string {
  return `/subscriptions/${encodeURIComponent(token)}`;
}

/** The random part of a subscription's links: 16 bytes in base64url. */
export const subscriptionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** A subscription page's path: its token, or nothing for any other path. */
export function subscriptionTokenOf(pathname: string): string | undefined {
  const [, first, token, ...rest] = pathname.split("/");
  const parsed = subscriptionTokenSchema.safeParse(token);
  return first === "subscriptions" && rest.length === 0 && parsed.success
    ? parsed.data
    : undefined;
}

/** An email address as a subscription stores it: trimmed and in lower case. */
export const subscriberEmailSchema = z
  .string()
  .trim()
  .max(subscriberEmailMaxLength)
  .pipe(z.email())
  .transform((address) => address.toLowerCase());

/** A webhook address a visitor may subscribe: https, with no user name or password. */
export const subscriberUrlSchema = z
  .string()
  .trim()
  .max(subscriberUrlMaxLength)
  // Zod 4 runs every refine even after one failed, so the URL is checked in the one.
  .refine((text) => {
    if (!URL.canParse(text)) {
      return false;
    }
    const url = new URL(text);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  }, "not an https URL without credentials")
  .transform((text) => new URL(text).href);

const subscribeFields = { locale: localeSchema, pageId: z.string().min(1) };

/** What the subscribe form posts: the page, the locale of the address it was on, the channel and the address. */
export const subscribeInputSchema = z.discriminatedUnion("channel", [
  z.object({
    ...subscribeFields,
    address: subscriberEmailSchema,
    channel: z.literal("email"),
  }),
  z.object({
    ...subscribeFields,
    address: subscriberUrlSchema,
    channel: z.literal("webhook"),
  }),
]);
export type SubscribeInput = z.infer<typeof subscribeInputSchema>;

/**
 * Why a sign-up went nowhere. The answer to one that went is the same
 * whether the address was new, pending or already confirmed, so the form
 * never tells who is subscribed.
 */
export type SubscribeRefusal =
  /** The address is not one the channel takes. */
  | "invalid"
  /** Too many sign-ups from this client in a short time. */
  | "limited"
  /** The page does not offer this channel now. */
  | "not_offered"
  | "not_found"
  | "unavailable"
  /** A webhook address that is not on the public internet, or whose name does not resolve. */
  | "unreachable";

export type SubscribeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SubscribeRefusal };

/** A subscription as its own page shows it: what it is and where it stands. */
export interface SubscriptionView {
  /** The email address, or the webhook's host alone. */
  readonly address: string;
  readonly channel: SubscriptionChannel;
  /** Its state; a pending one whose link is past its lifetime is expired. */
  readonly state: SubscriptionStatus | "expired";
}

export type SubscriptionViewResult =
  | { readonly ok: true; readonly subscription: SubscriptionView }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

/** What the confirm and unsubscribe buttons answer: the state after, or why nothing moved. */
export type SubscriptionActionResult =
  | { readonly ok: true; readonly state: SubscriptionView["state"] }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

/** One subscriber as the admin lists it, with how the last message to it went. */
export interface Subscriber {
  /** The email address, or the webhook's host alone (its URL is sealed). */
  readonly address: string;
  readonly channel: SubscriptionChannel;
  readonly confirmedAt: number | undefined;
  readonly createdAt: number;
  readonly id: string;
  readonly lastSend:
    | {
        readonly at: number;
        readonly failure: SendFailure | undefined;
        readonly status: NotificationStatus;
      }
    | undefined;
  readonly locale: Locale;
  /** When the last confirmation was sent. */
  readonly requestedAt: number;
  readonly state: SubscriptionView["state"];
}

export interface SubscriberList {
  readonly now: number;
  readonly page: { readonly id: string; readonly title: Content };
  readonly subscribers: readonly Subscriber[];
}

export type SubscriberListResult =
  | { readonly ok: true; readonly list: SubscriberList }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

export type SubscriberRemoveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

export const subscriberListSchema = z.object({ pageId: z.string().min(1) });
export const subscriberRemoveSchema = z.object({
  id: z.string().min(1),
  pageId: z.string().min(1),
});

const instant = z.iso.datetime({ offset: true });

/** An incident as a subscriber's webhook receives it: the summary's, which may also be resolved. */
export const subscriberIncidentSchema = summaryIncidentSchema.extend({
  resolved_at: instant
    .nullable()
    .describe("When it was resolved, in UTC; null while it is open."),
  status: incidentStageSchema.describe("The incident's stage."),
});

export type SubscriberIncident = z.infer<typeof subscriberIncidentSchema>;

/** A maintenance window as a subscriber's webhook receives it: the summary's, which may also be completed, with its description as one update at its stage, as Statuspage sends a maintenance; the update at its start and its end lists the components it moved. */
export const subscriberMaintenanceSchema = summaryMaintenanceSchema.extend({
  incident_updates: z
    .array(
      summaryUpdateSchema.extend({
        status: maintenanceStageSchema.describe("The window's stage."),
      })
    )
    .max(1)
    .describe("The window's description as one update at its stage."),
  resolved_at: instant
    .nullable()
    .describe("When the window ended or was cancelled, in UTC; null before."),
  status: maintenanceStageSchema.describe("The window's stage."),
});
export type SubscriberMaintenance = z.infer<typeof subscriberMaintenanceSchema>;

/** The page an event came from, as Statuspage names it, with its title and plain address for the email. */
const eventPageSchema = z.object({
  id: z.string().describe("The status page's id."),
  name: z.string().describe("The page's title."),
  status_description: z
    .string()
    .describe(
      "Statuspage's sentence for the indicator, such as All Systems Operational."
    ),
  status_indicator: indicatorSchema.describe(
    "How bad the page is, worst last: none, maintenance, minor, major or critical."
  ),
  url: z
    .string()
    .describe(
      "The page's plain address in the subscription language, on its custom domain or the public address."
    ),
});

/** The seven subscriber events, all always on. */
export const subscriberEventTypes = [
  "incident.published",
  "incident.updated",
  "maintenance.scheduled",
  "maintenance.rescheduled",
  "maintenance.started",
  "maintenance.completed",
  "maintenance.cancelled",
] as const;
export type SubscriberEventType = (typeof subscriberEventTypes)[number];

/** What a subscriber notification carries, stored as it was queued; the confirmation's links are the subscription's, made at send time. */
export const subscriberPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    page: eventPageSchema.pick({ id: true, name: true, url: true }),
    /** When the visitor asked. */
    timestamp: instant,
    type: z.literal("subscription.confirmation"),
  }),
  z.object({
    incident: subscriberIncidentSchema,
    page: eventPageSchema,
    /** When the event happened: the update's time. */
    timestamp: instant,
    type: z.enum(["incident.published", "incident.updated"]),
  }),
  z.object({
    incident: subscriberMaintenanceSchema,
    page: eventPageSchema,
    /** When the event happened: the window's scheduling, new times, start, end or cancellation. */
    timestamp: instant,
    type: z.enum([
      "maintenance.scheduled",
      "maintenance.rescheduled",
      "maintenance.started",
      "maintenance.completed",
      "maintenance.cancelled",
    ]),
  }),
]);
export type SubscriberPayload = z.infer<typeof subscriberPayloadSchema>;
export type SubscriberEventPayload = Exclude<
  SubscriberPayload,
  { type: "subscription.confirmation" }
>;

/** One subscriber notification as the queue holds it; its lane is the subscription, so its messages arrive in order. */
export interface SubscriberNotification {
  readonly attempts: number;
  readonly failure: SendFailure | undefined;
  readonly finishedAt: number | undefined;
  readonly id: string;
  readonly kind: "subscriber";
  readonly nextAttemptAt: number | undefined;
  readonly payload: SubscriberPayload;
  readonly queuedAt: number;
  readonly status: NotificationStatus;
  readonly subscriptionId: string;
}

/** The body a subscriber's webhook receives for an event: Statuspage's, with the event's name beside the unsubscribe link. */
export const subscriberWebhookSchema = z.object({
  incident: z
    .union([subscriberIncidentSchema, subscriberMaintenanceSchema])
    .describe(
      "The incident, or the maintenance window as an incident with impact maintenance."
    ),
  meta: z
    .object({
      documentation: z
        .string()
        .describe("The OpenAPI document that describes this body."),
      event: z.enum(subscriberEventTypes).describe("The event's name."),
      unsubscribe: z
        .string()
        .describe(
          "Opens the subscription's page, where the subscriber unsubscribes."
        ),
    })
    .describe("What Raaqeb adds to Statuspage's body."),
  page: eventPageSchema
    .pick({
      id: true,
      status_description: true,
      status_indicator: true,
    })
    .describe("The status page the event came from."),
});
export type SubscriberWebhook = z.infer<typeof subscriberWebhookSchema>;

/** The first POST a subscriber's webhook receives, and the only one until the button on the link's page is pressed. */
export const confirmationWebhookSchema = z.object({
  confirmUrl: z
    .string()
    .describe("The subscription's page, where the subscriber confirms."),
  page: eventPageSchema
    .pick({ id: true, name: true, url: true })
    .describe("The status page subscribed to."),
  text: z
    .string()
    .describe("One sentence in the subscription language saying what to do."),
  timestamp: instant.describe("When the visitor subscribed, in UTC."),
  type: z.literal("subscription.confirmation").describe("The body's type."),
});
export type ConfirmationWebhook = z.infer<typeof confirmationWebhookSchema>;

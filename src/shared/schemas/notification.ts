/**
 * A notification (CONTEXT.md "Operator notification"): what
 * the queue holds for one channel, and what its recent sends show. The
 * payload is machine values only, never localized: it is the
 * generic webhook's body as Raaqeb posts it, in the Standard Webhooks
 * envelope `{ type, timestamp, data }`, and every
 * other channel renders its text from it in the channel language. The
 * schema is a public contract: a type or a field is added, never changed.
 */
import { z } from "zod";
import { checkTypes } from "./monitor.ts";
import {
  type ReasonName,
  type ReasonParams,
  reasonNameSchema,
} from "./reason.ts";

/** An instant as the payload carries it: ISO 8601 in UTC, to the millisecond. */
const instant = z.iso.datetime();

/** The monitor an event is about, as it was when the notification was queued. */
export const notificationMonitorSchema = z.object({
  adminUrl: z
    .url()
    .optional()
    .describe(
      "The monitor's page in the admin area, at the public address; absent when the install stores none."
    ),
  checkType: z.enum(checkTypes).describe("The monitor's check type."),
  id: z.string().describe("The monitor's id."),
  name: z.string().describe("The monitor's name."),
  target: z
    .string()
    .nullable()
    .describe(
      "The URL, `host:port` or name the check reaches; null for a heartbeat monitor."
    ),
});

const event = <Type extends string, Data extends z.ZodRawShape>(
  type: Type,
  data: Data
) =>
  z.object({
    data: z
      .object({
        monitor: notificationMonitorSchema.describe(
          "The monitor the event is about, as it was when the notification was queued."
        ),
        ...data,
      })
      .describe("What the event is about."),
    timestamp: instant.describe(
      "When the event happened: the start of the check that raised it, in UTC."
    ),
    type: z.literal(type).describe("The notification's type."),
  });

/** Every notification a channel can receive, by its type. */
export const notificationPayloadSchema = z.discriminatedUnion("type", [
  event("monitor.down", {
    incidentUrl: z
      .url()
      .optional()
      .describe(
        "The admin area's new-incident page for this monitor; absent when the install stores no public address."
      ),
    reason: reasonNameSchema.describe("Why the check failed."),
  }),
  event("monitor.recovered", {
    downtimeMs: z
      .int()
      .min(0)
      .describe("How long the outage lasted, in milliseconds."),
  }),
  event("monitor.degraded_started", {
    reason: reasonNameSchema.describe("Why the check is degraded."),
  }),
  event("monitor.degraded_ended", {}),
  event("monitor.reminder", {
    downForMs: z
      .int()
      .min(0)
      .describe("How long the monitor has been down, in milliseconds."),
    reason: reasonNameSchema.describe("The reason the outage opened with."),
  }),
  event("monitor.certificate_expiring", {
    certificate: z
      .object({
        daysLeft: z.int().describe("Whole days left, rounded down."),
        notAfter: instant.describe("When the certificate expires, in UTC."),
      })
      .describe("The monitor's certificate."),
  }),
  z.object({
    data: z
      .object({
        channel: z
          .object({
            id: z.string().describe("The channel's id."),
            name: z.string().describe("The channel's name."),
          })
          .describe("The channel being tested."),
      })
      .describe("What the test is about."),
    timestamp: instant.describe(
      "When the operator asked for the test, in UTC."
    ),
    type: z.literal("channel.test").describe("The notification's type."),
  }),
]);
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
export type NotificationType = NotificationPayload["type"];

/** Who a notification is for: a monitor event for the operator, a channel's "send test", or a subscriber. */
export const notificationKinds = ["operator", "test", "subscriber"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/** The kinds a channel sends; a subscriber's notification goes to its subscription (shared/schemas/subscription.ts). */
export type ChannelNotificationKind = Exclude<NotificationKind, "subscriber">;

/** Waiting for its next attempt, delivered, or given up after the last retry. */
export const notificationStatuses = ["pending", "sent", "failed"] as const;
export type NotificationStatus = (typeof notificationStatuses)[number];

/** Why an attempt failed: a code from the reason dictionary with what it saw, and the driver's text with every secret taken out. */
export interface SendFailure {
  readonly error: string | undefined;
  readonly params: ReasonParams;
  readonly reason: ReasonName;
}

/** One notification for a channel as the queue holds it and the recent sends show it. */
export interface Notification {
  readonly attempts: number;
  readonly channelId: string;
  /** The failure of the last attempt; a pending notification shows why it waits. */
  readonly failure: SendFailure | undefined;
  readonly finishedAt: number | undefined;
  readonly id: string;
  readonly kind: ChannelNotificationKind;
  /** When a pending notification is tried next; nothing once it is finished. */
  readonly nextAttemptAt: number | undefined;
  readonly payload: NotificationPayload;
  readonly queuedAt: number;
  readonly status: NotificationStatus;
}

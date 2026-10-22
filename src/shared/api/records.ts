/**
 * What the management API answers (CONTEXT.md "Management API"): each
 * record as one Zod schema, so the OpenAPI document describes the bodies
 * from the same source as the admin forms' inputs. The records are the
 * admin's own reads, as `src/routes/-api.ts` projects them: never a secret
 * (a channel's or a monitor's credentials are write-only, their names
 * alone answered), and never what only a page of the admin draws (a day
 * bar, a preview).
 */

import { z } from "zod";
import { probeStates } from "@/shared/domain/probes.ts";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { channelTypeSchema } from "@/shared/schemas/channel.ts";
import { captureHeadersSchema, checkResults } from "@/shared/schemas/check.ts";
import { contentShapeSchema } from "@/shared/schemas/content.ts";
import {
  impactLevelSchema,
  incidentStageSchema,
} from "@/shared/schemas/incident.ts";
import {
  maintenanceStageSchema,
  recurrenceSchema,
} from "@/shared/schemas/maintenance.ts";
import {
  assertionSchema,
  monitorFieldsSchema,
} from "@/shared/schemas/monitor.ts";
import {
  notificationKinds,
  notificationPayloadSchema,
  notificationStatuses,
} from "@/shared/schemas/notification.ts";
import {
  pageCustomizationSchema,
  pageImageKindSchema,
  pageLayoutSchema,
} from "@/shared/schemas/page.ts";
import {
  reasonNameSchema,
  reasonParamsSchema,
} from "@/shared/schemas/reason.ts";
import {
  handSetLevelSchema,
  statusLevelSchema,
} from "@/shared/schemas/status.ts";

const id = z.string().describe("The record's id, which never changes.");
const time = (what: string) =>
  z.int().nonnegative().describe(`${what}, in Unix milliseconds.`);
const createdAt = time("When it was created");
const updatedAt = time("When it last changed");
const ids = (what: string) => z.array(z.string()).describe(what);
const named = z.object({ id: z.string(), name: contentShapeSchema });

/** A monitor's stored fields and its state; never its credentials. */
export const monitorRecordSchema = monitorFieldsSchema.extend({
  createdAt,
  id,
  paused: z.boolean().describe("No checks run while it is paused."),
  pausedAt: time("When it was paused").optional(),
  target: z
    .string()
    .optional()
    .describe(
      "The URL, `host:port`, name or container the check reaches; a heartbeat monitor has none."
    ),
  updatedAt,
});

/** A monitor on the list, with its latest check's result. */
export const monitorItemSchema = monitorRecordSchema.extend({
  state: z
    .enum(checkResults)
    .nullable()
    .describe(
      "The latest check's result while the monitor runs; null before its first check."
    ),
});

/** What a monitor's read tells of its stored credentials: their kind, the user and header names, never a secret. */
export const credentialsViewSchema = z
  .object({
    auth: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("basic"), user: z.string() }),
        z.object({ kind: z.literal("bearer") }),
      ])
      .optional(),
    headers: z.array(z.object({ name: z.string() })),
    proxyUser: z.string().optional(),
    url: z.boolean().describe("Whether a connection URL is stored."),
  })
  .describe(
    "The names of the stored credentials, never their values. A save that leaves a credential out keeps the stored one."
  );

/** One monitor as its read answers it. */
export const monitorDetailSchema = monitorRecordSchema.extend({
  credentials: credentialsViewSchema,
  heartbeat: z
    .object({
      last: z
        .object({
          arrivedAt: time("When it arrived"),
          sourceIp: z.string().optional(),
        })
        .optional(),
      url: z
        .string()
        .optional()
        .describe(
          "The address the job calls; it holds the monitor's token, so keep it as a password. Only a key whose role edits monitors reads it."
        ),
    })
    .optional()
    .describe(
      "A heartbeat monitor's address and its last heartbeat; none for another check type."
    ),
});

/** One check a test ran and nothing recorded. */
export const monitorTestRecordSchema = z.object({
  address: z
    .string()
    .optional()
    .describe("The address a TCP check connected to."),
  answer: z
    .string()
    .optional()
    .describe("The first value a database check's query answered."),
  bytes: z.int().nonnegative(),
  failure: z
    .object({
      assertion: assertionSchema.optional(),
      error: z.string().optional(),
      params: reasonParamsSchema,
    })
    .optional()
    .describe("Set on a down check: why, with what it saw."),
  reason: reasonNameSchema,
  records: z
    .array(z.string())
    .optional()
    .describe("The records a DNS check's resolver answered, one a line."),
  response: z
    .object({ body: z.string(), headers: captureHeadersSchema })
    .optional()
    .describe(
      "An HTTP response as a capture keeps it: credential headers by name only, the first 4 KB of the body."
    ),
  responseMs: z.int().nonnegative().optional(),
  result: z.enum(checkResults),
  statusCode: z.int().optional(),
});

/** What "check now" answers. */
export const checkAskedSchema = z.object({
  answer: z
    .enum(["queued", "running"])
    .describe(
      "`running` when a check of the monitor was already in flight, which counts as the asked one."
    ),
  from: time("The asked check starts at this time or later"),
});

/** A group: its name and its monitors. */
export const groupRecordSchema = z.object({
  monitorIds: ids("Its monitors, in their creation order."),
  name: z.string(),
});

/** A probe: what a script needs to place a monitor on it, and how it is doing. Never its token. */
export const probeRecordSchema = z.object({
  createdAt,
  id: id.describe(
    "The probe's id, which never changes: the value to put in a monitor's `locations`."
  ),
  lastSeenAt: time("When the install last heard from it").optional(),
  name: z.string(),
  roundTripMs: z
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Its last request's round trip as it measured it, in milliseconds."
    ),
  state: z
    .enum(probeStates)
    .describe(
      "`never`: not heard from yet; `reporting`: heard within the last two minutes; `silent`: not for longer; `refused`: the install refused its latest push whole."
    ),
  version: z
    .string()
    .optional()
    .describe("The build it named at its last contact."),
});

/** A status page's own fields. */
export const statusPageRecordSchema = z.object({
  createdAt,
  customDomain: z.string().optional(),
  customization: pageCustomizationSchema,
  id,
  isDefault: z
    .boolean()
    .describe("Served at the bare host; at most one page is."),
  locale: localeSchema.describe("The page language."),
  published: z.boolean(),
  slug: z.string(),
  title: contentShapeSchema,
  updatedAt,
});

/** A status page on the list. */
export const statusPageItemSchema = statusPageRecordSchema.extend({
  components: z.int().nonnegative().describe("How many components it shows."),
  level: statusLevelSchema.describe(
    "Its status level now: the worst of the components it shows."
  ),
});

/** One status page as its read answers it: with the components it shows and its images. */
export const statusPageDetailSchema = statusPageRecordSchema.extend({
  images: z.array(
    z.object({
      contentType: z.string(),
      hash: z.string().describe("The SHA-256 of its bytes, in hex."),
      kind: pageImageKindSchema,
    })
  ),
  layout: pageLayoutSchema.describe(
    "The components it shows, in order: a component, or a group of them one level deep."
  ),
});

/** A component as a save answers it. */
export const componentRecordSchema = z.object({
  createdAt,
  description: contentShapeSchema.optional(),
  id,
  monitorIds: ids("Its linked monitors, in their creation order."),
  name: contentShapeSchema,
  status: handSetLevelSchema.describe(
    "The hand-set status, shown only while no monitor is linked."
  ),
  updatedAt,
});

/** A component as the list and its read answer it, with its status now. */
export const componentItemSchema = componentRecordSchema.extend({
  currentStatus: statusLevelSchema.describe(
    "Its status now: derived from its linked monitors, an incident's, a maintenance window's, or the hand-set one."
  ),
});

/** One update of an incident. */
export const incidentUpdateRecordSchema = z.object({
  author: z.string().describe("The email of the operator who wrote it."),
  createdAt,
  id,
  message: contentShapeSchema,
  stage: incidentStageSchema,
  statuses: z.array(
    z.object({
      before: statusLevelSchema
        .optional()
        .describe(
          "The status the component showed just before this update first named it."
        ),
      componentId: z.string(),
      status: handSetLevelSchema,
    })
  ),
});

/** An incident with every update, oldest first. */
export const incidentRecordSchema = z.object({
  createdAt,
  id,
  impact: impactLevelSchema,
  resolvedAt: time("Its resolving update's time").optional(),
  title: contentShapeSchema,
  updatedAt,
  updates: z.array(incidentUpdateRecordSchema),
});

/** An incident on the list. */
export const incidentItemSchema = z.object({
  components: z
    .array(named)
    .describe("The affected components, in the order they were first named."),
  createdAt,
  id,
  impact: impactLevelSchema,
  resolvedAt: time("Its resolving update's time").optional(),
  stage: incidentStageSchema,
  title: contentShapeSchema,
});

/** A maintenance window. */
export const maintenanceWindowRecordSchema = z.object({
  componentIds: ids("The affected components, in their creation order."),
  createdAt,
  endsAt: time("When it ends"),
  id,
  message: contentShapeSchema,
  seriesId: z
    .string()
    .optional()
    .describe("The maintenance series it is an occurrence of."),
  stage: maintenanceStageSchema,
  startsAt: time("When it starts"),
  title: contentShapeSchema,
  updatedAt,
});

/** A maintenance window on the list. */
export const maintenanceWindowItemSchema = z.object({
  components: z.array(named),
  endsAt: time("When it ends"),
  id,
  seriesId: z.string().optional(),
  stage: maintenanceStageSchema,
  startsAt: time("When it starts"),
  title: contentShapeSchema,
});

/** A maintenance series. */
export const maintenanceSeriesRecordSchema = z.object({
  componentIds: ids("The affected components, in their creation order."),
  createdAt,
  id,
  message: contentShapeSchema,
  recurrence: recurrenceSchema,
  scheduledUntil: time(
    "Every occurrence starting before this time is scheduled as a window"
  ),
  title: contentShapeSchema,
  updatedAt,
});

/** A maintenance series on the list. */
export const maintenanceSeriesItemSchema = z.object({
  components: z.array(named),
  id,
  next: time("When its next occurrence starts"),
  recurrence: recurrenceSchema,
  title: contentShapeSchema,
});

/** One maintenance series as its read answers it, with its coming occurrences. */
export const maintenanceSeriesDetailSchema =
  maintenanceSeriesRecordSchema.extend({
    next: time("When the first occurrence it has yet to schedule starts"),
    occurrences: z
      .array(maintenanceWindowItemSchema)
      .describe("Its occurrences in progress and scheduled, soonest first."),
  });

/** A notification channel: what it is and what it reaches, never a secret. */
export const channelRecordSchema = z.object({
  appliesToNew: z
    .boolean()
    .describe("A new monitor starts with this channel selected."),
  config: z
    .record(z.string(), z.string())
    .describe("The values of its fields that are not secret, by name."),
  createdAt,
  id,
  locale: localeSchema
    .optional()
    .describe("The channel language; absent follows the install language."),
  name: z.string(),
  type: channelTypeSchema,
  updatedAt,
});

/** A channel as the list answers it, with what it reaches. */
export const channelItemSchema = channelRecordSchema.extend({
  summary: z.string().describe("What it reaches, in a few words."),
});

/** One channel as its read answers it. */
export const channelDetailSchema = channelItemSchema.extend({
  kept: z
    .array(z.string())
    .describe(
      "The secret fields that have a stored value, which a save that leaves them out keeps."
    ),
});

/** One send of a notification, as a channel's recent sends show it. */
export const notificationRecordSchema = z.object({
  attempts: z.int().nonnegative(),
  channelId: z.string(),
  failure: z
    .object({
      error: z.string().optional(),
      params: reasonParamsSchema,
      reason: reasonNameSchema,
    })
    .optional()
    .describe("Why the last attempt failed."),
  finishedAt: time("When it was sent or given up").optional(),
  id,
  kind: z.enum(notificationKinds),
  nextAttemptAt: time("When it is tried next").optional(),
  payload: notificationPayloadSchema,
  queuedAt: time("When it was queued"),
  status: z.enum(notificationStatuses),
});

/** Every refusal: a reason code, and for an input the API refused, which part and why. */
export const apiErrorSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "With `corrupt`: the stored record this version of Raaqeb cannot read."
    ),
  issues: z
    .array(
      z.object({
        message: z.string(),
        path: z
          .array(z.union([z.string(), z.int()]))
          .describe("Where in the body or the query, as keys and indexes."),
      })
    )
    .optional()
    .describe("With `invalid`: each part of the input that was refused."),
  reason: z
    .string()
    .describe(
      "A machine word that never changes for the same refusal, such as `not_found` or `slug_taken`."
    ),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** The largest page a list answers. */
export const pageLimitMax = 100;
export const pageLimitDefault = 50;

/** A list's query: how many records, from which place in the list. */
export const pageQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(pageLimitMax)
    .default(pageLimitDefault),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** One page of a list. */
export function pageOf(item: z.ZodType) {
  return z.object({
    items: z.array(item),
    limit: z.int().describe("The page's size, as asked."),
    offset: z.int().describe("The place of its first record in the list."),
    total: z.int().describe("How many records the whole list holds."),
  });
}

/**
 * The Statuspage-compatible summary: one
 * status page in the shape of Statuspage's `/api/v2/summary.json`, so an
 * aggregator that reads Statuspage pages reads a Raaqeb page unchanged. It
 * carries machine values and the page's own text, never interface words;
 * times are ISO 8601 in UTC with milliseconds. Fields Raaqeb has no data for
 * carry Statuspage's neutral value. Served at the page's
 * plain address plus `/api/v2/summary.json`, one document for both locales;
 * the OpenAPI document embeds this schema.
 */
import { z } from "zod";
import {
  impactLevelSchema,
  incidentStageSchema,
  openStageSchema,
} from "./incident.ts";
import { maintenanceStageSchema } from "./maintenance.ts";
import { statusLevelSchema } from "./status.ts";

const timestampSchema = z.iso.datetime({ offset: true });

/** Words for the fields that carry Statuspage's neutral value because Raaqeb has no data for them. */
const alwaysNull = "Always null: Raaqeb has no data for it.";

/** How bad the page is for an aggregator, worst last: the page level mapped, or an open incident's impact when worse. */
export const indicators = [
  "none",
  "maintenance",
  "minor",
  "major",
  "critical",
] as const;
export const indicatorSchema = z.enum(indicators);
export type Indicator = z.infer<typeof indicatorSchema>;

/** A component, or a group of them, as Statuspage lists it. */
export const summaryComponentSchema = z.object({
  components: z
    .array(z.string())
    .optional()
    .describe("A group's members, by id; only on a group."),
  created_at: timestampSchema.describe(
    "When the component, or the page for a group, was created, in UTC."
  ),
  description: z
    .string()
    .nullable()
    .describe(
      "The component's description; null when it has none, and on a group."
    ),
  group: z.boolean().describe("Whether this is a component group."),
  group_id: z
    .string()
    .nullable()
    .describe("The group a component sits in on this page; null outside one."),
  id: z.string().describe("The component's or the group's id."),
  name: z.string().describe("The component's or the group's name."),
  only_show_if_degraded: z
    .literal(false)
    .describe("Always false: the page shows every component it lists."),
  page_id: z.string().describe("The status page's id."),
  position: z
    .int()
    .positive()
    .describe(
      "Its place in the page's order, from 1; a group's members count from 1 inside it."
    ),
  showcase: z
    .boolean()
    .describe(
      "True on a component, false on a group, as Statuspage marks them."
    ),
  start_date: z.null().describe(alwaysNull),
  status: statusLevelSchema.describe(
    "The component's or the group's status level."
  ),
  updated_at: timestampSchema.describe("When it last changed, in UTC."),
});
export type SummaryComponent = z.infer<typeof summaryComponentSchema>;

/** What one incident update set on one component: the status it held before and the one it set. */
export const summaryAffectedSchema = z.object({
  code: z.string().describe("The component's id."),
  name: z.string().describe("The component's name."),
  new_status: statusLevelSchema.describe(
    "The status level the update set on it."
  ),
  old_status: statusLevelSchema.describe("The status level it held before."),
});

export const summaryUpdateSchema = z.object({
  affected_components: z
    .array(summaryAffectedSchema)
    .describe(
      "The components the update set a status on, each with the one it held before."
    ),
  body: z.string().describe("What the update says."),
  created_at: timestampSchema.describe("When it was posted, in UTC."),
  custom_tweet: z.null().describe(alwaysNull),
  deliver_notifications: z
    .boolean()
    .describe("Always true: subscribers are told of every update."),
  display_at: timestampSchema.describe("When it was posted, in UTC."),
  id: z.string().describe("The update's id."),
  incident_id: z.string().describe("The id of the incident it belongs to."),
  status: incidentStageSchema.describe("The stage it moved the incident to."),
  tweet_id: z.null().describe(alwaysNull),
  updated_at: timestampSchema.describe("When it was posted, in UTC."),
});

/** An open incident touching the page, with its updates newest first and the page's components it affects. */
export const summaryIncidentSchema = z.object({
  components: z
    .array(summaryComponentSchema)
    .describe("The page's components it affects."),
  created_at: timestampSchema.describe("When it was opened, in UTC."),
  id: z.string().describe("The incident's id."),
  impact: impactLevelSchema.describe("The incident's impact level."),
  incident_updates: z
    .array(summaryUpdateSchema)
    .describe("Its updates, newest first."),
  monitoring_at: timestampSchema
    .nullable()
    .describe(
      "When an update moved it to monitoring, in UTC; null if none did."
    ),
  name: z.string().describe("The incident's title."),
  page_id: z.string().describe("The status page's id."),
  reminder_intervals: z.null().describe(alwaysNull),
  resolved_at: z.null().describe("Null: the incident is open."),
  shortlink: z.string().describe("The incident's view on this page."),
  started_at: timestampSchema.describe("When it was opened, in UTC."),
  status: openStageSchema.describe("The incident's stage."),
  updated_at: timestampSchema.describe("When it last changed, in UTC."),
});

/** A maintenance window scheduled or in progress on the page's components. A window has no updates. */
export const summaryMaintenanceSchema = z.object({
  components: z
    .array(summaryComponentSchema)
    .describe("The page's components it affects."),
  created_at: timestampSchema.describe("When the window was created, in UTC."),
  id: z.string().describe("The maintenance window's id."),
  impact: z
    .literal("maintenance")
    .describe("Always maintenance: Statuspage's impact for a maintenance."),
  incident_updates: z
    .array(summaryUpdateSchema)
    .max(0)
    .describe("Always empty: a window has no updates."),
  monitoring_at: z.null().describe(alwaysNull),
  name: z.string().describe("The window's title."),
  page_id: z.string().describe("The status page's id."),
  resolved_at: z.null().describe("Null: the window has not ended."),
  scheduled_for: timestampSchema.describe("When the window starts, in UTC."),
  scheduled_until: timestampSchema.describe("When the window ends, in UTC."),
  shortlink: z.string().describe("The window's view on this page."),
  started_at: timestampSchema.describe("When the window was created, in UTC."),
  status: maintenanceStageSchema
    .exclude(["completed"])
    .describe("The window's stage: scheduled or in progress."),
  updated_at: timestampSchema.describe("When it last changed, in UTC."),
});

export const summaryDocumentSchema = z.object({
  components: z
    .array(summaryComponentSchema)
    .describe(
      "The page's components in its order, a group before its members."
    ),
  incidents: z
    .array(summaryIncidentSchema)
    .describe("The open incidents on the page's components."),
  page: z
    .object({
      id: z.string().describe("The status page's id."),
      name: z.string().describe("The page's title."),
      url: z
        .string()
        .describe(
          "The page's plain address: absolute on the public address or its custom domain, a path when no public address is stored."
        ),
      time_zone: z.string().describe("The install's time zone, an IANA name."),
      updated_at: timestampSchema.describe(
        "The latest change to the page or to anything the summary lists, in UTC."
      ),
    })
    .describe("The status page."),
  scheduled_maintenances: z
    .array(summaryMaintenanceSchema)
    .describe("The page's maintenance windows in progress and scheduled."),
  status: z
    .object({
      description: z
        .string()
        .describe(
          "Statuspage's sentence for the indicator, such as All Systems Operational."
        ),
      indicator: indicatorSchema.describe(
        "How bad the page is, worst last: none, maintenance, minor, major or critical."
      ),
    })
    .describe("The page's state as Statuspage gives it."),
});
export type SummaryDocument = z.infer<typeof summaryDocumentSchema>;

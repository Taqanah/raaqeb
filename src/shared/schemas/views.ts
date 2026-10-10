/**
 * The JSON documents of a status page's other views (CONTEXT.md "View"; ADR-0006):
 * the history of one month, one incident with its
 * updates, one maintenance window. Each carries the page's frame (its text,
 * images, customization, and the install's calendar and clock) beside what the view
 * shows, and nothing more: no author, no statuses an update set. Machine
 * values and the page's own content in each locale only, so one document serves both locales.
 * Times are ISO 8601 in UTC. Served under `/api/pages/<page id>/`; the OpenAPI document embeds these schemas.
 */
import { z } from "zod";
import { contentShapeSchema } from "./content.ts";
import { impactLevelSchema, incidentStageSchema } from "./incident.ts";
import { maintenanceStageSchema } from "./maintenance.ts";
import { overviewDocumentSchema } from "./overview.ts";

const timestampSchema = z.iso.datetime({ offset: true });

/** The words every field holding content ends with: one text per locale, read as CONTEXT.md "Content" says. */
const perLocale = "one text per locale";

/** A UTC month as the history names it: `2026-09`. */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export type Month = z.infer<typeof monthSchema>;

/** What every view shows of its page: the page's text, images and customization, and the install's calendar, clock and zone. */
export const viewFrameSchema = overviewDocumentSchema.pick({
  calendar: true,
  clock: true,
  page: true,
  timeZone: true,
});
export type ViewFrame = z.infer<typeof viewFrameSchema>;

/** A component a view names: one the page shows, in the page's order. */
export const viewComponentSchema = z.object({
  id: z.string().describe("The component's id."),
  name: contentShapeSchema.describe(`The component's name, ${perLocale}.`),
});

const affected = z
  .array(viewComponentSchema)
  .describe("The page's components it affects, in the page's order.");
export type ViewComponent = z.infer<typeof viewComponentSchema>;

/** One entry of a month's history: a resolved incident or a completed maintenance window. */
export const historyEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    components: affected,
    id: z.string().describe("The incident's id."),
    impact: impactLevelSchema.describe("The incident's impact level."),
    kind: z.literal("incident").describe("A resolved incident."),
    resolvedAt: timestampSchema.describe("When it was resolved, in UTC."),
    startedAt: timestampSchema.describe("When it started, in UTC."),
    title: contentShapeSchema.describe(`The incident's title, ${perLocale}.`),
  }),
  z.object({
    components: affected,
    endsAt: timestampSchema.describe("When the window ended, in UTC."),
    id: z.string().describe("The maintenance window's id."),
    kind: z.literal("maintenance").describe("A completed maintenance window."),
    startsAt: timestampSchema.describe("When the window started, in UTC."),
    title: contentShapeSchema.describe(`The window's title, ${perLocale}.`),
  }),
]);
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyDocumentSchema = viewFrameSchema.extend({
  entries: z
    .array(historyEntrySchema)
    .describe(
      "The month's entries by the UTC month they started in, newest first."
    ),
  month: monthSchema.describe("The UTC month the document holds, `yyyy-mm`."),
  next: monthSchema
    .optional()
    .describe("The month after, `yyyy-mm`; absent at the current month."),
  previous: monthSchema
    .optional()
    .describe(
      "The month before, `yyyy-mm`; absent at the history's first month: the page's oldest entry's or the day bar's first day's, whichever is earlier."
    ),
});
export type HistoryDocument = z.infer<typeof historyDocumentSchema>;

export const incidentDocumentSchema = viewFrameSchema.extend({
  incident: z
    .object({
      components: affected,
      id: z.string().describe("The incident's id."),
      impact: impactLevelSchema.describe("The incident's impact level."),
      resolvedAt: timestampSchema
        .optional()
        .describe("When it was resolved, in UTC; absent while it is open."),
      stage: incidentStageSchema.describe("The incident's stage."),
      startedAt: timestampSchema.describe("When it started, in UTC."),
      title: contentShapeSchema.describe(`The incident's title, ${perLocale}.`),
      updates: z
        .array(
          z.object({
            at: timestampSchema.describe("When it was posted, in UTC."),
            message: contentShapeSchema.describe(`What it says, ${perLocale}.`),
            stage: incidentStageSchema.describe(
              "The stage it moved the incident to."
            ),
          })
        )
        .describe("Every update, newest first."),
    })
    .describe("The incident the view shows."),
});
export type IncidentDocument = z.infer<typeof incidentDocumentSchema>;

export const maintenanceDocumentSchema = viewFrameSchema.extend({
  window: z
    .object({
      components: affected,
      endsAt: timestampSchema.describe("When the window ends, in UTC."),
      id: z.string().describe("The maintenance window's id."),
      message: contentShapeSchema.describe(
        `What the window is for, ${perLocale}.`
      ),
      stage: maintenanceStageSchema.describe(
        "The window's stage: scheduled, in progress or completed."
      ),
      startsAt: timestampSchema.describe("When the window starts, in UTC."),
      title: contentShapeSchema.describe(`The window's title, ${perLocale}.`),
    })
    .describe("The maintenance window the view shows."),
});
export type MaintenanceDocument = z.infer<typeof maintenanceDocumentSchema>;

const pageBase = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}`;

/** Where a browser fetches a page's history: the current month's with none named. */
export function historyUrl(pageId: string, month?: Month): string {
  return `${pageBase(pageId)}/history${month ? `/${month}` : ""}`;
}

/** Where a browser fetches one incident as the page shows it. */
export function incidentUrl(pageId: string, incidentId: string): string {
  return `${pageBase(pageId)}/incidents/${encodeURIComponent(incidentId)}`;
}

/** Where a browser fetches one maintenance window as the page shows it. */
export function maintenanceUrl(pageId: string, windowId: string): string {
  return `${pageBase(pageId)}/maintenance/${encodeURIComponent(windowId)}`;
}

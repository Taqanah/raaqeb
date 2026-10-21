/**
 * A report's shapes (CONTEXT.md "Report", "Uptime target", "Error budget"):
 * what the page asks for in its address and what the server answers, so the
 * admin never imports the server. Durations are milliseconds; dates are UTC
 * days as `yyyy-mm-dd`, the last day inclusive.
 */
import { z } from "zod";
import type { DisplayedUptime } from "@/shared/domain/uptime.ts";
import type { Content } from "./content.ts";
import type { ReasonCode } from "./reason.ts";

export const reportSubjectKinds = [
  "monitor",
  "group",
  "component",
  "page",
] as const;
export const reportSubjectKindSchema = z.enum(reportSubjectKinds);
export type ReportSubjectKind = z.infer<typeof reportSubjectKindSchema>;

/** The uptime a report judges against when none is asked for. */
export const defaultUptimeTarget = 99.9;

/** The least and most a target may be, with at most `targetDecimals` places. */
export const uptimeTargetMin = 1;
export const uptimeTargetMax = 99.999;
export const targetDecimals = 3;

/** A UTC day as the address writes it. */
export const reportDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The longest range a report covers, in days: a leap year. */
export const reportMaxDays = 366;

/** How many of the worst outages a report lists. */
export const worstOutagesShown = 10;

const idSchema = z.string().min(1).max(200);
const targetSchema = z.number().min(uptimeTargetMin).max(uptimeTargetMax);

/** What the report page's address carries (`/admin/reports?subject=&id=&from=&to=&target=`); a part that does not fit is left out, and the page asks for it again. */
export const reportSearchSchema = z.object({
  from: reportDateSchema.optional().catch(undefined),
  id: idSchema.optional().catch(undefined),
  subject: reportSubjectKindSchema.optional().catch(undefined),
  target: targetSchema.optional().catch(undefined),
  to: reportDateSchema.optional().catch(undefined),
});
export type ReportSearch = z.infer<typeof reportSearchSchema>;

/** What a report is asked for: all of it, since a report with a part missing is not one. */
export const reportQuerySchema = z.object({
  from: reportDateSchema,
  id: idSchema,
  subject: reportSubjectKindSchema,
  target: targetSchema,
  to: reportDateSchema,
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/** The download's query as the address writes it: the same, with the target a number in text. */
export const reportDownloadSchema = reportQuerySchema.extend({
  target: z.coerce.number().pipe(targetSchema),
});

/** A name a report shows: a monitor's and a group's are text, a component's and a page's are content in each locale. */
export type ReportName = Content | string;

/** What a report measured of one subject or member, over its range. */
export interface ReportFigures {
  /** Mean time from an outage's start to its acknowledge, over the outages that have one. */
  readonly acknowledgeMs: number | undefined;
  /** An estimate: each day's observed time scaled by its share of degraded checks. */
  readonly degradedMs: number;
  readonly downtimeMs: number;
  readonly incidents: number;
  /** Time under maintenance inside the range: neither observed time nor downtime. */
  readonly maintenanceMs: number;
  /** The range less observed time and maintenance. */
  readonly noDataMs: number;
  readonly observedMs: number;
  readonly outages: number;
  /** Mean duration of the outages that recovered inside the range. */
  readonly recoveryMs: number | undefined;
}

/** The downtime an uptime target allows over the observed time. */
export interface ErrorBudget {
  /** What the target allows, whole milliseconds cut down. */
  readonly allowedMs: number;
  /** Allowed less downtime; negative once the target is missed. */
  readonly leftMs: number;
  /** Whether uptime, not rounded, reaches the target. */
  readonly met: boolean;
  /** Downtime over the allowed; above 1 once the target is missed. */
  readonly usedRatio: number;
}

/** One subject or member: its figures, its uptime as displayed and its budget; both none with no observed time. */
export interface ReportLine {
  readonly budget: ErrorBudget | undefined;
  readonly figures: ReportFigures;
  readonly id: string;
  readonly name: ReportName;
  readonly uptime: DisplayedUptime | undefined;
}

/** One outage as a report lists it. */
export interface ReportOutage {
  readonly acknowledgedAt: number | undefined;
  /** Its time inside the range, less what maintenance covered. */
  readonly downtimeMs: number;
  readonly endedAt: number | undefined;
  readonly monitorId: string;
  readonly monitorName: string;
  readonly reason: ReasonCode;
  readonly startedAt: number;
}

export interface Report {
  /** The first UTC day, `yyyy-mm-dd`. */
  readonly from: string;
  /** When it was made. */
  readonly madeAt: number;
  /** The group's or page's members, the one with most downtime first; none for a monitor or a component. */
  readonly members: readonly ReportLine[];
  /** Whether the range reaches today, so its figures grow until it ends. */
  readonly open: boolean;
  readonly subject: { readonly kind: ReportSubjectKind } & ReportLine;
  readonly target: number;
  /** The last UTC day, `yyyy-mm-dd`, inclusive. */
  readonly to: string;
  /** The longest outages first, at most `worstOutagesShown`. */
  readonly worst: readonly ReportOutage[];
}

export type ReportResult =
  | { readonly ok: true; readonly report: Report }
  | {
      readonly ok: false;
      readonly reason: "corrupt" | "invalid" | "not_found" | "unavailable";
      readonly id?: string;
    };

/** What the form offers to report on. */
export interface ReportChoices {
  readonly components: readonly {
    readonly id: string;
    readonly name: Content;
  }[];
  readonly groups: readonly string[];
  readonly monitors: readonly { readonly id: string; readonly name: string }[];
  readonly pages: readonly { readonly id: string; readonly name: Content }[];
}

export type ReportChoicesResult =
  | { readonly ok: true; readonly choices: ReportChoices }
  | { readonly ok: false; readonly reason: "unavailable" };

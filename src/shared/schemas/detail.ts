/**
 * The monitor detail's shapes: what the page reads of one
 * monitor, the response-time series its chart draws, one check's failure
 * detail and capture opened from the recent checks, and "check now".
 */
import { z } from "zod";
import type { UptimeReading } from "@/shared/domain/uptime.ts";
import type { CertificateRecord } from "./certificate.ts";
import type { CaptureHeader, Check, CheckResult } from "./check.ts";
import type { HeartbeatView } from "./heartbeat.ts";
import type { Assertion, Monitor } from "./monitor.ts";
import type { Outage } from "./outage.ts";
import type { OverviewDay } from "./overview.ts";
import type { ReasonParams } from "./reason.ts";

/** The chart's ranges; nothing beyond 90 days. */
export const chartRanges = ["24h", "7d", "30d", "90d"] as const;
export const chartRangeSchema = z.enum(chartRanges);
export type ChartRange = z.infer<typeof chartRangeSchema>;

export const chartRangeMs: Readonly<Record<ChartRange, number>> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

/** The width of one point of the chart: 288 points over a day, 336 over a week, 360 over 30 and 90 days, whole hours so the hourly rollups fit. */
export const chartBucketMs: Readonly<Record<ChartRange, number>> = {
  "24h": 5 * 60_000,
  "7d": 30 * 60_000,
  "30d": 2 * 3_600_000,
  "90d": 6 * 3_600_000,
};

/** Where a range's chart reads: the raw checks, or the hourly rollups where a day is sealed. */
export type ChartTier = "raw" | "hourly";
export const chartTiers: Readonly<Record<ChartRange, ChartTier>> = {
  "24h": "raw",
  "7d": "raw",
  "30d": "hourly",
  "90d": "hourly",
};

/** The checks of one bucket of the chart; the response times are of the up and degraded checks only, since a down check's time is how long it took to fail. */
export interface ResponseBucket {
  /** The bucket's start, UTC milliseconds. */
  readonly at: number;
  /** Up and degraded checks with a response time; none when every check of the bucket was down. */
  readonly averageMs: number | undefined;
  readonly checks: number;
  readonly degraded: number;
  readonly down: number;
  readonly maxMs: number | undefined;
  readonly minMs: number | undefined;
}

/** What the chart draws: the buckets that hold a check, over `[from, to)`. */
export interface ResponseSeries {
  readonly bucketMs: number;
  readonly buckets: readonly ResponseBucket[];
  readonly from: number;
  /** Two points further apart than this are not joined: the gap is no data (CONTEXT.md "Observed time"). */
  readonly gapLimitMs: number;
  readonly range: ChartRange;
  readonly to: number;
}

/** How many recent checks the page lists. */
export const recentChecksShown = 20;

/** How many outages the page lists, newest first, of those inside the longest uptime window. */
export const outagesShown = 20;

/** How many UTC days the page's day bar shows. */
export const monitorBarDays = 90;

/** One UTC day of the monitor's day bar, with the outages that ran on it, oldest first. */
export interface MonitorDay extends OverviewDay {
  readonly outages: readonly Outage[];
}

export interface MonitorDetail {
  readonly certificate: CertificateRecord | undefined;
  /** None for a heartbeat monitor, which has no response time. */
  readonly chart: ResponseSeries | undefined;
  /** A maintenance window in progress covers it now, so it notifies nothing. */
  readonly covered: boolean;
  /** Its last `monitorBarDays` UTC days for its day bar, oldest first, today last. */
  readonly days: readonly MonitorDay[];
  /** A heartbeat monitor's URL and last heartbeat. */
  readonly heartbeat: HeartbeatView | undefined;
  readonly monitor: Monitor;
  /** The time the read was made; the page's relative times count from it. */
  readonly now: number;
  /** The outages inside the longest uptime window, newest first, at most `outagesShown`. */
  readonly outages: readonly Outage[];
  /** How many outages the longest uptime window holds. */
  readonly outagesTotal: number;
  /** The newest checks, newest first. */
  readonly recent: readonly Check[];
  /** The checks list's first page: the span the chart is zoomed into or, unzoomed, the raw checks' window. */
  readonly spanChecks: SpanChecks;
  /** The latest check's result; none before the first check. */
  readonly state: CheckResult | undefined;
  readonly uptime: readonly UptimeReading[];
}

/** A page of a zoomed span's checks, newest first, and whether older ones remain in the span. */
export interface SpanChecksPage {
  readonly checks: readonly Check[];
  readonly more: boolean;
}

/** The checks list's first page, with the start of the span a later page reads up to the oldest check shown; or none kept when a zoomed span ended before the raw checks' window, where only rollups remain. */
export type SpanChecks =
  | ({ readonly kept: true; readonly from: number } & SpanChecksPage)
  | { readonly kept: false };

export type SpanChecksResult =
  | ({ readonly ok: true } & SpanChecksPage)
  | { readonly ok: false; readonly reason: "unavailable" | "corrupt" };

export type MonitorDetailResult =
  | { readonly ok: true; readonly detail: MonitorDetail }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" }
  /** A stored record of this monitor no longer fits this version's schema; `id` names the monitor. */
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string };

/** A span of the chart the operator zoomed into, UTC milliseconds over `[from, to)`. */
export const chartSpanSchema = z.object({
  from: z.int().nonnegative(),
  to: z.int().nonnegative(),
});
export type ChartSpan = z.infer<typeof chartSpanSchema>;

export const monitorDetailReadSchema = z.object({
  id: z.string().min(1),
  range: chartRangeSchema,
  span: chartSpanSchema.optional(),
});

/** The page's search parameters (`/admin/monitors/<id>?range=7d&from=…&to=…`): a range, and the span zoomed into; anything else is the day, unzoomed. */
export const monitorDetailSearchSchema = z.object({
  from: z.int().nonnegative().optional().catch(undefined),
  range: chartRangeSchema.optional().catch(undefined),
  to: z.int().nonnegative().optional().catch(undefined),
});

/** A page of a zoomed span's checks: the next is the span up to the oldest check the page shows. */
export const spanChecksReadSchema = z.object({
  id: z.string().min(1),
  span: chartSpanSchema,
});

export const checkRecordReadSchema = z.object({
  id: z.string().min(1),
  startedAt: z.int().nonnegative(),
});

/** What one recent check opens to: its failure detail and its capture, when it kept them. */
export interface CheckRecord {
  readonly capture:
    | {
        /** The first 4 KB of the body as text. */
        readonly body: string;
        readonly headers: readonly CaptureHeader[];
      }
    | undefined;
  readonly failure:
    | {
        readonly assertion: Assertion | undefined;
        readonly error: string | undefined;
        readonly params: ReasonParams;
      }
    | undefined;
}

export type CheckRecordResult =
  | { readonly ok: true; readonly record: CheckRecord }
  | { readonly ok: false; readonly reason: "unavailable" | "corrupt" };

export const checkNowSchema = z.object({ id: z.string().min(1) });

/** Why "check now" did not bring a check forward. */
export type CheckNowRefusal =
  /** The monitor is paused; paused runs nothing. */
  | "paused"
  /** A heartbeat monitor's check is its window's evaluation, never brought forward. */
  | "heartbeat"
  | "not_found"
  /** No database or no scheduler answers. */
  | "unavailable";

/** What the scheduler said to "check now", and from when the page waits for the asked check. */
export interface CheckAsked {
  /** `running` when a check of the monitor was already in flight; the page waits for it all the same. */
  readonly answer: "queued" | "running";
  /** The asked check starts at this time or later: when the check in flight started, or when the ask arrived. */
  readonly from: number;
}

export type CheckNowResult =
  | ({ readonly ok: true } & CheckAsked)
  | { readonly ok: false; readonly reason: CheckNowRefusal };

/** The outage to acknowledge: its monitor and its start, as the screen showed it, so an outage opened since is never the one acknowledged. */
export const acknowledgeSchema = z.object({
  id: z.string().min(1),
  startedAt: z.int().nonnegative(),
});
export type AcknowledgeInput = z.infer<typeof acknowledgeSchema>;

/** Why an acknowledgement was refused. */
export type AcknowledgeRefusal =
  /** The outage named is not open: it recovered, the monitor was paused or deleted, or it never was. */
  | "no_outage"
  /** Its open outage was acknowledged before; there is no undo. */
  | "acknowledged"
  | "unavailable";

/** What acknowledging a monitor's open outage answers: when it was acknowledged, or why it was not. */
export type AcknowledgeResult =
  | { readonly acknowledgedAt: number; readonly ok: true }
  | { readonly ok: false; readonly reason: AcknowledgeRefusal };

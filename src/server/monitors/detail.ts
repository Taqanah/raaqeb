/**
 * The monitor detail's reads: one monitor with its state,
 * its uptime over the four windows, the response-time series of the chart,
 * its day bar's days with the outages that ran on each, the recent
 * checks, a page at a time back through the raw checks' window or, zoomed,
 * the span, the outages, the certificate record and, for a heartbeat monitor,
 * its URL and last heartbeat; one check's failure detail and capture;
 * "check now", which hands the monitor to the scheduler; and acknowledging
 * the open outage, which stops its reminders. Uptime reads the checks over
 * the raw window and the hourly rollups before it, or before the oldest
 * check a size-budget delete left. Every function answers a result and
 * never throws.
 */

import { gapLimitMs } from "@/server/checks/heartbeat.ts";
import type {
  CheckRequests,
  OutageRequests,
} from "@/server/scheduler/scheduler.ts";
import { readClock } from "@/server/settings/clock.ts";
import { readRetentionDays } from "@/server/settings/retention.ts";
import { coveredMonitors, coveredSpans } from "@/server/status/maintenance.ts";
import { CertificateShapeError } from "@/server/storage/certificates.ts";
import { CheckShapeError } from "@/server/storage/checks.ts";
import { MonitorShapeError } from "@/server/storage/monitors.ts";
import { OutageShapeError } from "@/server/storage/outages.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { zoomedChart } from "@/shared/domain/chart.ts";
import { retentionBounds } from "@/shared/domain/retention.ts";
import {
  rawFromOf,
  rawWindowMs,
  uptimeReadings,
  uptimeWindowMs,
} from "@/shared/domain/uptime.ts";
import {
  type AcknowledgeInput,
  type AcknowledgeResult,
  type ChartRange,
  type ChartSpan,
  type CheckNowResult,
  type CheckRecordResult,
  chartBucketMs,
  chartRangeMs,
  chartTiers,
  type MonitorDetailResult,
  monitorBarDays,
  outagesShown,
  recentChecksShown,
  type SpanChecks,
  type SpanChecksPage,
  type SpanChecksResult,
} from "@/shared/schemas/detail.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import { dayView, readMonitorDays } from "./days.ts";
import { heartbeatView, readReach } from "./monitors.ts";

type DetailStorage = Pick<
  Storage,
  | "certificates"
  | "checks"
  | "components"
  | "heartbeats"
  | "maintenance"
  | "monitors"
  | "outages"
  | "settings"
>;

const unavailable = { ok: false, reason: "unavailable" } as const;

/** The longest uptime window; the outages listed and the hourly rollups read span it. */
const longestWindow = uptimeWindowMs["90d"];

export interface DetailOptions {
  readonly now: number;
  readonly range: ChartRange;
  /** The request's origin, for a heartbeat monitor's URL when no public address is stored. */
  readonly requestOrigin: string | undefined;
  /** A span of the range the operator zoomed into; the chart reads it with finer points. */
  readonly span?: ChartSpan;
}

const dayMs = 86_400_000;

/** The outages that ran on the UTC day starting at `day`, oldest first, from `outages` newest first; one that ended as it started ran at its start. */
function ranOn(outages: readonly Outage[], day: number): Outage[] {
  return outages
    .filter(
      (each) =>
        each.startedAt < day + dayMs &&
        (each.startedAt >= day ||
          (each.endedAt ?? Number.POSITIVE_INFINITY) > day)
    )
    .toReversed();
}

/** A stored record this version cannot read, named by its monitor. */
function shapeError(error: unknown): string | undefined {
  if (
    error instanceof MonitorShapeError ||
    error instanceof CheckShapeError ||
    error instanceof OutageShapeError ||
    error instanceof CertificateShapeError
  ) {
    return error.monitorId;
  }
}

export async function readMonitorDetail(
  storage: DetailStorage,
  id: string,
  { now, range, requestOrigin, span }: DetailOptions
): Promise<MonitorDetailResult> {
  try {
    const monitor = await storage.monitors.find(id);
    if (!monitor) {
      return { ok: false, reason: "not_found" };
    }
    const { timeZone } = await readClock(storage);
    const limit = gapLimitMs(monitor, now, timeZone);
    const since = now - longestWindow;
    const rawStart = now - rawWindowMs;
    // A span the operator zoomed into is read in its own, finer points; a span too narrow to show is the range.
    const zoom = span === undefined ? undefined : zoomedChart(span, now);
    const bucketMs = zoom?.bucketMs ?? chartBucketMs[range];
    const tier = zoom?.tier ?? chartTiers[range];
    // On the hourly tier a bucket is whole hours, so the rollups fall inside it.
    const chartFrom =
      zoom?.from ??
      (tier === "raw"
        ? now - chartRangeMs[range]
        : Math.floor((now - chartRangeMs[range]) / bucketMs) * bucketMs);
    const chartTo = zoom?.to ?? now;
    const heartbeat = monitor.config.type === "heartbeat";
    const rawFrom = rawChecksFrom(storage, monitor, now);
    const [
      coverage,
      hours,
      outages,
      newest,
      buckets,
      certificate,
      beats,
      reach,
      barDays,
      rawStartsAt,
      zoomedChecks,
    ] = await Promise.all([
      // A check just before the raw window covers its start, so the read reaches one gap limit further back.
      storage.checks.coverage(id, rawStart - limit, now, limit),
      // An hour the longest window's start cuts counts in part, so the read starts an hour early; it runs to now, since a size-budget delete may have left only rollups inside the raw window.
      storage.checks.rollups(id, "hour", since - 3_600_000, now),
      storage.outages.list(id, since),
      // One check past the page says whether older ones remain.
      storage.checks.recent(id, recentChecksShown + 1),
      heartbeat
        ? undefined
        : storage.checks.series(id, chartFrom, chartTo, bucketMs, tier),
      storage.certificates.find(id),
      heartbeatView(storage, monitor, requestOrigin),
      readReach(storage, since),
      // One read of each kind for the bar's 90 days, never one a day.
      readMonitorDays(storage, [monitor], { days: monitorBarDays, now }),
      rawFrom,
      // The list follows the chart: zoomed only where the chart zoomed.
      span === undefined || zoom === undefined || heartbeat
        ? undefined
        : firstSpanPage(storage, id, span, rawFrom),
    ]);
    const recent = newest.slice(0, recentChecksShown);
    const older = newest.at(recentChecksShown)?.startedAt;
    const { components, windows } = reach;
    return {
      detail: {
        certificate,
        covered: coveredMonitors(windows, components).has(id),
        days: (barDays.get(id) ?? []).map((each) => ({
          ...dayView(each),
          outages: ranOn(outages, each.day),
        })),
        chart: buckets && {
          bucketMs,
          buckets,
          from: chartFrom,
          gapLimitMs: limit,
          range,
          to: chartTo,
        },
        heartbeat: beats,
        monitor,
        now,
        outages: outages.slice(0, outagesShown),
        outagesTotal: outages.length,
        recent,
        // Unzoomed, the list is the span from the raw checks' window to now.
        spanChecks: zoomedChecks ?? {
          checks: recent,
          from: rawStartsAt,
          kept: true,
          more: older !== undefined && older >= rawStartsAt,
        },
        state: recent[0]?.result,
        uptime: uptimeReadings({
          coverage,
          excluded: coveredSpans(windows, components, now).get(id) ?? [],
          gapLimitMs: limit,
          hours,
          now,
          outages,
          rawFrom: rawFromOf(coverage, now, rawWindowMs),
        }),
      },
      ok: true,
    };
  } catch (error) {
    const corrupt = shapeError(error);
    return corrupt === undefined
      ? unavailable
      : { id: corrupt, ok: false, reason: "corrupt" };
  }
}

/** One page of a span's checks; one check past the page says whether older ones remain. */
async function spanPage(
  storage: DetailStorage,
  id: string,
  span: ChartSpan
): Promise<SpanChecksPage> {
  const checks = await storage.checks.recent(id, recentChecksShown + 1, span);
  return {
    checks: checks.slice(0, recentChecksShown),
    more: checks.length > recentChecksShown,
  };
}

/** Where the monitor's raw checks start, by its retention or the install's; the nightly job empties what lies before. */
async function rawChecksFrom(
  storage: DetailStorage,
  monitor: Monitor,
  now: number
): Promise<number> {
  const retention = monitor.retentionDays ?? (await readRetentionDays(storage));
  return retentionBounds(retention, now).raw;
}

/** A zoomed span's first page, or none kept once the span ended before the raw checks' window. */
async function firstSpanPage(
  storage: DetailStorage,
  id: string,
  span: ChartSpan,
  rawFrom: Promise<number>
): Promise<SpanChecks> {
  if (span.to <= (await rawFrom)) {
    return { kept: false };
  }
  return {
    from: span.from,
    kept: true,
    ...(await spanPage(storage, id, span)),
  };
}

/** One page of a zoomed span's checks, newest first, at most `recentChecksShown`, and whether older ones remain in the span. */
export async function readSpanChecks(
  storage: DetailStorage,
  id: string,
  span: ChartSpan
): Promise<SpanChecksResult> {
  try {
    return { ok: true, ...(await spanPage(storage, id, span)) };
  } catch (error) {
    return error instanceof CheckShapeError
      ? { ok: false, reason: "corrupt" }
      : unavailable;
  }
}

/** One check's failure detail and capture, the body as text. */
export async function readCheckRecord(
  storage: DetailStorage,
  id: string,
  startedAt: number
): Promise<CheckRecordResult> {
  try {
    const [detail, capture] = await Promise.all([
      storage.checks.detail(id, startedAt),
      storage.checks.capture(id, startedAt),
    ]);
    return {
      ok: true,
      record: {
        capture: capture && {
          body: new TextDecoder().decode(capture.body),
          headers: capture.headers,
        },
        failure: detail && {
          assertion: detail.assertion,
          error: detail.error,
          params: detail.params,
        },
      },
    };
  } catch (error) {
    return error instanceof CheckShapeError
      ? { ok: false, reason: "corrupt" }
      : unavailable;
  }
}

/** "Check now": refused for a paused or heartbeat monitor, otherwise the scheduler runs its next check at the next tick. */
export async function checkNow(
  storage: DetailStorage,
  scheduler: CheckRequests | undefined,
  id: string
): Promise<CheckNowResult> {
  if (!scheduler) {
    return unavailable;
  }
  let monitor: Monitor | undefined;
  try {
    monitor = await storage.monitors.find(id);
  } catch {
    return unavailable;
  }
  if (!monitor) {
    return { ok: false, reason: "not_found" };
  }
  if (monitor.paused) {
    return { ok: false, reason: "paused" };
  }
  if (monitor.config.type === "heartbeat") {
    return { ok: false, reason: "heartbeat" };
  }
  return { ...scheduler.checkNow(id), ok: true };
}

/** Acknowledges the outage the screen showed, by its monitor and start: its reminders stop, its checks, its outage and its recovered notification go on. Refused when that outage is no longer open or was acknowledged before. */
export async function acknowledgeOutage(
  storage: Pick<Storage, "bump" | "outages">,
  scheduler: OutageRequests | undefined,
  { id, startedAt }: AcknowledgeInput,
  now: number
): Promise<AcknowledgeResult> {
  try {
    const outage = await storage.outages.acknowledge(id, startedAt, now);
    if (!outage) {
      // The guarded write refused; whether the outage named is still open says why.
      const open = await storage.outages.list(id, now);
      return {
        ok: false,
        reason: open.some(
          (each) => each.endedAt === undefined && each.startedAt === startedAt
        )
          ? "acknowledged"
          : "no_outage",
      };
    }
    // With no scheduler running the column alone carries it; the reminders read it when one starts.
    scheduler?.acknowledge(outage);
    await storage.bump();
    return { acknowledgedAt: now, ok: true };
  } catch {
    return unavailable;
  }
}

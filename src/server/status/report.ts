/**
 * What a report measures (CONTEXT.md "Report"): the daily figures the bars
 * read, summed over a range, with the outages and incidents that ran inside
 * it counted. Different from a bar's day by nothing but the range: the
 * downtime and the observed time are the bars' own. Pure: every record is a
 * parameter.
 */
import {
  type ComponentDay,
  clipped,
  unionLength,
} from "@/server/status/uptime.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import { type Span, without } from "@/shared/domain/uptime.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import type { ReportFigures, ReportOutage } from "@/shared/schemas/report.ts";

const dayMs = 86_400_000;

/** An outage as a report counts it. */
/** An outage as the counting reads it; its monitor's name and check type are the report's to add. */
export type CountedOutage = Omit<ReportOutage, "checkType" | "monitorName">;

/** One subject's or member's measurements: sums, and the records counted, kept to merge members without counting a shared one twice. */
export interface Measured {
  readonly degradedMs: number;
  readonly downtimeMs: number;
  readonly incidentIds: readonly string[];
  readonly maintenanceMs: number;
  readonly noDataMs: number;
  readonly observedMs: number;
  readonly outages: readonly CountedOutage[];
}

/** The outages that ran inside the range with time counted there, oldest first: each with its time inside the range less the spans maintenance covered the monitor, and, when the monitor's observed time by UTC day start is given, never more on a day than that day was observed (the bars' own cap, shared out among the day's outages in proportion), and none that has none left. An open outage runs to the end of the range. */
export function countedOutages(input: {
  readonly covered: readonly Span[];
  readonly observed?: ReadonlyMap<number, number>;
  readonly outages: readonly Outage[];
  readonly range: Span;
}): CountedOutage[] {
  const spans = input.outages.map((outage) =>
    without(clipped([outage], input.range), input.covered)
  );
  const { observed } = input;
  // Each outage's time by UTC day, and every day's total, so a day observed for less than its outages ran shares what it was observed among them.
  const byDay = observed ? spans.map(daysOf) : [];
  const dayTotals = new Map<number, number>();
  for (const days of byDay) {
    for (const [at, ms] of days) {
      dayTotals.set(at, (dayTotals.get(at) ?? 0) + ms);
    }
  }
  const counted: CountedOutage[] = [];
  input.outages.forEach((outage, index) => {
    let downtimeMs = unionLength(spans[index] ?? []);
    if (observed) {
      downtimeMs = 0;
      for (const [at, ms] of byDay[index] ?? []) {
        const share = Math.min(
          1,
          (observed.get(at) ?? 0) / (dayTotals.get(at) ?? 1)
        );
        downtimeMs += ms * share;
      }
      downtimeMs = Math.round(downtimeMs);
    }
    if (downtimeMs > 0) {
      counted.push({
        acknowledgedAt: outage.acknowledgedAt,
        downtimeMs,
        endedAt: outage.endedAt,
        monitorId: outage.monitorId,
        reason: outage.reason,
        startedAt: outage.startedAt,
      });
    }
  });
  return counted.toSorted((a, b) => a.startedAt - b.startedAt);
}

/** The length of the disjoint spans inside each UTC day they touch, by day start. */
function daysOf(spans: readonly Span[]): Map<number, number> {
  const days = new Map<number, number>();
  for (const span of spans) {
    for (let at = utcDayStart(span.from); at < span.to; at += dayMs) {
      const part = Math.min(span.to, at + dayMs) - Math.max(span.from, at);
      days.set(at, (days.get(at) ?? 0) + part);
    }
  }
  return days;
}

/** The sums of the range's days, the time under maintenance inside it, and what is left of it for no data. */
export function measure(input: {
  readonly days: readonly ComponentDay[];
  readonly degradedMs: number;
  readonly incidentIds: readonly string[];
  /** Spans of maintenance, overlaps allowed. */
  readonly maintenance: readonly Span[];
  readonly outages: readonly CountedOutage[];
  readonly range: Span;
}): Measured {
  let downtimeMs = 0;
  let observedMs = 0;
  for (const day of input.days) {
    downtimeMs += day.downtimeMs;
    observedMs += day.observedMs;
  }
  const maintenanceMs = unionLength(
    clipped(
      input.maintenance.map((span) => ({
        endedAt: span.to,
        startedAt: span.from,
      })),
      input.range
    )
  );
  return {
    degradedMs: input.degradedMs,
    downtimeMs,
    incidentIds: input.incidentIds,
    maintenanceMs,
    // Observed time and maintenance may overlap in a gap, which both leave out, so the rest is never below nothing.
    noDataMs: Math.max(
      0,
      input.range.to - input.range.from - observedMs - maintenanceMs
    ),
    observedMs,
    outages: input.outages,
  };
}

/** Members added up: times summed, outages and incidents counted once however many members hold them. */
export function combine(parts: readonly Measured[]): Measured {
  const outages = new Map<string, CountedOutage>();
  const incidents = new Set<string>();
  const sum = {
    degradedMs: 0,
    downtimeMs: 0,
    maintenanceMs: 0,
    noDataMs: 0,
    observedMs: 0,
  };
  for (const part of parts) {
    sum.degradedMs += part.degradedMs;
    sum.downtimeMs += part.downtimeMs;
    sum.maintenanceMs += part.maintenanceMs;
    sum.noDataMs += part.noDataMs;
    sum.observedMs += part.observedMs;
    for (const outage of part.outages) {
      outages.set(`${outage.monitorId}@${outage.startedAt}`, outage);
    }
    for (const id of part.incidentIds) {
      incidents.add(id);
    }
  }
  return {
    ...sum,
    incidentIds: [...incidents],
    outages: [...outages.values()],
  };
}

/** The mean of the values, or nothing for none. */
function mean(values: readonly number[]): number | undefined {
  return values.length === 0
    ? undefined
    : values.reduce((sum, each) => sum + each, 0) / values.length;
}

/** The figures of a measurement: counts and the two means, of the outages that recovered by the range's end. */
export function figuresOf(measured: Measured, range: Span): ReportFigures {
  const { outages } = measured;
  return {
    acknowledgeMs: mean(
      outages.flatMap((each) =>
        each.acknowledgedAt === undefined
          ? []
          : [each.acknowledgedAt - each.startedAt]
      )
    ),
    degradedMs: measured.degradedMs,
    downtimeMs: measured.downtimeMs,
    incidents: measured.incidentIds.length,
    maintenanceMs: measured.maintenanceMs,
    noDataMs: measured.noDataMs,
    observedMs: measured.observedMs,
    outages: outages.length,
    recoveryMs: mean(
      outages.flatMap((each) =>
        each.endedAt === undefined || each.endedAt > range.to
          ? []
          : [each.endedAt - each.startedAt]
      )
    ),
  };
}

/** The longest outages first, at most `limit`, the earlier one first among equals. */
export function worstOutages(
  outages: readonly CountedOutage[],
  limit: number
): CountedOutage[] {
  return outages
    .toSorted(
      (a, b) => b.downtimeMs - a.downtimeMs || a.startedAt - b.startedAt
    )
    .slice(0, limit);
}

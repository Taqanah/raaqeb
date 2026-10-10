/**
 * A component's uptime and its day bar (CONTEXT.md "Component", "Day
 * bar"): per UTC day, the union of its linked monitors'
 * outage time and the time incidents held it at partial or major outage, over its
 * observed time. A day's observed time is the largest of its linked
 * monitors' that day, so a paused day is no data (scenario 4), and the
 * union of their observed time is never over-counted: the figure can read
 * lower than the truth, never higher. An incident's time is observed, since
 * someone declared it. An unlinked component counts every day since it was
 * created. A maintenance window's time is neither
 * observed time nor downtime: its component's windows are cut out of the
 * day, and a covered monitor's outages lose the time windows covered it.
 * Different from a monitor's uptime (shared/domain/uptime.ts), which this
 * never mixes with. Pure: `now` and every record are parameters.
 */
import { utcDayStart } from "@/shared/domain/retention.ts";
import {
  type CheckCoverage,
  type OutageSpan,
  observedSpans,
  type Span,
  spansLength,
  without,
} from "@/shared/domain/uptime.ts";
import type { Content } from "@/shared/schemas/content.ts";
import type { Incident } from "@/shared/schemas/incident.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";

const dayMs = 86_400_000;

/** One UTC day of a component: `1 - downtimeMs / observedMs` is its uptime; no observed time is no data. */
export interface ComponentDay {
  /** The day's start, UTC milliseconds. */
  readonly day: number;
  readonly downtimeMs: number;
  readonly observedMs: number;
}

/** A daily rollup as the bar reads it: its observed time only. */
export interface ObservedDay {
  /** The day's start, UTC milliseconds. */
  readonly at: number;
  readonly observedMs: number;
}

/**
 * One monitor's observed time by UTC day start over `[from, now)`: the
 * daily rollups where a day is sealed, and the checks' coverage from
 * `coverageFrom` on (the day after the last sealed one), read with the
 * monitor's gap limit as its uptime reads it.
 */
export function monitorObservedDays(input: {
  readonly coverage: CheckCoverage | undefined;
  readonly coverageFrom: number;
  readonly days: readonly ObservedDay[];
  /** The spans windows covered the monitor (`coveredSpans`); sealed days left them out when they were sealed. */
  readonly excluded: readonly Span[];
  readonly from: number;
  readonly gapLimitMs: number;
  readonly now: number;
}): Map<number, number> {
  const observed = new Map<number, number>();
  for (const each of input.days) {
    if (
      each.at >= input.from &&
      each.at < input.coverageFrom &&
      each.observedMs > 0
    ) {
      observed.set(each.at, each.observedMs);
    }
  }
  const spans = observedSpans(
    input.coverage,
    { from: Math.max(input.from, input.coverageFrom), to: input.now },
    input.gapLimitMs,
    input.excluded
  );
  for (const span of spans) {
    for (let at = utcDayStart(span.from); at < span.to; at += dayMs) {
      const part = Math.min(span.to, at + dayMs) - Math.max(span.from, at);
      observed.set(at, (observed.get(at) ?? 0) + part);
    }
  }
  return observed;
}

/** The levels an incident holds a component down at; degraded performance is not one. */
const downLevels: ReadonlySet<StatusLevel> = new Set([
  "partial_outage",
  "major_outage",
]);

/**
 * The spans incidents held each component they affect at partial or major
 * outage, by component id: downtime on its bar.
 * Degraded performance never is, as a degraded monitor is never down. An
 * update's status holds from its time to the incident's next update; the
 * latest update of an open incident holds on, and resolving ends every
 * hold, whatever status the operator keeps.
 */
export function incidentDowntime(
  incidents: readonly Incident[]
): Map<string, OutageSpan[]> {
  const spans = new Map<string, OutageSpan[]>();
  for (const { updates } of incidents) {
    updates.forEach((update, index) => {
      if (update.stage === "resolved") {
        return;
      }
      const next = updates[index + 1];
      for (const { componentId, status } of update.statuses) {
        if (downLevels.has(status)) {
          spans.set(componentId, [
            ...(spans.get(componentId) ?? []),
            { endedAt: next?.createdAt, startedAt: update.createdAt },
          ]);
        }
      }
    });
  }
  return spans;
}

/** A linked monitor as the component's bar reads it. */
export interface MonitorHistory {
  /** The spans windows covered it (`coveredSpans`): its outages there are never downtime. */
  readonly covered: readonly Span[];
  /** Observed time by UTC day start. */
  readonly observed: ReadonlyMap<number, number>;
  readonly outages: readonly OutageSpan[];
}

/** The component's days from `from`, a UTC day start, to today, oldest first; today's ends at `now`. */
export function componentDays(input: {
  /** When the component was created; an unlinked component's days start there. */
  readonly createdAt: number;
  readonly from: number;
  /** The spans incidents held it at partial or major outage (`incidentDowntime`); an open one runs to `now`. */
  readonly incidents: readonly OutageSpan[];
  /** The spans it was under maintenance (`maintenanceSpans`): neither observed time nor downtime. */
  readonly maintenance: readonly Span[];
  /** Its linked monitors; none for an unlinked component. */
  readonly monitors: readonly MonitorHistory[];
  readonly now: number;
}): ComponentDay[] {
  const { maintenance, now } = input;
  const days: ComponentDay[] = [];
  for (let day = input.from; day < now; day += dayMs) {
    const span = { from: day, to: Math.min(day + dayMs, now) };
    // A window on the component is neither observed time nor downtime, whatever held it.
    const incidents = without(clipped(input.incidents, span), maintenance);
    const incidentMs = unionLength(incidents);
    const since = { from: Math.max(span.from, input.createdAt), to: span.to };
    const monitorsMs =
      input.monitors.length === 0
        ? Math.max(0, spansLength(without([since], maintenance)))
        : Math.max(0, ...input.monitors.map((m) => m.observed.get(day) ?? 0));
    const observedMs = Math.max(monitorsMs, incidentMs);
    // A covered monitor's outage is no downtime while a window covered it, on any component it drives; its windows hold every window on this component, since reach reads the same links.
    const outages = input.monitors.flatMap((monitor) =>
      without(clipped(monitor.outages, span), monitor.covered)
    );
    const down = unionLength([...outages, ...incidents]);
    days.push({ day, downtimeMs: Math.min(down, observedMs), observedMs });
  }
  return days;
}

/** An incident or a maintenance window as a day of the bar names it. */
export interface DayNotice {
  readonly id: string;
  readonly title: Content;
}

/** A notice with the time it ran: an incident from its creation to its resolution, a window from its start to its end; an open one runs on. */
export interface NoticeSpan extends DayNotice, OutageSpan {}

/** A monitor's response times on one UTC day: the mean of its up and degraded checks and how many it averages. */
export interface ResponseDay {
  readonly averageMs: number;
  readonly timed: number;
}

/** What a day of the bar shows beside its uptime. */
export interface DayDetail {
  /** The incidents that ran on the day, in the order given. */
  readonly incidents: readonly DayNotice[];
  /** The maintenance windows that ran on the day, in the order given. */
  readonly maintenance: readonly DayNotice[];
  /** The mean response time of the linked monitors' up and degraded checks that day, each check weighing the same, whole milliseconds; none without one. */
  readonly responseMs: number | undefined;
}

/** A day of a bar: its uptime's parts and what it shows beside them. */
export type BarDay = ComponentDay & DayDetail;

/** A component's day details from `from`, a UTC day start, to today, oldest first, as `componentDays` lays out its days. */
export function dayDetails(input: {
  readonly from: number;
  /** The incidents and the started maintenance windows that affect the component. */
  readonly notices: {
    readonly incidents: readonly NoticeSpan[];
    readonly maintenance: readonly NoticeSpan[];
  };
  readonly now: number;
  /** Each linked monitor's response times by UTC day start. */
  readonly response: readonly ReadonlyMap<number, ResponseDay>[];
}): DayDetail[] {
  const details: DayDetail[] = [];
  for (let day = input.from; day < input.now; day += dayMs) {
    const span = { from: day, to: day + dayMs };
    let totalMs = 0;
    let timed = 0;
    for (const monitor of input.response) {
      const each = monitor.get(day);
      if (each) {
        totalMs += each.averageMs * each.timed;
        timed += each.timed;
      }
    }
    details.push({
      incidents: ranOn(input.notices.incidents, span),
      maintenance: ranOn(input.notices.maintenance, span),
      responseMs: timed > 0 ? Math.round(totalMs / timed) : undefined,
    });
  }
  return details;
}

/** The notices that ran inside `span`; one that started and ended at once ran at its start. */
function ranOn(notices: readonly NoticeSpan[], span: Span): DayNotice[] {
  return notices
    .filter(
      (each) =>
        each.startedAt < span.to &&
        (each.startedAt >= span.from ||
          (each.endedAt ?? Number.POSITIVE_INFINITY) > span.from)
    )
    .map(({ id, title }) => ({ id, title }));
}

/** The parts of the spans inside `span`, which never ends past now, so an open one runs to its end. */
function clipped(spans: readonly OutageSpan[], span: Span): Span[] {
  return spans
    .map((each) => ({
      from: Math.max(each.startedAt, span.from),
      to: Math.min(each.endedAt ?? span.to, span.to),
    }))
    .filter((each) => each.from < each.to);
}

/** The length of the union of the spans, overlaps counted once. */
function unionLength(spans: readonly Span[]): number {
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans.toSorted((a, b) => a.from - b.from)) {
    const start = Math.max(span.from, end);
    if (span.to > start) {
      total += span.to - start;
      end = span.to;
    }
  }
  return total;
}

/**
 * The report (CONTEXT.md "Report"): one subject's uptime over a range of
 * UTC days, read from what the bars read (the daily rollups, the checks of
 * the days not yet sealed, the outage records, the incidents and the
 * maintenance windows) and summed by `status/report.ts`, so its figures are
 * the status page's. It reads a few monitors at a time and keeps only each
 * one's sums, so a quarter of many monitors never holds many monitors' days
 * at once. Throws nothing: a read that fails answers why.
 */
import {
  type MonitorDays,
  readMonitorHistories,
} from "@/server/monitors/days.ts";
import { corruptRecord } from "@/server/pages/components.ts";
import { coveredSpans, maintenanceSpans } from "@/server/status/maintenance.ts";
import {
  type CountedOutage,
  combine,
  countedOutages,
  figuresOf,
  type Measured,
  measure,
  worstOutages,
} from "@/server/status/report.ts";
import { componentDays, incidentDowntime } from "@/server/status/uptime.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { affectedComponents } from "@/shared/domain/incidents.ts";
import { errorBudget, reportPeriod } from "@/shared/domain/report.ts";
import {
  displayedUptime,
  type OutageSpan,
  type Span,
} from "@/shared/domain/uptime.ts";
import type { Component } from "@/shared/schemas/component.ts";
import type { Incident } from "@/shared/schemas/incident.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import {
  type ReportChoicesResult,
  type ReportLine,
  type ReportName,
  type ReportQuery,
  type ReportResult,
  type ReportSubjectKind,
  targetDecimals,
  uptimeTargetMax,
  uptimeTargetMin,
  worstOutagesShown,
} from "@/shared/schemas/report.ts";

export type ReportStorage = Pick<
  Storage,
  | "checks"
  | "components"
  | "incidents"
  | "maintenance"
  | "monitors"
  | "outages"
  | "pages"
  | "settings"
>;

/** How many monitors one read of the storage names: a report reads a few at a time, so what it holds is a few monitors' days, however many it reports on. */
export const monitorsPerRead = 8;

const dayMs = 86_400_000;

/** What the form offers to report on: every monitor, group, component and status page. */
export async function readReportChoices(
  storage: ReportStorage
): Promise<ReportChoicesResult> {
  try {
    const [monitors, components, pages] = await Promise.all([
      storage.monitors.list(),
      storage.components.list(),
      storage.pages.list(),
    ]);
    const collator = new Intl.Collator();
    return {
      choices: {
        components: components.map(({ id, name }) => ({ id, name })),
        groups: [
          ...new Set(monitors.flatMap((each) => each.group ?? [])),
        ].toSorted(collator.compare),
        monitors: monitors
          .map(({ id, name }) => ({ id, name }))
          .toSorted((a, b) => collator.compare(a.name, b.name)),
        pages: pages.map(({ id, title }) => ({ id, name: title })),
      },
      ok: true,
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** One line of a report: a monitor, or a component, with the monitors that give its figures. */
interface Member {
  readonly component: Component | undefined;
  readonly id: string;
  readonly monitors: readonly Monitor[];
  readonly name: ReportName;
}

/** What a report is about: the subject's own name and the members that give its figures. */
interface Subject {
  readonly id: string;
  readonly members: readonly Member[];
  readonly name: ReportName;
}

/** The members of one monitor, or of a group's monitors. */
function monitorMembers(monitors: readonly Monitor[]): Member[] {
  return monitors.map((monitor) => ({
    component: undefined,
    id: monitor.id,
    monitors: [monitor],
    name: monitor.name,
  }));
}

/** A component as a member, with the monitors linked to it that exist. */
function componentMember(
  component: Component,
  byId: ReadonlyMap<string, Monitor>
): Member {
  return {
    component,
    id: component.id,
    monitors: component.monitorIds.flatMap((id) => byId.get(id) ?? []),
    name: component.name,
  };
}

/** The subject the query names with its members, or nothing for one that does not exist. */
async function subjectOf(
  storage: ReportStorage,
  query: ReportQuery,
  monitors: readonly Monitor[],
  components: readonly Component[]
): Promise<Subject | undefined> {
  const byId = new Map(monitors.map((each) => [each.id, each]));
  const { id, subject: kind } = query;
  switch (kind) {
    case "monitor": {
      const monitor = byId.get(id);
      return (
        monitor && {
          id,
          members: monitorMembers([monitor]),
          name: monitor.name,
        }
      );
    }
    case "group": {
      const inGroup = monitors.filter((each) => each.group === id);
      return inGroup.length === 0
        ? undefined
        : { id, members: monitorMembers(inGroup), name: id };
    }
    case "component": {
      const component = components.find((each) => each.id === id);
      return (
        component && {
          id,
          members: [componentMember(component, byId)],
          name: component.name,
        }
      );
    }
    case "page": {
      const [page, shown] = await Promise.all([
        storage.pages.find(id),
        storage.pages.componentsShown(),
      ]);
      if (!page) {
        return;
      }
      const onPage = new Set(shown.get(id));
      return {
        id,
        members: components
          .filter((each) => onPage.has(each.id))
          .map((each) => componentMember(each, byId)),
        name: page.title,
      };
    }
    default:
      return kind satisfies never;
  }
}

/** What a report keeps of one monitor's read: its days and outages, never the checks they were read from. */
type Kept = Pick<MonitorDays, "degraded" | "history" | "outages">;

/** The monitors' days, read `monitorsPerRead` at a time whatever members name them, and kept without the checks, so what is held at once is eight monitors' checks and the small per-day figures of all. */
async function readKept(
  storage: ReportStorage,
  monitors: readonly Monitor[],
  options: {
    readonly covered: ReadonlyMap<string, readonly Span[]>;
    readonly range: Span;
  }
): Promise<Map<string, Kept>> {
  const kept = new Map<string, Kept>();
  for (let index = 0; index < monitors.length; index += monitorsPerRead) {
    // biome-ignore lint/performance/noAwaitInLoops: one batch's checks are read, summed and dropped before the next, which is what bounds what the report holds
    const read = await readMonitorHistories(
      storage,
      monitors.slice(index, index + monitorsPerRead),
      {
        covered: options.covered,
        from: options.range.from,
        now: options.range.to,
      }
    );
    for (const [id, days] of read) {
      kept.set(id, {
        degraded: days.degraded,
        history: days.history,
        outages: days.outages,
      });
    }
  }
  return kept;
}

/** The records a member's measurement reads, all of them for the whole range. */
interface Records {
  readonly covered: ReadonlyMap<string, readonly Span[]>;
  readonly held: ReadonlyMap<string, readonly OutageSpan[]>;
  readonly incidents: readonly Incident[];
  readonly links: readonly Pick<Component, "id" | "monitorIds">[];
  readonly range: Span;
  readonly underWindows: ReadonlyMap<string, readonly Span[]>;
}

/** Whether the incident began before the range ended; the read already left out the ones resolved before it began. */
function ranIn(incident: Incident, range: Span): boolean {
  return incident.createdAt < range.to;
}

/** The degraded time the monitors' days give: each day's most, since the monitors' time is not told apart. */
function degradedOf(monitors: readonly Kept[], range: Span): number {
  let total = 0;
  for (let at = range.from; at < range.to; at += dayMs) {
    total += Math.max(0, ...monitors.map((each) => each.degraded.get(at) ?? 0));
  }
  return total;
}

/** One member's measurement, from the days its monitors read. */
function measureMember(
  member: Member,
  read: ReadonlyMap<string, Kept>,
  records: Records
): Measured {
  const { range } = records;
  const own = member.monitors.flatMap((each) => read.get(each.id) ?? []);
  const { component } = member;
  const outages = member.monitors.flatMap((monitor) =>
    countedOutages({
      covered: records.covered.get(monitor.id) ?? [],
      observed: read.get(monitor.id)?.history.observed,
      outages: read.get(monitor.id)?.outages ?? [],
      range,
    })
  );
  // A component's own windows and incidents; a monitor's are the windows that covered it.
  const maintenance = component
    ? (records.underWindows.get(component.id) ?? [])
    : (records.covered.get(member.id) ?? []);
  const incidentIds = records.incidents
    .filter((incident) =>
      affectedComponents(incident).some((id) =>
        component
          ? id === component.id
          : records.links.some(
              (link) => link.id === id && link.monitorIds.includes(member.id)
            )
      )
    )
    .map((incident) => incident.id);
  const [first] = member.monitors;
  const days = componentDays({
    createdAt: component?.createdAt ?? first?.createdAt ?? range.from,
    from: range.from,
    incidents: component ? (records.held.get(component.id) ?? []) : [],
    maintenance: component ? maintenance : [],
    monitors: own.map((each) => each.history),
    now: range.to,
  });
  return measure({
    days,
    degradedMs: degradedOf(own, range),
    incidentIds,
    maintenance,
    outages,
    range,
  });
}

/** The places a target is written with, so uptime is shown at least as precisely. */
function targetPlaces(target: number): number {
  const places = String(target).split(".")[1]?.length ?? 0;
  return Math.min(places, targetDecimals);
}

/** A measurement as a line of the report. */
function lineOf(
  id: string,
  name: ReportName,
  measured: Measured,
  range: Span,
  target: number
): ReportLine {
  const figures = figuresOf(measured, range);
  return {
    budget: errorBudget(figures, target),
    figures,
    id,
    name,
    uptime: displayedUptime(figures, Math.max(2, targetPlaces(target))),
  };
}

/**
 * What the report adds up. A group's members are distinct monitors and a
 * component stands alone, so those add up as they are. A page's components
 * may share monitors, which would count a shared monitor's minutes once for
 * each: its total adds up the page's distinct monitors, each once, and the
 * components with none of their own, with the incidents of its components
 * counted once.
 */
function totalOf(
  kind: ReportSubjectKind,
  measured: readonly { member: Member; measured: Measured }[],
  monitors: ReadonlyMap<string, Monitor>,
  kept: ReadonlyMap<string, Kept>,
  records: Records
): Measured {
  if (kind !== "page") {
    return combine(measured.map((each) => each.measured));
  }
  const own = monitorMembers([...monitors.values()]).map((member) =>
    measureMember(member, kept, records)
  );
  const bare = measured.filter((each) => each.member.monitors.length === 0);
  const { incidentIds } = combine(measured.map((each) => each.measured));
  return {
    ...combine([...own, ...bare.map((each) => each.measured)]),
    incidentIds,
  };
}

/** Where the report reads wait their turn. */
let turn: Promise<unknown> = Promise.resolve();

/**
 * The report the query asks for at `now`, or why there is none: an invalid
 * range or target, an unknown subject, a record this version cannot read, or
 * a failed read. One read at a time: two quarters of many monitors reaching
 * today at once would hold their checks together, and an admin asking twice
 * waits a third of a second.
 */
export function readReport(
  storage: ReportStorage,
  query: ReportQuery,
  now: number
): Promise<ReportResult> {
  const result = turn.then(() => readNow(storage, query, now));
  turn = result;
  return result;
}

async function readNow(
  storage: ReportStorage,
  query: ReportQuery,
  now: number
): Promise<ReportResult> {
  const period = reportPeriod(query.from, query.to, now);
  if (
    !period ||
    query.target < uptimeTargetMin ||
    query.target > uptimeTargetMax
  ) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const range = { from: period.fromMs, to: period.toMs };
    const [monitors, components] = await Promise.all([
      storage.monitors.list(),
      storage.components.list(),
    ]);
    const subject = await subjectOf(storage, query, monitors, components);
    if (!subject) {
      return { ok: false, reason: "not_found" };
    }
    const [windows, incidents] = await Promise.all([
      storage.maintenance.since(range.from),
      storage.incidents.activeSince(range.from),
    ]);
    const records: Records = {
      covered: coveredSpans(windows, components, range.to),
      held: incidentDowntime(incidents),
      incidents: incidents.filter((each) => ranIn(each, range)),
      links: components,
      range,
      underWindows: maintenanceSpans(windows, range.to),
    };
    const needed = new Map(
      subject.members
        .flatMap((each) => each.monitors)
        .map((each) => [each.id, each])
    );
    const kept = await readKept(storage, [...needed.values()], {
      covered: records.covered,
      range,
    });
    const measured = subject.members.map((member) => ({
      member,
      measured: measureMember(member, kept, records),
    }));
    const names = new Map(monitors.map((each) => [each.id, each.name]));
    const total = totalOf(query.subject, measured, needed, kept, records);
    const named = (outage: CountedOutage) => ({
      ...outage,
      monitorName: names.get(outage.monitorId) ?? outage.monitorId,
    });
    // A monitor or a component is its own one line.
    const alone = query.subject === "monitor" || query.subject === "component";
    const kind: ReportSubjectKind = query.subject;
    return {
      ok: true,
      report: {
        from: period.from,
        madeAt: now,
        members: alone
          ? []
          : measured
              .map((each) =>
                lineOf(
                  each.member.id,
                  each.member.name,
                  each.measured,
                  range,
                  query.target
                )
              )
              .toSorted((a, b) => b.figures.downtimeMs - a.figures.downtimeMs),
        open: period.open,
        subject: {
          ...lineOf(subject.id, subject.name, total, range, query.target),
          kind,
        },
        target: query.target,
        to: period.to,
        worst: worstOutages(total.outages, worstOutagesShown).map(named),
      },
    };
  } catch (error) {
    const id = corruptRecord(error);
    return id === undefined
      ? { ok: false, reason: "unavailable" }
      : { id, ok: false, reason: "corrupt" };
  }
}

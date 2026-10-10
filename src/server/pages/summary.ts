/**
 * The Statuspage-compatible summary of one status page: its components in its order with their groups, its open
 * incidents and its windows scheduled or in progress, each only as far as
 * the page's components reach, and the indicator. Machine output: nothing
 * in it is localized. Reads never throw.
 */

import { readClock } from "@/server/settings/clock.ts";
import { summaryIndicator } from "@/server/status/status.ts";
import {
  affectedComponents,
  incidentStage,
} from "@/shared/domain/incidents.ts";
import { worstStatus } from "@/shared/domain/status.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { Component } from "@/shared/schemas/component.ts";
import { type Content, contentIn } from "@/shared/schemas/content.ts";
import type { Incident } from "@/shared/schemas/incident.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import {
  type PagePaths,
  plainUrl,
  viewPath,
} from "@/shared/schemas/overview.ts";
import { componentsOf, type StatusPage } from "@/shared/schemas/page.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import type {
  SubscriberIncident,
  SubscriberMaintenance,
} from "@/shared/schemas/subscription.ts";
import type {
  Indicator,
  SummaryComponent,
  SummaryDocument,
} from "@/shared/schemas/summary.ts";
import { readComponentStatuses } from "./components.ts";
import type { OverviewStorage } from "./overview.ts";
import type { ViewResult } from "./views.ts";

export type SummaryStorage = OverviewStorage;

const iso = (ms: number) => new Date(ms).toISOString();

/** The status a window in progress holds each of its components at. */
const maintenanceStatus: StatusLevel = "under_maintenance";

/** Statuspage's own sentence for each indicator, so an aggregator shows what it shows for a Statuspage page. */
const descriptions: Readonly<Record<Indicator, string>> = {
  critical: "Major System Outage",
  maintenance: "Service Under Maintenance",
  major: "Partial System Outage",
  minor: "Minor Service Outage",
  none: "All Systems Operational",
};

/** The page's components as Statuspage lists them: each top-level entry in order, a group followed by its members. */
function componentList(
  page: StatusPage,
  layout: Awaited<ReturnType<OverviewStorage["pages"]["layout"]>>,
  byId: ReadonlyMap<string, Component>,
  statusOf: (id: string) => StatusLevel,
  text: (content: Content) => string
): SummaryComponent[] {
  const entry = (
    component: Component,
    place: number,
    groupId: string | null
  ): SummaryComponent => ({
    created_at: iso(component.createdAt),
    description: component.description ? text(component.description) : null,
    group: false,
    group_id: groupId,
    id: component.id,
    name: text(component.name),
    only_show_if_degraded: false,
    page_id: page.id,
    position: place,
    showcase: true,
    start_date: null,
    status: statusOf(component.id),
    updated_at: iso(component.updatedAt),
  });
  const list: SummaryComponent[] = [];
  let position = 0;
  let groups = 0;
  for (const item of layout) {
    if (item.kind === "component") {
      const component = byId.get(item.componentId);
      if (component) {
        position += 1;
        list.push(entry(component, position, null));
      }
      continue;
    }
    const members = item.componentIds.flatMap((id) => byId.get(id) ?? []);
    // A group whose components are all gone shows nothing, as on the overview.
    if (members.length === 0) {
      continue;
    }
    position += 1;
    groups += 1;
    // A group has no id of its own that outlives a save; this one lasts while the page keeps its groups' order.
    const groupId = Bun.randomUUIDv5(`group ${groups}`, page.id);
    list.push({
      components: members.map((member) => member.id),
      created_at: iso(page.createdAt),
      description: null,
      group: true,
      group_id: null,
      id: groupId,
      name: text(item.name),
      only_show_if_degraded: false,
      page_id: page.id,
      position,
      showcase: false,
      start_date: null,
      status: worstStatus(members.map((member) => statusOf(member.id))),
      updated_at: iso(page.updatedAt),
    });
    for (const [at, member] of members.entries()) {
      list.push(entry(member, at + 1, groupId));
    }
  }
  return list;
}

/** One open incident: its updates newest first, each with what it set on the page's components, and the status each held before. */
function incidentOf(
  incident: Incident,
  components: readonly SummaryComponent[],
  pageId: string,
  shortlink: string,
  text: (content: Content) => string
): SummaryDocument["incidents"][number] {
  const names = new Map(components.map((each) => [each.id, each.name]));
  const held = new Map<string, StatusLevel>();
  const updates = incident.updates.map((update) => {
    const affected = update.statuses.flatMap((each) => {
      const { componentId, status } = each;
      const name = names.get(componentId);
      // Before its first update, the status kept beside it; an update kept without one says operational, as before Raaqeb kept it.
      const before = held.get(componentId) ?? each.before ?? "operational";
      held.set(componentId, status);
      return name === undefined
        ? []
        : [{ code: componentId, name, new_status: status, old_status: before }];
    });
    const at = iso(update.createdAt);
    return {
      affected_components: affected,
      body: text(update.message),
      created_at: at,
      custom_tweet: null,
      deliver_notifications: true,
      display_at: at,
      id: update.id,
      incident_id: incident.id,
      status: update.stage,
      tweet_id: null,
      updated_at: at,
    };
  });
  const monitoring = incident.updates.find(
    (update) => update.stage === "monitoring"
  );
  const stage = incidentStage(incident);
  return {
    components: [...components],
    created_at: iso(incident.createdAt),
    id: incident.id,
    impact: incident.impact,
    incident_updates: updates.toReversed(),
    monitoring_at: monitoring ? iso(monitoring.createdAt) : null,
    name: text(incident.title),
    page_id: pageId,
    reminder_intervals: null,
    resolved_at: null,
    shortlink,
    started_at: iso(incident.createdAt),
    // An open incident's latest update is never the resolving one.
    status: stage === "resolved" ? "monitoring" : stage,
    updated_at: iso(incident.updatedAt),
  };
}

/** One window scheduled or in progress; a window has no updates. */
function windowOf(
  window: MaintenanceWindow,
  stage: "in_progress" | "scheduled",
  components: readonly SummaryComponent[],
  pageId: string,
  shortlink: string,
  text: (content: Content) => string
): SummaryDocument["scheduled_maintenances"][number] {
  return {
    components: [...components],
    created_at: iso(window.createdAt),
    id: window.id,
    impact: "maintenance",
    incident_updates: [],
    monitoring_at: null,
    name: text(window.title),
    page_id: pageId,
    resolved_at: null,
    scheduled_for: iso(window.startsAt),
    scheduled_until: iso(window.endsAt),
    shortlink,
    started_at: iso(window.createdAt),
    status: stage,
    updated_at: iso(window.updatedAt),
  };
}

/** What the summary and a subscriber's event read of one page: its components as Statuspage lists them, its open incidents and unfinished windows as far as they reach it, its indicator and its addresses. */
async function pageParts(
  storage: SummaryStorage,
  pageId: string,
  paths: PagePaths,
  locale?: Locale
) {
  const page = await storage.pages.find(pageId);
  if (!page) {
    return;
  }
  const [layout, { components, statuses }, incidents, windows, time] =
    await Promise.all([
      storage.pages.layout(pageId),
      readComponentStatuses(storage),
      storage.incidents.open(),
      storage.maintenance.unfinished(),
      readClock(storage),
    ]);
  const byId = new Map(components.map((each) => [each.id, each]));
  const statusOf = (id: string): StatusLevel =>
    statuses.get(id) ?? byId.get(id)?.status ?? "operational";
  // The locale asked for, else the page language: each piece of content in it, else the page language's, and every address its view's.
  const shownIn = locale ?? page.locale;
  const text = (content: Content) => contentIn(content, shownIn, page.locale);
  const list = componentList(page, layout, byId, statusOf, text);
  const leaves = list.filter((each) => !each.group);
  const touching = (ids: readonly string[]) =>
    leaves.filter((each) => ids.includes(each.id));
  const address = (suffix: string) => {
    const path = viewPath(paths, shownIn, suffix);
    return paths.origin ? `${paths.origin}${path}` : path;
  };
  const url = plainUrl(paths, shownIn);
  const open = incidents
    .map((incident) => ({
      components: touching(affectedComponents(incident)),
      incident,
    }))
    .filter(({ components: affected }) => affected.length > 0)
    .toSorted((a, b) => b.incident.createdAt - a.incident.createdAt);
  const level = worstStatus(
    componentsOf(layout).flatMap((id) => (byId.has(id) ? [statusOf(id)] : []))
  );
  const indicator = summaryIndicator(
    level,
    open.map(({ incident }) => incident.impact)
  );
  return {
    address,
    byId,
    indicator,
    list,
    open,
    page,
    text,
    time,
    touching,
    url,
    windows,
  };
}

/** The summary of the page with that id, its addresses hanging from `paths`. */
export async function readSummary(
  storage: SummaryStorage,
  pageId: string,
  paths: PagePaths
): Promise<ViewResult<SummaryDocument>> {
  try {
    const parts = await pageParts(storage, pageId, paths);
    if (!parts) {
      return { frame: undefined, ok: false, reason: "not_found" };
    }
    const {
      address,
      byId,
      indicator,
      list,
      open,
      page,
      time,
      text,
      touching,
      url,
      windows,
    } = parts;
    const running = windows
      .filter((window) => window.stage === "in_progress")
      .toSorted((a, b) => a.endsAt - b.endsAt);
    const scheduled = windows
      .filter((window) => window.stage === "scheduled")
      .toSorted((a, b) => a.startsAt - b.startsAt);
    const maintenance = [...running, ...scheduled].flatMap((window) => {
      const affected = touching(window.componentIds);
      if (affected.length === 0) {
        return [];
      }
      const stage =
        window.stage === "in_progress" ? "in_progress" : "scheduled";
      return [
        windowOf(
          window,
          stage,
          affected,
          page.id,
          address(`/maintenance/${encodeURIComponent(window.id)}`),
          text
        ),
      ];
    });
    const changed = Math.max(
      page.updatedAt,
      ...list
        .filter((each) => !each.group)
        .map((each) => byId.get(each.id)?.updatedAt ?? 0),
      ...open.map(({ incident }) => incident.updatedAt),
      ...[...running, ...scheduled]
        .filter((window) => touching(window.componentIds).length > 0)
        .map((window) => window.updatedAt)
    );
    return {
      document: {
        components: list,
        incidents: open.map(({ components: affected, incident }) =>
          incidentOf(
            incident,
            affected,
            page.id,
            address(`/incidents/${encodeURIComponent(incident.id)}`),
            text
          )
        ),
        page: {
          id: page.id,
          name: text(page.title),
          time_zone: time.timeZone,
          updated_at: iso(changed),
          url,
        },
        scheduled_maintenances: maintenance,
        status: { description: descriptions[indicator], indicator },
      },
      ok: true,
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** What an event carries of one page: the page as Statuspage names it with its title and plain address, and the incident or window as far as the page's components reach. */
export interface PageEvent<Subject> {
  readonly incident: Subject;
  readonly page: {
    readonly id: string;
    readonly name: string;
    readonly status_description: string;
    readonly status_indicator: Indicator;
    readonly url: string;
  };
}

/** An incident, open or resolved, as the page's subscribers' webhooks receive it; nothing when the page shows none of its components. */
export async function readIncidentEvent(
  storage: SummaryStorage,
  pageId: string,
  paths: PagePaths,
  incident: Incident,
  locale?: Locale
): Promise<PageEvent<SubscriberIncident> | undefined> {
  const parts = await pageParts(storage, pageId, paths, locale);
  const affected = parts?.touching(affectedComponents(incident)) ?? [];
  if (!parts || affected.length === 0) {
    return;
  }
  const shown = incidentOf(
    incident,
    affected,
    parts.page.id,
    parts.address(`/incidents/${encodeURIComponent(incident.id)}`),
    parts.text
  );
  return {
    incident: {
      ...shown,
      resolved_at:
        incident.resolvedAt === undefined ? null : iso(incident.resolvedAt),
      status: incidentStage(incident),
    },
    page: eventPage(parts),
  };
}

/** What a window's event says beyond the move of its stage: new times, or its cancellation, and when. */
export interface WindowChange {
  readonly at: number;
  readonly kind: "cancelled" | "rescheduled";
}

/** A maintenance window at any stage as the page's subscribers' webhooks receive it; its update at the start and the end lists each of the page's components it moved; nothing when the page shows none of its components. */
export async function readMaintenanceEvent(
  storage: SummaryStorage,
  pageId: string,
  paths: PagePaths,
  window: MaintenanceWindow,
  change?: WindowChange,
  locale?: Locale
): Promise<PageEvent<SubscriberMaintenance> | undefined> {
  const parts = await pageParts(storage, pageId, paths, locale);
  const affected = parts?.touching(window.componentIds) ?? [];
  if (!parts || affected.length === 0) {
    return;
  }
  const shown = windowOf(
    window,
    "scheduled",
    affected,
    parts.page.id,
    // A cancelled window's view went with its row, so its link is the page's plain address.
    change?.kind === "cancelled"
      ? parts.url
      : parts.address(`/maintenance/${encodeURIComponent(window.id)}`),
    parts.text
  );
  // A cancelled window ends as Statuspage ends one, completed; the event's name says it was cancelled.
  const stage = change?.kind === "cancelled" ? "completed" : window.stage;
  // Its start moves each component from the status it holds without the window to under maintenance, its end the way back; its scheduling, new times and cancellation move none.
  const without =
    change || window.stage === "scheduled"
      ? undefined
      : (await readComponentStatuses(storage, window.id)).statuses;
  const changes = without
    ? affected.map(({ id, name }) => {
        const other = without.get(id) ?? "operational";
        return window.stage === "in_progress"
          ? { code: id, name, new_status: maintenanceStatus, old_status: other }
          : {
              code: id,
              name,
              new_status: other,
              old_status: maintenanceStatus,
            };
      })
    : [];
  // The time of the change, else of the window's stage: scheduled when it was written, started at its start, completed at its end.
  const at = iso(
    change?.at ??
      {
        completed: window.endsAt,
        in_progress: window.startsAt,
        scheduled: window.createdAt,
      }[window.stage]
  );
  return {
    incident: {
      ...shown,
      // Statuspage sends a maintenance's text as an update at its stage, and stamps a completed one resolved at its end.
      incident_updates: [
        {
          affected_components: changes,
          body: parts.text(window.message),
          created_at: at,
          custom_tweet: null,
          deliver_notifications: true,
          display_at: at,
          // Each change is an update of its own, so a consumer keyed on update ids sees every reschedule.
          id: Bun.randomUUIDv5(
            change ? `${change.kind} ${change.at}` : window.stage,
            window.id
          ),
          incident_id: window.id,
          status: stage,
          tweet_id: null,
          updated_at: at,
        },
      ],
      resolved_at: stage === "completed" ? at : null,
      status: stage,
    },
    page: eventPage(parts),
  };
}

/** The page as an event names it: Statuspage's id, indicator and sentence, with its title and plain address for the email. */
function eventPage(
  parts: NonNullable<Awaited<ReturnType<typeof pageParts>>>
): PageEvent<unknown>["page"] {
  return {
    id: parts.page.id,
    name: parts.text(parts.page.title),
    status_description: descriptions[parts.indicator],
    status_indicator: parts.indicator,
    url: parts.url,
  };
}

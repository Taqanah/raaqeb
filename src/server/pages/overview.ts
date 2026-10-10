/**
 * The overview's JSON document (ADR-0006): one status page's
 * banner level, its open incidents and its maintenance windows in progress
 * or scheduled, and its components in its order with their status, their
 * bar and their uptime. The route loader calls `readOverview` while the
 * server renders the page, and the document route answers the same value
 * as JSON, so the HTML and the API cannot disagree. Reads never throw.
 */

import { dayView } from "@/server/monitors/days.ts";
import { readClock } from "@/server/settings/clock.ts";
import type { BarDay } from "@/server/status/uptime.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { offeredChannels } from "@/server/subscriptions/subscriptions.ts";
import {
  affectedComponents,
  incidentStage,
} from "@/shared/domain/incidents.ts";
import { worstStatus } from "@/shared/domain/status.ts";
import { displayedUptime } from "@/shared/domain/uptime.ts";
import type {
  Incident,
  IncidentStage,
  OpenStage,
} from "@/shared/schemas/incident.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import type {
  OverviewComponent,
  OverviewDocument,
  OverviewIncident,
  OverviewItem,
  OverviewMaintenance,
} from "@/shared/schemas/overview.ts";
import { componentsOf } from "@/shared/schemas/page.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { readComponentDays, readComponentStatuses } from "./components.ts";
import { pageOf, type ViewResult, viewResponse } from "./views.ts";

export type OverviewStorage = Pick<
  Storage,
  | "channels"
  | "checks"
  | "components"
  | "incidents"
  | "maintenance"
  | "monitors"
  | "outages"
  | "pages"
  | "settings"
>;

export type OverviewResult = ViewResult<OverviewDocument>;

/** A stage an open incident is at; an open incident's latest update is never the resolving one. */
function openStageOf(stage: IncidentStage): OpenStage {
  return stage === "resolved" ? "monitoring" : stage;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The page's open incidents, newest first, each with its latest update and the page's components it affects. */
function incidentCards(
  incidents: readonly Incident[],
  shown: readonly string[]
): OverviewIncident[] {
  return incidents
    .map((incident) => {
      const affected = new Set(affectedComponents(incident));
      return { components: shown.filter((id) => affected.has(id)), incident };
    })
    .filter(({ components }) => components.length > 0)
    .toSorted((a, b) => b.incident.createdAt - a.incident.createdAt)
    .map(({ components, incident }) => {
      const latest = incident.updates.at(-1);
      return {
        components,
        id: incident.id,
        impact: incident.impact,
        stage: openStageOf(incidentStage(incident)),
        title: incident.title,
        update: {
          at: iso(latest?.createdAt ?? incident.createdAt),
          message: latest?.message ?? {},
        },
      };
    });
}

/** The windows touching the page: in progress first, ending soonest, then scheduled, starting soonest. */
function maintenanceCards(
  windows: readonly MaintenanceWindow[],
  shown: readonly string[]
): OverviewMaintenance[] {
  const cards: OverviewMaintenance[] = [];
  const running = windows
    .filter((window) => window.stage === "in_progress")
    .toSorted((a, b) => a.endsAt - b.endsAt);
  const scheduled = windows
    .filter((window) => window.stage === "scheduled")
    .toSorted((a, b) => a.startsAt - b.startsAt);
  for (const window of [...running, ...scheduled]) {
    const components = shown.filter((id) => window.componentIds.includes(id));
    if (components.length === 0) {
      continue;
    }
    cards.push({
      components,
      endsAt: iso(window.endsAt),
      id: window.id,
      message: window.message,
      // Only windows in progress and scheduled ones reach here.
      stage: window.stage === "in_progress" ? "in_progress" : "scheduled",
      startsAt: iso(window.startsAt),
      title: window.title,
    });
  }
  return cards;
}

/** The overview document of the page with that id, as of `now`. */
export async function readOverview(
  storage: OverviewStorage,
  pageId: string,
  now: number
): Promise<OverviewResult> {
  try {
    const page = await storage.pages.find(pageId);
    if (!page) {
      return { frame: undefined, ok: false, reason: "not_found" };
    }
    const { customization } = page;
    const [
      layout,
      images,
      { components, statuses },
      incidents,
      windows,
      channels,
    ] = await Promise.all([
      storage.pages.layout(pageId),
      storage.pages.images(pageId),
      readComponentStatuses(storage),
      storage.incidents.open(),
      storage.maintenance.unfinished(),
      storage.channels.list(),
    ]);
    const byId = new Map(components.map((each) => [each.id, each]));
    // A deleted component has left the layout with its row.
    const shown = componentsOf(layout);
    const figures = customization.bars || customization.percentages;
    const [days, time] = await Promise.all([
      figures
        ? readComponentDays(
            storage,
            shown.flatMap((id) => byId.get(id) ?? []),
            { days: customization.barDays, now }
          )
        : new Map<string, BarDay[]>(),
      readClock(storage),
    ]);
    const statusOf = (id: string): StatusLevel =>
      statuses.get(id) ?? byId.get(id)?.status ?? "operational";
    const entry = (id: string): OverviewComponent | undefined => {
      const component = byId.get(id);
      if (!component) {
        return;
      }
      const own = days.get(id) ?? [];
      return {
        days: customization.bars ? own.map(dayView) : undefined,
        description: component.description,
        id,
        name: component.name,
        status: statusOf(id),
        uptime: customization.percentages
          ? (displayedUptime(totalOf(own)) ?? null)
          : undefined,
      };
    };
    const items: OverviewItem[] = layout.flatMap((item): OverviewItem[] => {
      if (item.kind === "component") {
        const component = entry(item.componentId);
        return component ? [{ component, kind: "component" }] : [];
      }
      const members = item.componentIds.flatMap((id) => entry(id) ?? []);
      // A group whose components are all gone shows nothing, as in the editor.
      if (members.length === 0) {
        return [];
      }
      return [
        {
          components: members,
          kind: "group",
          name: item.name,
          status: worstStatus(members.map((each) => each.status)),
        },
      ];
    });
    return {
      document: {
        calendar: time.calendar,
        clock: time.clock,
        incidents: incidentCards(incidents, shown),
        items,
        level: worstStatus(shown.map(statusOf)),
        maintenance: maintenanceCards(windows, shown),
        page: pageOf(page, images),
        subscribe: offeredChannels(
          page,
          channels.some((channel) => channel.type === "email")
        ),
        timeZone: time.timeZone,
      },
      ok: true,
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** The days' observed time and downtime summed. */
function totalOf(days: readonly BarDay[]): {
  downtimeMs: number;
  observedMs: number;
} {
  let downtimeMs = 0;
  let observedMs = 0;
  for (const day of days) {
    downtimeMs += day.downtimeMs;
    observedMs += day.observedMs;
  }
  return { downtimeMs, observedMs };
}

/** The public answer at `/api/pages/<page id>/overview`: the document with `Cache-Control: public`, 404 for no such page, 503 with no database. */
export async function overviewResponse(
  storage: OverviewStorage | undefined,
  pageId: string,
  now: number
): Promise<Response> {
  return viewResponse(
    storage ? await readOverview(storage, pageId, now) : undefined
  );
}

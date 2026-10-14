import { dayView, readMonitorHistories } from "@/server/monitors/days.ts";
import { inInstallLanguage } from "@/server/settings/language.ts";
import {
  coveredSpans,
  maintenanceSpans,
  underMaintenance,
} from "@/server/status/maintenance.ts";
import {
  componentStatuses,
  incidentStatuses,
  stateAtPause,
} from "@/server/status/status.ts";
import {
  type BarDay,
  type ComponentDay,
  componentDays,
  dayDetails,
  incidentDowntime,
  type NoticeSpan,
} from "@/server/status/uptime.ts";
import { CheckShapeError } from "@/server/storage/checks.ts";
import { ComponentShapeError } from "@/server/storage/components.ts";
import { IncidentShapeError } from "@/server/storage/incidents.ts";
import { MaintenanceShapeError } from "@/server/storage/maintenance.ts";
import { MonitorShapeError } from "@/server/storage/monitors.ts";
import { OutageShapeError } from "@/server/storage/outages.ts";
import { PageShapeError } from "@/server/storage/pages.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  affectedComponents,
  latestStatuses,
} from "@/shared/domain/incidents.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import { displayedUptime } from "@/shared/domain/uptime.ts";
import type { CheckResult } from "@/shared/schemas/check.ts";
import {
  type Component,
  type ComponentDeleteResult,
  type ComponentFields,
  type ComponentFormResult,
  type ComponentInput,
  type ComponentListResult,
  type ComponentSaveResult,
  componentBarDays,
  componentUptimeDays,
} from "@/shared/schemas/component.ts";
import type { Incident } from "@/shared/schemas/incident.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";

export type ComponentStorage = Pick<
  Storage,
  | "bump"
  | "checks"
  | "components"
  | "incidents"
  | "maintenance"
  | "monitors"
  | "outages"
  | "pages"
  | "settings"
>;

const dayMs = 86_400_000;

const unavailable = { ok: false, reason: "unavailable" } as const;
const notFound = { ok: false, reason: "not_found" } as const;
const invalid = { ok: false, reason: "invalid" } as const;

/** The record a shape error names, so the page can name it; nothing for any other failure. */
export function corruptRecord(error: unknown): string | undefined {
  if (error instanceof ComponentShapeError) {
    return error.componentId;
  }
  if (error instanceof PageShapeError) {
    return error.pageId;
  }
  if (error instanceof IncidentShapeError) {
    return error.incidentId;
  }
  if (error instanceof MaintenanceShapeError) {
    return error.windowId;
  }
  if (
    error instanceof MonitorShapeError ||
    error instanceof CheckShapeError ||
    error instanceof OutageShapeError
  ) {
    return error.monitorId;
  }
}

/** A failed read's result: the record this version cannot read, or unavailable. */
function failedRead(
  error: unknown
):
  | { readonly ok: false; readonly reason: "unavailable" }
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string } {
  const id = corruptRecord(error);
  return id === undefined ? unavailable : { id, ok: false, reason: "corrupt" };
}

/** Each monitor's latest check's result, by monitor id; a paused monitor whose checks retention took reads its state from the outage its pause closed. */
async function statesOf(
  storage: Pick<Storage, "checks" | "outages">,
  monitors: readonly Monitor[]
): Promise<Map<string, CheckResult>> {
  const latest = await storage.checks.latest();
  const states = new Map(
    latest.map((check) => [check.monitorId, check.result])
  );
  await Promise.all(
    monitors
      .filter((monitor) => monitor.paused && !states.has(monitor.id))
      .map(async (monitor) => {
        const [newest] = await storage.outages.list(monitor.id);
        const state = stateAtPause(monitor.pausedAt, newest);
        if (state) {
          states.set(monitor.id, state);
        }
      })
  );
  return states;
}

/** Every component and its status now, or as it would be without the maintenance window with the id `withoutWindow`; throws what the storage throws. */
export async function readComponentStatuses(
  storage: Pick<
    Storage,
    | "checks"
    | "components"
    | "incidents"
    | "maintenance"
    | "monitors"
    | "outages"
  >,
  withoutWindow?: string
): Promise<{
  readonly components: Component[];
  readonly statuses: Map<string, StatusLevel>;
}> {
  const [components, monitors, incidents, windows] = await Promise.all([
    storage.components.list(),
    storage.monitors.list(),
    storage.incidents.open(),
    storage.maintenance.unfinished(),
  ]);
  const states = await statesOf(storage, monitors);
  return {
    components,
    statuses: componentStatuses({
      components,
      incidents: incidentStatuses(incidents),
      maintenance: underMaintenance(
        windows.filter((each) => each.id !== withoutWindow)
      ),
      monitors,
      states,
    }),
  };
}

/** The notices of each component by id: the incidents that affect it and the started windows on it. */
function noticesOf(
  incidents: readonly Incident[],
  windows: readonly MaintenanceWindow[]
): Map<string, { incidents: NoticeSpan[]; maintenance: NoticeSpan[] }> {
  const notices = new Map<
    string,
    { incidents: NoticeSpan[]; maintenance: NoticeSpan[] }
  >();
  const of = (id: string) => {
    let each = notices.get(id);
    if (!each) {
      each = { incidents: [], maintenance: [] };
      notices.set(id, each);
    }
    return each;
  };
  for (const incident of incidents) {
    const { createdAt, id, resolvedAt, title } = incident;
    for (const componentId of affectedComponents(incident)) {
      of(componentId).incidents.push({
        endedAt: resolvedAt,
        id,
        startedAt: createdAt,
        title,
      });
    }
  }
  for (const window of windows) {
    const { endsAt, id, startsAt, title } = window;
    for (const componentId of window.componentIds) {
      of(componentId).maintenance.push({
        endedAt: endsAt,
        id,
        startedAt: startsAt,
        title,
      });
    }
  }
  return notices;
}

/** The days of each component over the last `days` UTC days, today included, by component id; throws what the storage throws. */
export async function readComponentDays(
  storage: Pick<
    Storage,
    | "checks"
    | "components"
    | "incidents"
    | "maintenance"
    | "monitors"
    | "outages"
    | "settings"
  >,
  components: readonly Component[],
  options: { readonly days: number; readonly now: number }
): Promise<Map<string, BarDay[]>> {
  const { now } = options;
  const from = utcDayStart(now) - (options.days - 1) * dayMs;
  const linked = new Set(components.flatMap((each) => each.monitorIds));
  const [monitors, incidents, windows, links] = await Promise.all([
    storage.monitors.list(),
    storage.incidents.activeSince(from),
    storage.maintenance.since(from),
    // Every component's links, since a window on one covers its monitors wherever else they are linked.
    storage.components.list(),
  ]);
  const held = incidentDowntime(incidents);
  const underWindows = maintenanceSpans(windows, now);
  const read = await readMonitorHistories(
    storage,
    monitors.filter((monitor) => linked.has(monitor.id)),
    { covered: coveredSpans(windows, links, now), from, now }
  );
  const notices = noticesOf(incidents, windows);
  return new Map(
    components.map((component) => {
      const details = dayDetails({
        from,
        notices: notices.get(component.id) ?? {
          incidents: [],
          maintenance: [],
        },
        now,
        response: component.monitorIds.flatMap(
          (id) => read.get(id)?.response ?? []
        ),
      });
      const days = componentDays({
        createdAt: component.createdAt,
        from,
        incidents: held.get(component.id) ?? [],
        maintenance: underWindows.get(component.id) ?? [],
        monitors: component.monitorIds.flatMap(
          (id) => read.get(id)?.history ?? []
        ),
        now,
      });
      return [
        component.id,
        // The two lay out the same days, so each finds its detail.
        days.flatMap((each, index) => {
          const detail = details[index];
          return detail ? [{ ...each, ...detail }] : [];
        }),
      ];
    })
  );
}

/** The list: every component with its status, its uptime over 90 days and the last 30 of them for its bar, and how many pages show it. */
export async function listComponents(
  storage: ComponentStorage,
  now: number
): Promise<ComponentListResult> {
  try {
    const [{ components, statuses }, shown] = await Promise.all([
      readComponentStatuses(storage),
      storage.pages.componentsShown(),
    ]);
    const days = await readComponentDays(storage, components, {
      days: componentUptimeDays,
      now,
    });
    const pages = new Map<string, number>();
    for (const ids of shown.values()) {
      for (const id of ids) {
        pages.set(id, (pages.get(id) ?? 0) + 1);
      }
    }
    return {
      components: components.map((component) => {
        const own = days.get(component.id) ?? [];
        return {
          component,
          days: own.slice(-componentBarDays).map(dayView),
          pages: pages.get(component.id) ?? 0,
          status: statuses.get(component.id) ?? component.status,
          uptime: displayedUptime(totalOf(own)),
        };
      }),
      ok: true,
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** The days' observed time and downtime summed. */
function totalOf(days: readonly ComponentDay[]): {
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

/** The form's read: the stored component with its status, the pages showing it and what deleting it deletes, or the new form's with no id; the monitors it may link either way. */
export async function readComponentForm(
  storage: ComponentStorage,
  id: string | undefined
): Promise<ComponentFormResult> {
  try {
    const monitors = await storage.monitors.list();
    const states = await statesOf(storage, monitors);
    const linkable = monitors.map((monitor) => ({
      id: monitor.id,
      name: monitor.name,
      paused: monitor.paused,
      state: states.get(monitor.id),
      target: monitor.target,
    }));
    if (id === undefined) {
      return {
        form: {
          component: undefined,
          deletedWith: { incidents: [], maintenance: [] },
          incidents: [],
          maintenance: [],
          monitors: linkable,
          pages: [],
          status: undefined,
        },
        ok: true,
      };
    }
    const component = await storage.components.find(id);
    if (!component) {
      return notFound;
    }
    const [pages, shown, incidents, windows] = await Promise.all([
      storage.pages.list(),
      storage.pages.componentsShown(),
      storage.incidents.list(),
      storage.maintenance.list(),
    ]);
    const setting = incidents.filter(
      (incident) =>
        incident.resolvedAt === undefined &&
        latestStatuses(incident).some((each) => each.componentId === id)
    );
    const holding = windows.filter(
      (window) =>
        window.stage === "in_progress" && window.componentIds.includes(id)
    );
    // The same rule the repository deletes by: no other component named.
    const onlyThis = (componentIds: readonly string[]) =>
      componentIds.every((each) => each === id);
    return {
      form: {
        component,
        deletedWith: {
          incidents: incidents
            .filter((incident) => onlyThis(affectedComponents(incident)))
            .map((incident) => ({ id: incident.id, title: incident.title })),
          maintenance: windows
            .filter((window) => onlyThis(window.componentIds))
            .map((window) => ({ id: window.id, title: window.title })),
        },
        incidents: setting.map((incident) => ({
          id: incident.id,
          title: incident.title,
        })),
        maintenance: holding.map((window) => ({
          id: window.id,
          title: window.title,
        })),
        monitors: linkable,
        pages: pages
          .filter((page) => shown.get(page.id)?.includes(id))
          .map((page) => ({ id: page.id, title: page.title })),
        status: componentStatuses({
          components: [component],
          incidents: incidentStatuses(setting),
          maintenance: underMaintenance(holding),
          monitors,
          states,
        }).get(id),
      },
      ok: true,
    };
  } catch (error) {
    return failedRead(error);
  }
}

function fieldsOf(input: ComponentInput): ComponentFields {
  return {
    description: input.description,
    monitorIds: input.monitorIds,
    name: input.name,
    status: input.status,
  };
}

export async function createComponent(
  storage: ComponentStorage,
  input: ComponentInput
): Promise<ComponentSaveResult> {
  try {
    if (!(await inInstallLanguage(storage, input.name, input.description))) {
      return invalid;
    }
    const component = await storage.components.create(fieldsOf(input));
    await storage.bump();
    return { component, ok: true };
  } catch {
    return unavailable;
  }
}

/** Replaces the component's fields and links. */
export async function editComponent(
  storage: ComponentStorage,
  id: string,
  input: ComponentInput
): Promise<ComponentSaveResult> {
  try {
    if (!(await inInstallLanguage(storage, input.name, input.description))) {
      return invalid;
    }
    const component = await storage.components.update(id, fieldsOf(input));
    if (!component) {
      return notFound;
    }
    await storage.bump();
    return { component, ok: true };
  } catch {
    return unavailable;
  }
}

/** Deletes the component and takes it off every page, with every incident and maintenance window that names no other component. */
export async function deleteComponent(
  storage: ComponentStorage,
  id: string
): Promise<ComponentDeleteResult> {
  try {
    if (!(await storage.components.remove(id))) {
      return notFound;
    }
    await storage.bump();
    return { ok: true };
  } catch {
    return unavailable;
  }
}

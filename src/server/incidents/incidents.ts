/**
 * The incidents module (CONTEXT.md "Incident", "Incident update"): what the admin's server functions call to list, read, create, edit,
 * update, resolve, fix and delete incidents. The update that first names a
 * component keeps the status the page showed for it just before.
 * Resolving ends the incident's hold on every affected component: a
 * component set by hand returns to its own hand-set status, the one it had
 * before, or keeps the status the incident set when the operator asks, as
 * its hand-set status; a linked component follows its monitors again.
 * An update written from a read another update
 * overtook is refused as changed, so two tabs never drop a component
 * between them. Every write moves the change counter, since an
 * incident is public content. Every function answers a result
 * and never throws.
 */

import { type Announce, announceNothing } from "@/server/notify/subscribers.ts";
import {
  corruptRecord,
  readComponentStatuses,
} from "@/server/pages/components.ts";
import { inInstallLanguage } from "@/server/settings/language.ts";
import { NoAffectedComponentError } from "@/server/storage/incidents.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  affectedComponents,
  incidentStage,
  latestStatuses,
} from "@/shared/domain/incidents.ts";
import type { Content } from "@/shared/schemas/content.ts";
import type {
  Incident,
  IncidentComponent,
  IncidentCreateInput,
  IncidentDeleteResult,
  IncidentFields,
  IncidentListItem,
  IncidentListResult,
  IncidentPageResult,
  IncidentSaveResult,
  IncidentStatus,
  IncidentUpdateInput,
  NewIncidentResult,
} from "@/shared/schemas/incident.ts";
import type { HandSetLevel, StatusLevel } from "@/shared/schemas/status.ts";

export type IncidentStorage = Pick<
  Storage,
  | "bump"
  | "checks"
  | "components"
  | "incidents"
  | "maintenance"
  | "monitors"
  | "outages"
  | "settings"
>;

const unavailable = { ok: false, reason: "unavailable" } as const;
const notFound = { ok: false, reason: "not_found" } as const;
const invalid = { ok: false, reason: "invalid" } as const;
const resolved = { ok: false, reason: "resolved" } as const;
const changed = { ok: false, reason: "changed" } as const;

/** A failed read's result: the record this version cannot read, or unavailable. */
function failedRead(
  error: unknown
):
  | { readonly ok: false; readonly reason: "unavailable" }
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string } {
  const id = corruptRecord(error);
  return id === undefined ? unavailable : { id, ok: false, reason: "corrupt" };
}

/** Every component with its status now and whether monitors drive it, in creation order; throws what the storage throws. */
async function componentsNow(storage: IncidentStorage): Promise<
  {
    readonly monitorIds: readonly string[];
    readonly offered: IncidentComponent;
  }[]
> {
  const { components, statuses } = await readComponentStatuses(storage);
  return components.map((component) => ({
    monitorIds: component.monitorIds,
    offered: {
      id: component.id,
      linked: component.monitorIds.length > 0,
      name: component.name,
      status: statuses.get(component.id) ?? component.status,
    },
  }));
}

/** A status as an incident may set it: under maintenance is a window's alone, so it offers operational. */
function settable(level: StatusLevel): HandSetLevel {
  return level === "under_maintenance" ? "operational" : level;
}

/** The list: open incidents first, then resolved ones, each newest first, with their affected components' names. */
export async function listIncidents(
  storage: IncidentStorage,
  now: number
): Promise<IncidentListResult> {
  try {
    const [incidents, components] = await Promise.all([
      storage.incidents.list(),
      storage.components.list(),
    ]);
    const names = new Map(components.map((each) => [each.id, each.name]));
    const items = incidents.map(
      (incident): IncidentListItem => ({
        components: affectedComponents(incident).flatMap((id) => {
          const name = names.get(id);
          return name === undefined ? [] : [{ id, name }];
        }),
        createdAt: incident.createdAt,
        id: incident.id,
        impact: incident.impact,
        resolvedAt: incident.resolvedAt,
        stage: incidentStage(incident),
        title: incident.title,
      })
    );
    const closed = (item: IncidentListItem) =>
      item.resolvedAt === undefined ? 0 : 1;
    return {
      list: {
        anyComponent: components.length > 0,
        incidents: items.toSorted(
          (a, b) => closed(a) - closed(b) || b.createdAt - a.createdAt
        ),
        now,
      },
      ok: true,
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** The new-incident page's read: every component with its status now, and from a monitor's "open incident" link its name and the components linked to it. */
export async function readNewIncident(
  storage: IncidentStorage,
  monitorId: string | undefined
): Promise<NewIncidentResult> {
  try {
    const components = await componentsNow(storage);
    const monitor =
      monitorId === undefined
        ? undefined
        : await storage.monitors.find(monitorId);
    return {
      form: {
        components: components.map((each) => each.offered),
        prefill: monitor && {
          statuses: components
            .filter((each) => each.monitorIds.includes(monitor.id))
            .map((each) => ({
              componentId: each.offered.id,
              status: settable(each.offered.status),
            })),
          title: monitor.name,
        },
      },
      ok: true,
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** An incident's page: the incident with its updates and every component with its status now. */
export async function readIncident(
  storage: IncidentStorage,
  id: string,
  now: number
): Promise<IncidentPageResult> {
  try {
    const incident = await storage.incidents.find(id);
    if (!incident) {
      return notFound;
    }
    const components = await componentsNow(storage);
    return {
      ok: true,
      page: {
        components: components.map((each) => each.offered),
        incident,
        now,
      },
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** The ids of the components that exist. */
async function existing(storage: IncidentStorage): Promise<Set<string>> {
  return new Set((await storage.components.list()).map((each) => each.id));
}

/** Opens an incident with its first update, written by `author`; one that names no component that exists is refused as invalid. Its subscribers hear "incident published" through `announce`. */
export async function createIncident(
  storage: IncidentStorage,
  input: IncidentCreateInput,
  author: string,
  announce: Announce = announceNothing
): Promise<IncidentSaveResult> {
  try {
    if (!(await inInstallLanguage(storage, input.title, input.message))) {
      return invalid;
    }
    const incident = await storage.incidents.create(
      { impact: input.impact, title: input.title },
      {
        author,
        before: await statusesShown(storage),
        message: input.message,
        stage: input.stage,
        statuses: input.statuses,
      }
    );
    await storage.bump();
    await announce({ incidentId: incident.id, type: "incident.published" });
    return { incident, ok: true };
  } catch (error) {
    return error instanceof NoAffectedComponentError ? invalid : unavailable;
  }
}

/** Replaces the title and the impact level, open or resolved. */
export async function editIncident(
  storage: IncidentStorage,
  id: string,
  fields: IncidentFields
): Promise<IncidentSaveResult> {
  try {
    if (!(await inInstallLanguage(storage, fields.title))) {
      return invalid;
    }
    const incident = await storage.incidents.edit(id, fields);
    if (!incident) {
      return notFound;
    }
    await storage.bump();
    return { incident, ok: true };
  } catch {
    return unavailable;
  }
}

/** Each component's status as the page shows it now, before the write that names it: what the incident keeps as its status before. */
async function statusesShown(
  storage: IncidentStorage
): Promise<Map<string, StatusLevel>> {
  const { components, statuses } = await readComponentStatuses(storage);
  return new Map(
    components.map((each) => [each.id, statuses.get(each.id) ?? each.status])
  );
}

/** What an update writes: its statuses, the status before of each component it adds, and the hand-set statuses a resolving one leaves; nothing when it drops a component the incident affects. */
async function writing(
  storage: IncidentStorage,
  incident: Incident,
  input: IncidentUpdateInput
): Promise<
  | {
      readonly before: ReadonlyMap<string, StatusLevel>;
      readonly handSet: readonly IncidentStatus[];
      readonly statuses: readonly IncidentStatus[];
    }
  | undefined
> {
  const current = latestStatuses(incident);
  if (input.stage === "resolved") {
    // Only a component set by hand gets a status back, the one it had before the incident unless kept: the incident never wrote it. A linked one follows its monitors, so nothing is recorded for it.
    const byHand = new Map(
      (await storage.components.list())
        .filter((each) => each.monitorIds.length === 0)
        .map((each) => [each.id, each.status])
    );
    const statuses = current.flatMap(({ componentId, status }) => {
      const own = byHand.get(componentId);
      return own === undefined
        ? []
        : [{ componentId, status: input.keep ? status : own }];
    });
    return { before: new Map(), handSet: statuses, statuses };
  }
  const named = new Set(input.statuses.map((each) => each.componentId));
  if (current.some((each) => !named.has(each.componentId))) {
    return;
  }
  const known = await existing(storage);
  const statuses = input.statuses.filter((each) => known.has(each.componentId));
  if (statuses.length === 0) {
    return;
  }
  const affected = new Set(affectedComponents(incident));
  const added = statuses.some((each) => !affected.has(each.componentId));
  const shown = added ? await statusesShown(storage) : new Map();
  const before = new Map([...shown].filter(([id]) => !affected.has(id)));
  return { before, handSet: [], statuses };
}

/** Adds an update written by `author` to an open incident; the resolving one resolves it. An update names every component the incident affects and may add one. Its subscribers hear "incident updated" through `announce`. */
export async function postUpdate(
  storage: IncidentStorage,
  id: string,
  input: IncidentUpdateInput,
  author: string,
  announce: Announce = announceNothing
): Promise<IncidentSaveResult> {
  try {
    const incident = await storage.incidents.find(id);
    if (!incident) {
      return notFound;
    }
    if (incident.resolvedAt !== undefined) {
      return resolved;
    }
    if (!(await inInstallLanguage(storage, input.message))) {
      return invalid;
    }
    const write = await writing(storage, incident, input);
    if (!write) {
      return invalid;
    }
    const posted = await storage.incidents.post(
      id,
      {
        author,
        before: write.before,
        message: input.message,
        stage: input.stage,
        statuses: write.statuses,
      },
      write.handSet,
      incident.updates.at(-1)?.id ?? ""
    );
    if (!posted) {
      // Deleted, resolved, or another update landed since it was read.
      const now = await storage.incidents.find(id);
      if (!now) {
        return notFound;
      }
      return now.resolvedAt === undefined ? changed : resolved;
    }
    await storage.bump();
    await announce({ incidentId: id, type: "incident.updated" });
    return { incident: posted, ok: true };
  } catch {
    return unavailable;
  }
}

/** Replaces one update's text, open or resolved; its time, stage and statuses stay. */
export async function fixUpdate(
  storage: IncidentStorage,
  id: string,
  updateId: string,
  message: Content
): Promise<IncidentSaveResult> {
  try {
    if (!(await inInstallLanguage(storage, message))) {
      return invalid;
    }
    const incident = await storage.incidents.fix(id, updateId, message);
    if (!incident) {
      return notFound;
    }
    await storage.bump();
    return { incident, ok: true };
  } catch {
    return unavailable;
  }
}

/** Deletes the incident with its updates. */
export async function deleteIncident(
  storage: IncidentStorage,
  id: string
): Promise<IncidentDeleteResult> {
  try {
    if (!(await storage.incidents.remove(id))) {
      return notFound;
    }
    await storage.bump();
    return { ok: true };
  } catch {
    return unavailable;
  }
}

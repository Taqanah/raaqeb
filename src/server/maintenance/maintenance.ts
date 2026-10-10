/**
 * The maintenance module (CONTEXT.md "Maintenance window"): what
 * the admin's server functions call to list, read, schedule, edit, end and
 * cancel maintenance windows. What may change follows the stage the
 * scheduler moved the window to: everything while scheduled; the title,
 * the message and the end while in progress, where "end now" sets the end
 * to now and the scheduler completes it at its next tick; the title and
 * the message once completed. Only a scheduled window may be cancelled,
 * which deletes it. Scheduling, an edit that moves
 * the start or the end, and a cancel are subscriber events. A save
 * written from a read the scheduler overtook is refused as changed. Every
 * write moves the change
 * counter, since a window is public content. Every function
 * answers a result and never throws.
 */

import { type Announce, announceNothing } from "@/server/notify/subscribers.ts";
import {
  corruptRecord,
  readComponentStatuses,
} from "@/server/pages/components.ts";
import { inInstallLanguage } from "@/server/settings/language.ts";
import {
  NoWindowComponentError,
  type WindowEdit,
} from "@/server/storage/maintenance.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { runningEnd, windowTimes } from "@/shared/domain/maintenance.ts";
import type {
  MaintenanceComponent,
  MaintenanceDeleteResult,
  MaintenanceEditInput,
  MaintenanceInput,
  MaintenanceListItem,
  MaintenanceListResult,
  MaintenancePageResult,
  MaintenanceSaveResult,
  MaintenanceStage,
  MaintenanceWindow,
  NewMaintenanceResult,
} from "@/shared/schemas/maintenance.ts";

export type MaintenanceStorage = Pick<
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

/** Every component with its status now, in creation order; throws what the storage throws. */
async function componentsNow(
  storage: MaintenanceStorage
): Promise<MaintenanceComponent[]> {
  const { components, statuses } = await readComponentStatuses(storage);
  return components.map((component) => ({
    id: component.id,
    name: component.name,
    status: statuses.get(component.id) ?? component.status,
  }));
}

/** Where a window sits on the list: in progress, then scheduled, then completed. */
const stageOrder: Readonly<Record<MaintenanceStage, number>> = {
  completed: 2,
  in_progress: 0,
  scheduled: 1,
};

/** Within its stage: in progress ending soonest first, scheduled starting soonest first, completed newest first. */
function byStage(a: MaintenanceListItem, b: MaintenanceListItem): number {
  if (a.stage !== b.stage) {
    return stageOrder[a.stage] - stageOrder[b.stage];
  }
  if (a.stage === "in_progress") {
    return a.endsAt - b.endsAt;
  }
  return a.stage === "scheduled"
    ? a.startsAt - b.startsAt
    : b.endsAt - a.endsAt;
}

/** The list: in progress first, then scheduled ones soonest first, then completed ones newest first, with their affected components' names. */
export async function listWindows(
  storage: MaintenanceStorage,
  now: number
): Promise<MaintenanceListResult> {
  try {
    const [windows, components] = await Promise.all([
      storage.maintenance.list(),
      storage.components.list(),
    ]);
    const names = new Map(components.map((each) => [each.id, each.name]));
    const items = windows.map(
      (window): MaintenanceListItem => ({
        components: window.componentIds.flatMap((id) => {
          const name = names.get(id);
          return name === undefined ? [] : [{ id, name }];
        }),
        endsAt: window.endsAt,
        id: window.id,
        stage: window.stage,
        startsAt: window.startsAt,
        title: window.title,
      })
    );
    return {
      list: {
        anyComponent: components.length > 0,
        now,
        windows: items.toSorted(byStage),
      },
      ok: true,
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** The new-window page's read: every component with its status now. */
export async function readNewWindow(
  storage: MaintenanceStorage,
  now: number
): Promise<NewMaintenanceResult> {
  try {
    return {
      form: { components: await componentsNow(storage), now },
      ok: true,
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** A window's page: the window and every component with its status now. */
export async function readWindow(
  storage: MaintenanceStorage,
  id: string,
  now: number
): Promise<MaintenancePageResult> {
  try {
    const window = await storage.maintenance.find(id);
    if (!window) {
      return notFound;
    }
    return {
      ok: true,
      page: { components: await componentsNow(storage), now, window },
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** Schedules a window; times in the past, an end not after the start, or no component that exists are refused as invalid. Its subscribers hear "maintenance scheduled" through `announce`, unless it starts in the current minute. */
export async function createWindow(
  storage: MaintenanceStorage,
  input: MaintenanceInput,
  now: number,
  announce: Announce = announceNothing
): Promise<MaintenanceSaveResult> {
  const times = windowTimes(input.startsAt, input.endsAt, now);
  if (!times.ok) {
    return invalid;
  }
  try {
    if (!(await inInstallLanguage(storage, input.title, input.message))) {
      return invalid;
    }
    const window = await storage.maintenance.create({
      componentIds: input.componentIds,
      endsAt: times.endsAt,
      message: input.message,
      startsAt: times.startsAt,
      title: input.title,
    });
    await storage.bump();
    // A start in the current minute is stored as now and the maintenance pass announces it started, so "scheduled" would only arrive a second before it.
    if (times.startsAt !== now) {
      await announce({ type: "maintenance.scheduled", windowId: window.id });
    }
    return { ok: true, window };
  } catch (error) {
    return error instanceof NoWindowComponentError ? invalid : unavailable;
  }
}

/** What an edit may write to a window at its stage: everything while scheduled, the text and the end while in progress, the text once completed; a field the stage has locked is refused as changed, since the page read an earlier stage. */
function editOf(
  window: MaintenanceWindow,
  input: MaintenanceEditInput,
  now: number
):
  | { readonly ok: true; readonly edit: WindowEdit }
  | { readonly ok: false; readonly reason: "changed" | "invalid" } {
  const text = { message: input.message, title: input.title };
  const whole = "startsAt" in input;
  const withEnd = "endsAt" in input;
  if (window.stage === "scheduled") {
    if (!whole) {
      return withEnd ? invalid : { edit: text, ok: true };
    }
    const times = windowTimes(input.startsAt, input.endsAt, now);
    return times.ok
      ? {
          edit: {
            ...text,
            componentIds: input.componentIds,
            endsAt: times.endsAt,
            startsAt: times.startsAt,
          },
          ok: true,
        }
      : invalid;
  }
  if (whole || (withEnd && window.stage === "completed")) {
    return changed;
  }
  if (!withEnd) {
    return { edit: text, ok: true };
  }
  const end = runningEnd(input.endsAt, now);
  return end.ok ? { edit: { ...text, endsAt: end.endsAt }, ok: true } : invalid;
}

/** Writes an edit guarded on the stage the window was read at, and moves the counter; a window that moved on meanwhile is changed, one that went is not found. */
async function written(
  storage: MaintenanceStorage,
  window: MaintenanceWindow,
  edit: WindowEdit
): Promise<MaintenanceSaveResult> {
  const edited = await storage.maintenance.edit(window.id, window.stage, edit);
  if (!edited) {
    return (await storage.maintenance.find(window.id)) ? changed : notFound;
  }
  await storage.bump();
  return { ok: true, window: edited };
}

/** Whether an edit moved the window's times for its subscribers: a start or end moved to now is left to the maintenance pass, whose started or completed follows within the minute. */
function rescheduled(
  before: MaintenanceWindow,
  after: MaintenanceWindow,
  now: number
): boolean {
  const moved =
    after.startsAt !== before.startsAt || after.endsAt !== before.endsAt;
  const atOnce =
    after.endsAt === now ||
    (after.stage === "scheduled" && after.startsAt === now);
  return moved && !atOnce;
}

/** Replaces what the window's stage lets change; an edit posted for an earlier stage than the window's is refused as changed. */
export async function editWindow(
  storage: MaintenanceStorage,
  id: string,
  input: MaintenanceEditInput,
  now: number,
  announce: Announce = announceNothing
): Promise<MaintenanceSaveResult> {
  try {
    const window = await storage.maintenance.find(id);
    if (!window) {
      return notFound;
    }
    if (!(await inInstallLanguage(storage, input.title, input.message))) {
      return invalid;
    }
    const edit = editOf(window, input, now);
    if (!edit.ok) {
      return edit;
    }
    const result = await written(storage, window, edit.edit);
    if (result.ok && rescheduled(window, result.window, now)) {
      await announce({ type: "maintenance.rescheduled", windowId: id });
    }
    return result;
  } catch (error) {
    return error instanceof NoWindowComponentError ? invalid : unavailable;
  }
}

/** Sets a window in progress to end now; the scheduler completes it at its next tick. */
export async function endWindow(
  storage: MaintenanceStorage,
  id: string,
  now: number
): Promise<MaintenanceSaveResult> {
  try {
    const window = await storage.maintenance.find(id);
    if (!window) {
      return notFound;
    }
    if (window.stage !== "in_progress") {
      return changed;
    }
    return await written(storage, window, {
      endsAt: Math.min(window.endsAt, now),
      message: window.message,
      title: window.title,
    });
  } catch {
    return unavailable;
  }
}

/** Cancels a scheduled window, deleting it, and its subscribers hear "maintenance cancelled" through `announce`; one that started is refused as changed. */
export async function deleteWindow(
  storage: MaintenanceStorage,
  id: string,
  now: number,
  announce: Announce = announceNothing
): Promise<MaintenanceDeleteResult> {
  try {
    // Read before the delete: the event is built from the window once its row is gone.
    const window = await storage.maintenance.find(id);
    if (window && (await storage.maintenance.remove(id))) {
      await storage.bump();
      await announce({ at: now, type: "maintenance.cancelled", window });
      return { ok: true };
    }
    return (await storage.maintenance.find(id)) ? changed : notFound;
  } catch {
    return unavailable;
  }
}

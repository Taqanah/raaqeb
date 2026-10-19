/**
 * The maintenance series module (CONTEXT.md "Maintenance series",
 * "Occurrence"): what the admin's server functions call to read, create,
 * edit and end a series. A series schedules each occurrence a week before it
 * starts (the scheduler's maintenance pass does from then on) and at once on
 * a create or an edit, as an ordinary window its subscribers hear of as
 * scheduled. An edit replaces the scheduled occurrences with the new
 * recurrence's: one at the same start is kept, rescheduled when its end
 * moved; the others are cancelled and the new ones scheduled, but for one
 * cancelled on its own, which stays cancelled. Ending a series
 * cancels its scheduled occurrences. Every write moves the change counter.
 * Every function answers a result and never throws.
 */

import { type Announce, announceNothing } from "@/server/notify/subscribers.ts";
import { inInstallLanguage } from "@/server/settings/language.ts";
import {
  NoWindowComponentError,
  type SeriesWrite,
} from "@/server/storage/maintenance.ts";
import {
  nextOccurrenceStart,
  occurrencesBetween,
  scheduledUntilAt,
} from "@/shared/domain/series.ts";
import type {
  MaintenanceDeleteResult,
  MaintenanceSeriesPageResult,
  MaintenanceSeriesSaveResult,
  SeriesInput,
} from "@/shared/schemas/maintenance.ts";
import {
  componentsNow,
  failedRead,
  listItemOf,
  type MaintenanceStorage,
} from "./maintenance.ts";

const unavailable = { ok: false, reason: "unavailable" } as const;
const notFound = { ok: false, reason: "not_found" } as const;
const invalid = { ok: false, reason: "invalid" } as const;

/** A series' page: the series, its occurrences in progress and scheduled, when the next one it has yet to schedule starts, and every component with its status now. */
export async function readSeries(
  storage: MaintenanceStorage,
  id: string,
  now: number
): Promise<MaintenanceSeriesPageResult> {
  try {
    const series = await storage.maintenance.findSeries(id);
    if (!series) {
      return notFound;
    }
    const [windows, components] = await Promise.all([
      storage.maintenance.unfinished(),
      componentsNow(storage),
    ]);
    const names = new Map(components.map((each) => [each.id, each.name]));
    return {
      ok: true,
      page: {
        components,
        next: nextOccurrenceStart(series.recurrence, series.scheduledUntil),
        now,
        occurrences: windows
          .filter((window) => window.seriesId === id)
          .map((window) => listItemOf(window, names))
          .toSorted((a, b) => a.startsAt - b.startsAt),
        series,
      },
    };
  } catch (error) {
    return failedRead(error);
  }
}

/** Moves the counter and tells subscribers what a series write did: the cancelled, the rescheduled, then the scheduled occurrences. */
async function announced(
  storage: MaintenanceStorage,
  write: SeriesWrite,
  now: number,
  announce: Announce
): Promise<MaintenanceSeriesSaveResult> {
  await storage.bump();
  for (const window of write.cancelled) {
    // biome-ignore lint/performance/noAwaitInLoops: each event queues in order
    await announce({ at: now, type: "maintenance.cancelled", window });
  }
  for (const window of write.rescheduled) {
    // biome-ignore lint/performance/noAwaitInLoops: each event queues in order
    await announce({ type: "maintenance.rescheduled", windowId: window.id });
  }
  for (const window of write.scheduled) {
    // biome-ignore lint/performance/noAwaitInLoops: each event queues in order
    await announce({ type: "maintenance.scheduled", windowId: window.id });
  }
  return { ok: true, series: write.series };
}

/** Creates a series and schedules its occurrences of the coming week; no component that exists, or text without the install language's, is refused as invalid. */
export async function createSeries(
  storage: MaintenanceStorage,
  input: SeriesInput,
  now: number,
  announce: Announce = announceNothing
): Promise<MaintenanceSeriesSaveResult> {
  try {
    if (!(await inInstallLanguage(storage, input.title, input.message))) {
      return invalid;
    }
    const until = scheduledUntilAt(now);
    const write = await storage.maintenance.createSeries(
      input,
      occurrencesBetween(input.recurrence, now, until),
      until
    );
    return await announced(storage, write, now, announce);
  } catch (error) {
    return error instanceof NoWindowComponentError ? invalid : unavailable;
  }
}

/** Replaces every field of a series and its scheduled occurrences with the new recurrence's of the coming week. */
export async function editSeries(
  storage: MaintenanceStorage,
  id: string,
  input: SeriesInput,
  now: number,
  announce: Announce = announceNothing
): Promise<MaintenanceSeriesSaveResult> {
  try {
    if (!(await inInstallLanguage(storage, input.title, input.message))) {
      return invalid;
    }
    const until = scheduledUntilAt(now);
    const write = await storage.maintenance.editSeries(
      id,
      input,
      occurrencesBetween(input.recurrence, now, until),
      now,
      until
    );
    return write ? await announced(storage, write, now, announce) : notFound;
  } catch (error) {
    return error instanceof NoWindowComponentError ? invalid : unavailable;
  }
}

/** Ends a series: its scheduled occurrences are cancelled, one in progress runs to its end. */
export async function endSeries(
  storage: MaintenanceStorage,
  id: string,
  now: number,
  announce: Announce = announceNothing
): Promise<MaintenanceDeleteResult> {
  try {
    const cancelled = await storage.maintenance.endSeries(id);
    if (!cancelled) {
      return notFound;
    }
    await storage.bump();
    for (const window of cancelled) {
      // biome-ignore lint/performance/noAwaitInLoops: each event queues in order
      await announce({ at: now, type: "maintenance.cancelled", window });
    }
    return { ok: true };
  } catch {
    return unavailable;
  }
}

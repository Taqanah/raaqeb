/**
 * The size guard (CONTEXT.md "Size budget", ADR-0005): before a check's row is written, the used size is held
 * under the size budget and, on SQLite, the free disk over the 64 MB
 * reserve, by deleting the oldest history first, one UTC day of one tier
 * across every monitor at a time: raw days, then hourly rollups, then daily
 * rollups. Each round gives the space back and moves the change counter.
 * It measures at most every ten seconds, since a round of checks writes far
 * less than the reserve. A budget round that frees nothing measurable ends
 * the deletes: Postgres keeps freed space inside its files, so the budget
 * waits until the used size grows past where that round left it. The
 * reserve goes on to the last day; with nothing more to delete the row is
 * refused, so the disk keeps room for the database to recover, and the
 * check's outage and events still run.
 */

import { error as logError, info as logInfo, reasonOf } from "@/server/log.ts";
import { readSizeBudgetBytes } from "@/server/settings/retention.ts";
import type { ChecksRepository } from "@/server/storage/checks.ts";
import type { SettingsRepository } from "@/server/storage/settings.ts";
import type { DatabaseSize } from "@/server/storage/size.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import { reserveBytes } from "@/shared/schemas/settings.ts";

/** What the size guard needs of storage; the storage module satisfies it. */
export interface SizeGuardStorage {
  readonly checks: Pick<ChecksRepository, "dropOldest">;
  readonly settings: SettingsRepository;
  readonly size: DatabaseSize;
}

/** The size guard measures at most this often. */
export const measurePeriodMs = 10_000;

/** Why the history must shrink before the next write: the used size is over the size budget, or the free disk under the reserve. */
export type Pressure = "budget" | "reserve";

/** One measurement as the rule reads it. */
export interface Measurement {
  /** The size budget, or nothing for unlimited. */
  readonly budgetBytes: number | undefined;
  /** The free disk under the SQLite file; nothing on Postgres. */
  readonly freeBytes: number | undefined;
  readonly usedBytes: number;
}

/**
 * Why the history must shrink, or nothing. The reserve comes first: a disk
 * that is nearly full is the harm the budget only bounds. Over the budget
 * counts only above `floorBytes`, the used size a round that freed nothing
 * left behind.
 */
export function pressureOf(
  measurement: Measurement,
  floorBytes: number | undefined
): Pressure | undefined {
  const { budgetBytes, freeBytes, usedBytes } = measurement;
  if (freeBytes !== undefined && freeBytes < reserveBytes) {
    return "reserve";
  }
  if (
    budgetBytes !== undefined &&
    usedBytes > budgetBytes &&
    (floorBytes === undefined || usedBytes > floorBytes)
  ) {
    return "budget";
  }
}

export interface SizeGuard {
  /** Before a check's row is written: measures when the last measurement is ten seconds old, deletes the oldest history while there is pressure, and answers whether the row may be written. Never throws; a failed measurement admits the row and is logged. */
  admit: (now: number) => Promise<boolean>;
}

export interface SizeGuardOptions {
  /** Moves the change counter after a round deleted history. */
  readonly bump: () => Promise<void>;
  /** How often the guard measures. */
  readonly measurePeriodMs?: number;
}

export function createSizeGuard(
  storage: SizeGuardStorage,
  options: SizeGuardOptions
): SizeGuard {
  const period = options.measurePeriodMs ?? measurePeriodMs;
  let measuredAt: number | undefined;
  let admitting = true;
  let pending: Promise<boolean> | undefined;
  /** The used size a budget round that freed nothing left, and the budget it was measured under. */
  let floor:
    | { readonly budgetBytes: number; readonly usedBytes: number }
    | undefined;
  /** Whether the "nothing left to delete" line was logged for the budget episode under way; it ends with the floor. */
  let exhaustedLogged = false;

  async function measure(): Promise<Measurement> {
    const [budgetBytes, usedBytes, freeBytes] = await Promise.all([
      readSizeBudgetBytes(storage),
      storage.size.used(),
      storage.size.free(),
    ]);
    // The floor holds while the budget it was measured under stands and the used size is still over it.
    if (
      floor &&
      (budgetBytes !== floor.budgetBytes || usedBytes <= floor.budgetBytes)
    ) {
      floor = undefined;
      exhaustedLogged = false;
    }
    return { budgetBytes, freeBytes, usedBytes };
  }

  async function enforce(now: number): Promise<boolean> {
    let measurement = await measure();
    let pressure = pressureOf(measurement, floor?.usedBytes);
    while (pressure) {
      // biome-ignore lint/performance/noAwaitInLoops: one round at a time, each measured before the next
      const dropped = await storage.checks.dropOldest(utcDayStart(now));
      if (!dropped) {
        if (pressure === "reserve") {
          return false;
        }
        // Once for the episode: the used size grows with every check until it falls to the budget again.
        if (!exhaustedLogged) {
          exhaustedLogged = true;
          logError(
            "the used size is over the size budget and no history is left to delete; checks are still recorded"
          );
        }
        floor = floorOf(measurement);
        return true;
      }
      // The counter first: history is gone whether or not the space comes back.
      await options.bump();
      await storage.size.reclaim();
      logInfo(
        `the size guard deleted the ${dropped.tier} history of ${new Date(dropped.day).toISOString().slice(0, 10)}: ${pressure === "reserve" ? "the free disk is under the reserve" : "the used size is over the size budget"}`
      );
      const next = await measure();
      // Postgres keeps freed space inside its files: a round that lowered nothing waits for growth.
      if (pressure === "budget" && next.usedBytes >= measurement.usedBytes) {
        floor = floorOf(next);
      }
      measurement = next;
      pressure = pressureOf(measurement, floor?.usedBytes);
    }
    return true;
  }

  return {
    admit: (now) => {
      if (pending !== undefined) {
        return pending;
      }
      if (measuredAt !== undefined && now - measuredAt < period) {
        return Promise.resolve(admitting);
      }
      measuredAt = now;
      pending = enforce(now)
        .catch((error: unknown) => {
          logError(
            `the size guard could not measure the database: ${reasonOf(error)}`
          );
          return true;
        })
        .then((answer) => {
          admitting = answer;
          return answer;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

function floorOf(
  measurement: Measurement
): { budgetBytes: number; usedBytes: number } | undefined {
  return measurement.budgetBytes === undefined
    ? undefined
    : {
        budgetBytes: measurement.budgetBytes,
        usedBytes: measurement.usedBytes,
      };
}

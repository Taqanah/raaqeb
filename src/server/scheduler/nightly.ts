/**
 * The nightly job (CONTEXT.md "Sealed day", "Retention",
 * ADR-0005): on the scheduler's tick, once a closed day is safe to seal
 * (`sealingCutoff`), the sealing pass and then the purge, beside the checks
 * and never twice at once. Each part is done for the day once it ran
 * through every monitor; a job that left a day or a monitor behind runs
 * again a minute after it started, and a purge that failed runs again
 * without sealing again. Once the scheduler stops, the job ends at the next
 * monitor. The two parts are `sealing.ts` and `purge.ts`, each a pass with
 * no state of its own; after the purge, the pending subscriptions whose
 * confirmation link expired are deleted.
 */

import { error as logError, reasonOf } from "@/server/log.ts";
import type { ChecksRepository } from "@/server/storage/checks.ts";
import type { SettingsRepository } from "@/server/storage/settings.ts";
import type { DatabaseSize } from "@/server/storage/size.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { purgeHistory } from "./purge.ts";
import { sealingCutoff } from "./schedule.ts";
import { type SealingStorage, sealClosedDays } from "./sealing.ts";

/** What the nightly job needs of storage; the storage module satisfies it. */
export interface NightlyJobStorage extends SealingStorage {
  readonly checks: Pick<ChecksRepository, "purge" | "seal" | "unsealed">;
  readonly settings: SettingsRepository;
  readonly size: Pick<DatabaseSize, "reclaim">;
}

/** A job that left a day unsealed or a monitor unpurged runs again this long after it started. */
export const nightlyRetryMs = 60_000;

export interface NightlyJob {
  /** Resolves once no job is under way; once the scheduler stops, a job ends at the next monitor, so stop waits on this too. */
  idle: () => Promise<void>;
  /** On the tick: starts the job over the monitors as the tick read them, every one, paused ones included, when a part is left for the day, none is under way and the last did not start within the retry period. Never waits for it and never throws; a job that fails is logged. */
  run: (now: number, monitors: readonly Monitor[], timeZone: string) => void;
}

export interface NightlyJobOptions {
  /** Moves the change counter once the purge deleted a row. */
  readonly bump: () => Promise<void>;
  /** After the day's purge, deletes what else has had its day: the pending subscriptions whose link expired. */
  readonly expire?: (now: number) => Promise<void>;
  /** Whether the scheduler has stopped; the job ends at the next monitor. */
  readonly isStopped: () => boolean;
}

export function createNightlyJob(
  storage: NightlyJobStorage,
  options: NightlyJobOptions
): NightlyJob {
  const { bump, isStopped } = options;
  let job: Promise<void> | undefined;
  /** When the job that left a part for the day started; the next waits the retry period from it. */
  let startedAt: number | undefined;
  /** The cutoff the last sealing pass that sealed every day reached; sealing waits for the next one. */
  let sealedBefore: number | undefined;
  /** The cutoff the last purge of every monitor ran at; the purge waits for the next one. */
  let purgedBefore: number | undefined;

  const done = (cutoff: number) =>
    cutoff === sealedBefore && cutoff === purgedBefore;

  async function nightly(
    cutoff: number,
    now: number,
    monitors: readonly Monitor[],
    timeZone: string
  ): Promise<void> {
    const shared = { isStopped, monitors, now };
    if (cutoff !== sealedBefore) {
      const pass = await sealClosedDays(storage, {
        ...shared,
        cutoff,
        timeZone,
      });
      if (pass.failed === 0 && !isStopped()) {
        sealedBefore = cutoff;
      }
    }
    // A lowered retention takes effect here, after the day's sealing.
    if (cutoff !== purgedBefore && !isStopped()) {
      const purge = await purgeHistory(storage, { ...shared, bump });
      if (purge.failed === 0 && !isStopped()) {
        purgedBefore = cutoff;
        // Pending subscriptions whose link has expired go with the day's purge; a failure waits for tomorrow's.
        await options.expire?.(now);
      }
    }
    if (done(cutoff)) {
      startedAt = undefined;
    }
  }

  return {
    idle: async () => {
      await job;
    },
    run: (now, monitors, timeZone) => {
      const cutoff = sealingCutoff(now);
      if (
        job !== undefined ||
        done(cutoff) ||
        (startedAt !== undefined && now - startedAt < nightlyRetryMs)
      ) {
        return;
      }
      startedAt = now;
      job = nightly(cutoff, now, monitors, timeZone)
        .catch((error: unknown) => {
          logError(`the nightly job failed: ${reasonOf(error)}`);
        })
        .finally(() => {
          job = undefined;
        });
    },
  };
}

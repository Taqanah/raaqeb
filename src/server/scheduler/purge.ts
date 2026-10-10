/**
 * The nightly purge (CONTEXT.md "Retention", ADR-0005): after
 * the sealing pass, each monitor's history past its retention goes, the
 * monitor's own override or else the install default, one monitor at a
 * time, each its own transaction. Failure details and captures go with
 * their raw days; outages and heartbeats are never purged. The pass yields
 * to the event loop between monitors and stops between monitors once the
 * scheduler stops. When it deleted anything it gives the space back and
 * moves the change counter once, so no memoised public view is built on
 * history that is gone.
 */

import { error as logError, reasonOf } from "@/server/log.ts";
import { readRetentionDays } from "@/server/settings/retention.ts";
import type { ChecksRepository } from "@/server/storage/checks.ts";
import type { SettingsRepository } from "@/server/storage/settings.ts";
import type { DatabaseSize } from "@/server/storage/size.ts";
import { retentionBounds } from "@/shared/domain/retention.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";

/** What the purge needs of storage; the storage module satisfies it. */
export interface PurgeStorage {
  readonly checks: Pick<ChecksRepository, "purge">;
  readonly settings: SettingsRepository;
  readonly size: Pick<DatabaseSize, "reclaim">;
}

export interface PurgeOptions {
  /** Moves the change counter once the pass deleted a row. */
  readonly bump: () => Promise<void>;
  /** Whether the scheduler has stopped; the pass ends at the next monitor. */
  readonly isStopped: () => boolean;
  /** Every monitor as the scheduler last read it, paused ones included. */
  readonly monitors: readonly Monitor[];
  readonly now: number;
}

/** What one pass did: the rows it deleted and the monitors it could not purge, which the next pass tries again. */
export interface PurgePass {
  readonly deleted: number;
  readonly failed: number;
}

export async function purgeHistory(
  storage: PurgeStorage,
  options: PurgeOptions
): Promise<PurgePass> {
  const installDays = await readRetentionDays(storage);
  let deleted = 0;
  let failed = 0;
  let first = true;
  for (const monitor of options.monitors) {
    if (options.isStopped()) {
      break;
    }
    if (!first) {
      // Between monitors the loop runs whatever is due: a check, a request.
      // biome-ignore lint/performance/noAwaitInLoops: the pause is the point
      await Bun.sleep(0);
    }
    first = false;
    const bounds = retentionBounds(
      monitor.retentionDays ?? installDays,
      options.now
    );
    try {
      deleted += await storage.checks.purge(monitor.id, bounds);
    } catch (error) {
      failed += 1;
      logError(
        `the nightly purge left the monitor ${monitor.id} for its next pass: ${reasonOf(error)}`
      );
    }
  }
  if (deleted > 0) {
    // The counter first: history is gone whether or not the space comes back.
    await options.bump();
    await storage.size.reclaim();
  }
  return { deleted, failed };
}

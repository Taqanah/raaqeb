/**
 * The nightly sealing job's pass (CONTEXT.md "Sealed day",
 * ADR-0005): every closed UTC day before the cutoff that still has head
 * rows is sealed, one monitor at a time, oldest day first, each day its own
 * transaction, with the time maintenance windows covered the monitor left
 * out of its observed time. The pass yields to the event loop between monitors, so a
 * due check never waits behind it, and stops between monitors once the
 * scheduler stops. A day that fails is logged and left for the next pass.
 */

import { gapLimitMs } from "@/server/checks/heartbeat.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import { coveredSpans } from "@/server/status/maintenance.ts";
import type { ChecksRepository } from "@/server/storage/checks.ts";
import {
  ComponentShapeError,
  type ComponentsRepository,
} from "@/server/storage/components.ts";
import {
  type MaintenanceRepository,
  MaintenanceShapeError,
} from "@/server/storage/maintenance.ts";
import type { Span } from "@/shared/domain/uptime.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";

export interface SealingOptions {
  /** Days that start before this are sealed (`sealingCutoff`). */
  readonly cutoff: number;
  /** Whether the scheduler has stopped; the pass ends at the next monitor. */
  readonly isStopped: () => boolean;
  /** Every monitor as the scheduler last read it; a monitor's gap limit reads its schedule. */
  readonly monitors: readonly Monitor[];
  readonly now: number;
  /** The install time zone a heartbeat monitor's cron schedule is read in. */
  readonly timeZone: string;
}

/** What one pass did: the days it sealed and the days it left for the next pass. */
export interface SealingPass {
  readonly failed: number;
  readonly sealed: number;
}

/** What the pass needs of storage: the checks to seal, and the windows and links that say where each monitor was covered. */
export interface SealingStorage {
  readonly checks: Pick<ChecksRepository, "seal" | "unsealed">;
  readonly components: Pick<ComponentsRepository, "list">;
  readonly maintenance: Pick<MaintenanceRepository, "since">;
}

export async function sealClosedDays(
  storage: SealingStorage,
  options: SealingOptions
): Promise<SealingPass> {
  const monitors = new Map(
    options.monitors.map((monitor) => [monitor.id, monitor])
  );
  // Each monitor's days together, oldest first, in the order the monitors first appear.
  const byMonitor = new Map<string, number[]>();
  for (const { day, monitorId } of await storage.checks.unsealed(
    options.cutoff
  )) {
    byMonitor.set(monitorId, [...(byMonitor.get(monitorId) ?? []), day]);
  }
  const covered = await coveredDays(storage, byMonitor, options.now);
  let sealed = 0;
  let failed = 0;
  let first = true;
  for (const [monitorId, days] of byMonitor) {
    if (options.isStopped()) {
      break;
    }
    if (!first) {
      // Between monitors the loop runs whatever is due: a check, a request.
      // biome-ignore lint/performance/noAwaitInLoops: the pause is the point
      await Bun.sleep(0);
    }
    first = false;
    const monitor = monitors.get(monitorId);
    if (!monitor) {
      // Created since the scheduler last read the monitors; the next pass has it.
      failed += days.length;
      logError(
        `the sealing job left the monitor ${monitorId} for its next pass: the scheduler has not read it yet`
      );
      continue;
    }
    const limit = gapLimitMs(monitor, options.now, options.timeZone);
    for (const day of days) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: oldest day first, since each day reads the one before it
        await storage.checks.seal(
          monitorId,
          day,
          limit,
          covered.get(monitorId) ?? []
        );
        sealed += 1;
      } catch (error) {
        failed += 1;
        logError(
          `the sealing job could not seal the day ${new Date(day).toISOString().slice(0, 10)} of the monitor ${monitorId}: ${reasonOf(error)}`
        );
      }
    }
  }
  return { failed, sealed };
}

/** The spans windows covered each monitor, read once for the days left to seal, and only when one is left. */
async function coveredDays(
  storage: SealingStorage,
  byMonitor: ReadonlyMap<string, readonly number[]>,
  now: number
): Promise<Map<string, Span[]>> {
  const days = [...byMonitor.values()].flat();
  if (days.length === 0) {
    return new Map();
  }
  try {
    const [windows, components] = await Promise.all([
      storage.maintenance.since(days.reduce((a, b) => Math.min(a, b))),
      storage.components.list(),
    ]);
    return coveredSpans(windows, components, now);
  } catch (error) {
    if (
      !(
        error instanceof MaintenanceShapeError ||
        error instanceof ComponentShapeError
      )
    ) {
      throw error;
    }
    // Sealed with no time left out, which never flatters an uptime, rather than never sealed at all.
    logError(
      `the sealing job seals without the maintenance windows: ${error.message}`
    );
    return new Map();
  }
}

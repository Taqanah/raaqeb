/**
 * The maintenance pass (CONTEXT.md "Maintenance window"): on
 * the scheduler's tick it moves each window whose time has come, scheduled
 * to in progress at its start and to completed at its end, straight to
 * completed when both passed while Raaqeb was stopped, through the
 * repository's guarded write, so each move happens once however ticks and
 * restarts race it. It learns of the edges by
 * reading the unfinished windows and the component links whenever the
 * operator moved the change counter, which every window write does, and
 * keeps the next edge in memory, so a tick before it costs no query. A
 * tick that moved windows bumps the counter once and hands each on (a log
 * line, and maintenance started or completed to its subscribers). The pass answers which monitors
 * are covered now, and hands on the monitors a completed window left
 * uncovered, for the down notification sent then.
 */

import { error as logError, reasonOf } from "@/server/log.ts";
import {
  type ComponentLinks,
  coveredMonitors,
  nextEdge,
} from "@/server/status/maintenance.ts";
import {
  ComponentShapeError,
  type ComponentsRepository,
} from "@/server/storage/components.ts";
import {
  type MaintenanceRepository,
  MaintenanceShapeError,
} from "@/server/storage/maintenance.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";

/** What the pass needs of storage; the storage module satisfies it. */
export interface MaintenancePassStorage {
  readonly components: Pick<ComponentsRepository, "list">;
  readonly maintenance: Pick<MaintenanceRepository, "advance" | "unfinished">;
}

export interface MaintenancePassOptions {
  /** Moves the change counter once for the windows one tick moved. */
  readonly bump: () => Promise<void>;
  /** Whether the scheduler has stopped; the pass moves nothing more. */
  readonly isStopped: () => boolean;
  /** Called with each window the pass moved, in its new stage. */
  readonly onMoved?: (window: MaintenanceWindow) => void;
  /** Called with the monitors that windows completing left uncovered, after the counter moved. */
  readonly onUncovered: (
    monitorIds: readonly string[],
    now: number
  ) => Promise<void>;
}

export interface MaintenancePass {
  /** Whether a window in progress covers the monitor now. */
  covers: (monitorId: string) => boolean;
  /** Resolves once no move is under way; stop waits on it, so a move's bump and notifications land before the storage closes. */
  idle: () => Promise<void>;
  /** Reads the unfinished windows and the component links again; answers whether the read is settled. A window this version cannot read is logged and the windows stay as they were; any other failure answers false, to be tried again. */
  read: () => Promise<boolean>;
  /** On the tick: once the next edge has come, moves the windows due. Never throws; a failure is logged and tried again at the next tick. */
  run: (now: number) => Promise<void>;
}

export function createMaintenancePass(
  storage: MaintenancePassStorage,
  options: MaintenancePassOptions
): MaintenancePass {
  /** The windows as last read, with the moves since. */
  let windows: readonly MaintenanceWindow[] = [];
  let components: readonly ComponentLinks[] = [];
  let covered: ReadonlySet<string> = new Set();
  let edge: number | undefined;
  /** The move under way, which stop waits for. */
  let moving: Promise<void> | undefined;

  function know(next: readonly MaintenanceWindow[]): ReadonlySet<string> {
    windows = next;
    edge = nextEdge(windows);
    return coveredMonitors(windows, components);
  }

  async function read(): Promise<boolean> {
    try {
      const [unfinished, links] = await Promise.all([
        storage.maintenance.unfinished(),
        storage.components.list(),
      ]);
      components = links;
      covered = know(unfinished);
      return true;
    } catch (error) {
      logError(
        `the scheduler keeps its maintenance windows as they were: ${reasonOf(error)}`
      );
      // A window or component this version cannot read stays so until the operator acts, which moves the counter.
      return (
        error instanceof MaintenanceShapeError ||
        error instanceof ComponentShapeError
      );
    }
  }

  async function move(now: number): Promise<void> {
    let moved: MaintenanceWindow[];
    try {
      moved = await storage.maintenance.advance(now);
    } catch (error) {
      logError(
        `the maintenance windows due were not moved: ${reasonOf(error)}`
      );
      return;
    }
    if (moved.length === 0) {
      // What the pass knew was stale (a write it has not read yet): read it now, not every tick.
      await read();
      return;
    }
    const byId = new Map(windows.map((window) => [window.id, window]));
    for (const window of moved) {
      byId.set(window.id, window);
    }
    const before = covered;
    const next = know([...byId.values()]);
    // A monitor a window starts covering is covered at once; one a window stops covering stays so until it is handed on, so a check settling meanwhile is held for the notification at the end.
    covered = new Set([...before, ...next]);
    await options.bump();
    for (const window of moved) {
      options.onMoved?.(window);
    }
    covered = next;
    const uncovered = [...before].filter((id) => !next.has(id));
    if (uncovered.length > 0) {
      await options.onUncovered(uncovered, now);
    }
  }

  return {
    covers: (monitorId) => covered.has(monitorId),
    idle: async () => {
      await moving;
    },
    read,
    run: async (now) => {
      // No edge before the first read, and none once every window completed.
      if (edge === undefined || now < edge || options.isStopped()) {
        return;
      }
      const current = move(now).finally(() => {
        if (moving === current) {
          moving = undefined;
        }
      });
      moving = current;
      await current;
    },
  };
}

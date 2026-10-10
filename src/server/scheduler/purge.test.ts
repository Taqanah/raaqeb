import { describe, expect, spyOn, test } from "bun:test";
import { retentionDays } from "@/server/settings/retention.ts";
import type { Setting, SettingsRepository } from "@/server/storage/settings.ts";
import { retentionBounds } from "@/shared/domain/retention.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { purgeHistory } from "./purge.ts";

const now = 1_700_006_400_000 + 15 * 60_000;

function monitor(id: string, overrides: Partial<Monitor> = {}): Monitor {
  return {
    config: { host: "example.test", port: 443, type: "tcp" },
    createdAt: 0,
    degradedMs: undefined,
    description: undefined,
    group: undefined,
    id,
    intervalMs: 60_000,
    name: id,
    paused: false,
    retentionDays: undefined,
    retries: 0,
    channels: [],
    events: [...monitorEventKinds],
    tags: [],
    target: "example.test:443",
    timeoutMs: 10_000,
    updatedAt: 0,
    ...overrides,
  };
}

interface Purge {
  bounds: unknown;
  monitorId: string;
  /** Whether a task queued before the pass had run by this purge. */
  taskRan: boolean;
}

/** A purge's storage in memory: `deleted` answers each monitor's row count, a monitor named in `fail` throws; the install default is `installDays`, or none stored. */
function fakes(
  options: {
    deleted?: (monitorId: string) => number;
    fail?: string;
    installDays?: number;
  } = {}
) {
  const purges: Purge[] = [];
  const asked = { bumps: 0, reclaims: 0 };
  let taskRan = false;
  // A task queued before the pass runs only when the pass gives the loop back.
  setImmediate(() => {
    taskRan = true;
  });
  const stored = new Map<string, unknown>();
  if (options.installDays !== undefined) {
    stored.set(retentionDays.key, options.installDays);
  }
  const settings: SettingsRepository = {
    get: <T>(setting: Setting<T>) =>
      Promise.resolve(
        stored.has(setting.key)
          ? setting.schema.parse(stored.get(setting.key))
          : undefined
      ),
    remove: () => Promise.resolve(),
    set: () => Promise.resolve(),
  };
  const storage = {
    checks: {
      purge: (monitorId: string, bounds: unknown) => {
        purges.push({ bounds, monitorId, taskRan });
        if (monitorId === options.fail) {
          // The error names no monitor, so the log line must name it.
          return Promise.reject(new Error("the disk is busy"));
        }
        return Promise.resolve(options.deleted?.(monitorId) ?? 0);
      },
    },
    settings,
    size: {
      reclaim: () => {
        asked.reclaims += 1;
        return Promise.resolve();
      },
    },
  };
  const bump = () => {
    asked.bumps += 1;
    return Promise.resolve();
  };
  return { asked, bump, purges, storage };
}

describe("the nightly purge", () => {
  test("purges each monitor by its own retention, or else the install default, paused ones too", async () => {
    const { bump, purges, storage } = fakes({ installDays: 45 });
    await purgeHistory(storage, {
      bump,
      isStopped: () => false,
      monitors: [
        monitor("a", { retentionDays: 7 }),
        monitor("b"),
        monitor("c", { paused: true, retentionDays: 400 }),
      ],
      now,
    });
    expect(purges.map(({ bounds, monitorId }) => [monitorId, bounds])).toEqual([
      ["a", retentionBounds(7, now)],
      ["b", retentionBounds(45, now)],
      ["c", retentionBounds(400, now)],
    ]);
  });

  test("with no install default stored, a monitor without its own keeps 90 days", async () => {
    const { bump, purges, storage } = fakes();
    await purgeHistory(storage, {
      bump,
      isStopped: () => false,
      monitors: [monitor("a")],
      now,
    });
    expect(purges[0]?.bounds).toEqual(retentionBounds(90, now));
  });

  test("a pass that deleted rows gives the space back and moves the change counter once", async () => {
    const { asked, bump, storage } = fakes({ deleted: () => 12 });
    const pass = await purgeHistory(storage, {
      bump,
      isStopped: () => false,
      monitors: [monitor("a"), monitor("b")],
      now,
    });
    expect(pass).toEqual({ deleted: 24, failed: 0 });
    expect(asked).toEqual({ bumps: 1, reclaims: 1 });
  });

  test("a pass whose space does not come back has still moved the change counter", async () => {
    const { asked, bump, storage } = fakes({ deleted: () => 5 });
    await expect(
      purgeHistory(
        {
          ...storage,
          size: {
            reclaim: () => Promise.reject(new Error("the vacuum failed")),
          },
        },
        { bump, isStopped: () => false, monitors: [monitor("a")], now }
      )
    ).rejects.toThrow("the vacuum failed");
    expect(asked.bumps).toBe(1);
  });

  test("a pass that deleted nothing gives nothing back and moves nothing", async () => {
    const { asked, bump, storage } = fakes();
    const pass = await purgeHistory(storage, {
      bump,
      isStopped: () => false,
      monitors: [monitor("a")],
      now,
    });
    expect(pass).toEqual({ deleted: 0, failed: 0 });
    expect(asked).toEqual({ bumps: 0, reclaims: 0 });
  });

  test("a monitor that fails is logged by its id, and the pass goes on to the next", async () => {
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const { asked, bump, purges, storage } = fakes({
        deleted: () => 3,
        fail: "site",
      });
      const pass = await purgeHistory(storage, {
        bump,
        isStopped: () => false,
        monitors: [monitor("site"), monitor("api")],
        now,
      });
      expect(pass).toEqual({ deleted: 3, failed: 1 });
      expect(purges.map((purge) => purge.monitorId)).toEqual(["site", "api"]);
      expect(String(errors.mock.calls[0]?.[0])).toContain("monitor site");
      expect(asked.bumps).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("yields to the event loop between monitors", async () => {
    const { bump, purges, storage } = fakes();
    await purgeHistory(storage, {
      bump,
      isStopped: () => false,
      monitors: [monitor("a"), monitor("b")],
      now,
    });
    expect(purges.map((purge) => purge.taskRan)).toEqual([false, true]);
  });

  test("once the scheduler stops, the pass ends before the next monitor", async () => {
    const { bump, purges, storage } = fakes();
    await purgeHistory(storage, {
      bump,
      isStopped: () => purges.length > 0,
      monitors: [monitor("a"), monitor("b")],
      now,
    });
    expect(purges.map((purge) => purge.monitorId)).toEqual(["a"]);
  });
});

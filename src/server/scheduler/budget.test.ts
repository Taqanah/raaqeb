import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sizeBudgetBytes } from "@/server/settings/retention.ts";
import type { DroppedDay, HistoryTier } from "@/server/storage/checks.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import type { Setting, SettingsRepository } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { megabyte, reserveBytes } from "@/shared/schemas/settings.ts";
import { createSizeGuard, measurePeriodMs, pressureOf } from "./budget.ts";

const t0 = 1_700_006_400_000 + 5 * 3_600_000;
const mb = megabyte;

describe("the pressure on the history", () => {
  test("with no size budget and no free-disk signal (Postgres, unlimited) there is none", () => {
    expect(
      pressureOf(
        {
          budgetBytes: undefined,
          freeBytes: undefined,
          usedBytes: 10_000 * mb,
        },
        undefined
      )
    ).toBeUndefined();
  });

  test("a used size over the size budget is pressure; at the budget it is not", () => {
    expect(
      pressureOf(
        {
          budgetBytes: 100 * mb,
          freeBytes: undefined,
          usedBytes: 100 * mb + 1,
        },
        undefined
      )
    ).toBe("budget");
    expect(
      pressureOf(
        { budgetBytes: 100 * mb, freeBytes: undefined, usedBytes: 100 * mb },
        undefined
      )
    ).toBeUndefined();
  });

  test("free disk under the 64 MB reserve is pressure, with or without a budget, and it comes before the budget", () => {
    expect(reserveBytes).toBe(64 * mb);
    expect(
      pressureOf(
        { budgetBytes: undefined, freeBytes: 64 * mb - 1, usedBytes: mb },
        undefined
      )
    ).toBe("reserve");
    expect(
      pressureOf(
        { budgetBytes: undefined, freeBytes: 64 * mb, usedBytes: mb },
        undefined
      )
    ).toBeUndefined();
    expect(
      pressureOf(
        { budgetBytes: mb, freeBytes: mb, usedBytes: 2 * mb },
        undefined
      )
    ).toBe("reserve");
  });

  test("over the budget counts only above the floor a round that freed nothing left", () => {
    const measured = (usedBytes: number) => ({
      budgetBytes: 100 * mb,
      freeBytes: undefined,
      usedBytes,
    });
    expect(pressureOf(measured(120 * mb), 120 * mb)).toBeUndefined();
    expect(pressureOf(measured(120 * mb + 1), 120 * mb)).toBe("budget");
  });
});

/** A size guard's storage in memory: the used size and free disk the test scripts, the days a delete takes, and what was asked. */
function fakes(options: {
  budget?: number;
  /** The days `dropOldest` takes, in order; then nothing. */
  days?: number;
  free?: () => number | undefined;
  used: () => number;
  /** Called after every delete, so the test can move the sizes. */
  onDrop?: () => void;
}) {
  const asked = { bumps: 0, drops: 0, measures: 0, reclaims: 0 };
  let left = options.days ?? 0;
  const stored = new Map<string, unknown>();
  if (options.budget !== undefined) {
    stored.set(sizeBudgetBytes.key, options.budget);
  }
  const settings: SettingsRepository = {
    get: <T>(setting: Setting<T>) =>
      Promise.resolve(
        stored.has(setting.key)
          ? setting.schema.parse(stored.get(setting.key))
          : undefined
      ),
    remove: (setting) => {
      stored.delete(setting.key);
      return Promise.resolve();
    },
    set: (setting, value) => {
      stored.set(setting.key, value);
      return Promise.resolve();
    },
  };
  const tier: HistoryTier = "raw";
  const storage = {
    checks: {
      dropOldest: (): Promise<DroppedDay | undefined> => {
        asked.drops += 1;
        if (left === 0) {
          return Promise.resolve(undefined);
        }
        left -= 1;
        options.onDrop?.();
        return Promise.resolve({ day: 0, rows: 10, tier });
      },
    },
    settings,
    size: {
      free: () => Promise.resolve(options.free?.()),
      reclaim: () => {
        asked.reclaims += 1;
        return Promise.resolve();
      },
      used: () => {
        asked.measures += 1;
        return Promise.resolve(options.used());
      },
    },
  };
  const bump = () => {
    asked.bumps += 1;
    return Promise.resolve();
  };
  return { asked, bump, storage };
}

describe("the size guard before a check's row is written", () => {
  test("under the size budget and over the reserve, the row is written and nothing is deleted", async () => {
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      days: 5,
      free: () => 500 * mb,
      used: () => 50 * mb,
    });
    const guard = createSizeGuard(storage, { bump });
    expect(await guard.admit(t0)).toBe(true);
    expect(asked).toEqual({ bumps: 0, drops: 0, measures: 1, reclaims: 0 });
  });

  test("over the size budget, the oldest days go one round at a time until the used size is under it, each round given back and counted", async () => {
    let used = 130 * mb;
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      days: 5,
      onDrop: () => {
        used -= 20 * mb;
      },
      used: () => used,
    });
    const guard = createSizeGuard(storage, { bump });
    expect(await guard.admit(t0)).toBe(true);
    expect(used).toBe(90 * mb);
    expect(asked).toMatchObject({ bumps: 2, drops: 2, reclaims: 2 });
  });

  test("a round that frees nothing ends the deletes, and the budget waits until the used size grows past where that round left it", async () => {
    let used = 120 * mb;
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      days: 5,
      used: () => used,
    });
    const guard = createSizeGuard(storage, { bump });
    expect(await guard.admit(t0)).toBe(true);
    expect(asked.drops).toBe(1);
    expect(await guard.admit(t0 + measurePeriodMs)).toBe(true);
    expect(asked.drops).toBe(1);
    used += 1;
    expect(await guard.admit(t0 + 2 * measurePeriodMs)).toBe(true);
    expect(asked.drops).toBe(2);
  });

  test("the floor ends when the used size falls to the budget, so later growth over the budget deletes again", async () => {
    let used = 120 * mb;
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      days: 5,
      used: () => used,
    });
    const guard = createSizeGuard(storage, { bump });
    await guard.admit(t0);
    expect(asked.drops).toBe(1);
    used = 100 * mb;
    await guard.admit(t0 + measurePeriodMs);
    used = 110 * mb;
    await guard.admit(t0 + 2 * measurePeriodMs);
    expect(asked.drops).toBe(2);
  });

  test("the floor ends when the operator changes the budget", async () => {
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      days: 5,
      used: () => 120 * mb,
    });
    const guard = createSizeGuard(storage, { bump });
    await guard.admit(t0);
    expect(asked.drops).toBe(1);
    await storage.settings.set(sizeBudgetBytes, 90 * mb);
    await guard.admit(t0 + measurePeriodMs);
    expect(asked.drops).toBe(2);
  });

  test("a round whose space does not come back still moves the change counter, and the row is written", async () => {
    let used = 120 * mb;
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      days: 5,
      onDrop: () => {
        used = 50 * mb;
      },
      used: () => used,
    });
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const guard = createSizeGuard(
        {
          ...storage,
          size: {
            ...storage.size,
            reclaim: () => Promise.reject(new Error("the vacuum failed")),
          },
        },
        { bump }
      );
      expect(await guard.admit(t0)).toBe(true);
      expect(asked.bumps).toBe(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("the vacuum failed");
    } finally {
      errors.mockRestore();
    }
  });

  test("over the size budget with no history left to delete, the row is still written: the budget bounds history, not the checks", async () => {
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      used: () => 120 * mb,
    });
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const guard = createSizeGuard(storage, { bump });
      expect(await guard.admit(t0)).toBe(true);
      expect(asked).toMatchObject({ bumps: 0, drops: 1 });
    } finally {
      errors.mockRestore();
    }
  });

  test("over the size budget with no history left, the error is logged once, not at every measurement, until the used size falls to the budget", async () => {
    let used = 120 * mb;
    const { bump, storage } = fakes({ budget: 100 * mb, used: () => used });
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const guard = createSizeGuard(storage, { bump });
      for (let step = 0; step < 5; step += 1) {
        used += mb;
        // biome-ignore lint/performance/noAwaitInLoops: one measurement at a time, ten seconds apart
        await guard.admit(t0 + step * measurePeriodMs);
      }
      expect(errors.mock.calls).toHaveLength(1);
      used = 90 * mb;
      await guard.admit(t0 + 5 * measurePeriodMs);
      used = 130 * mb;
      await guard.admit(t0 + 6 * measurePeriodMs);
      expect(errors.mock.calls).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });

  test("measures at most every ten seconds; in between it answers as it last did", async () => {
    const { asked, bump, storage } = fakes({ used: () => mb });
    const guard = createSizeGuard(storage, { bump });
    await guard.admit(t0);
    await guard.admit(t0 + measurePeriodMs - 1);
    expect(asked.measures).toBe(1);
    await guard.admit(t0 + measurePeriodMs);
    expect(asked.measures).toBe(2);
    expect(measurePeriodMs).toBe(10_000);
  });

  test("two rows written at once share one measurement and its answer", async () => {
    const { asked, bump, storage } = fakes({
      free: () => 10 * mb,
      used: () => mb,
    });
    const guard = createSizeGuard(storage, { bump });
    expect(await Promise.all([guard.admit(t0), guard.admit(t0)])).toEqual([
      false,
      false,
    ]);
    expect(asked.measures).toBe(1);
  });

  test("a reserve round that lowers no used size does not hold the size budget back", async () => {
    let free = 40 * mb;
    const { asked, bump, storage } = fakes({
      budget: 100 * mb,
      days: 5,
      free: () => free,
      onDrop: () => {
        free += 30 * mb;
      },
      used: () => 120 * mb,
    });
    const guard = createSizeGuard(storage, { bump });
    await guard.admit(t0);
    // One round for the reserve, one for the budget, which then waits for growth.
    expect(asked.drops).toBe(2);
  });

  test("under the reserve, rounds go on while each gives disk back, and the row is written once the reserve holds", async () => {
    let free = 40 * mb;
    const { asked, bump, storage } = fakes({
      days: 5,
      free: () => free,
      onDrop: () => {
        free += 10 * mb;
      },
      used: () => 500 * mb,
    });
    const guard = createSizeGuard(storage, { bump });
    expect(await guard.admit(t0)).toBe(true);
    expect(free).toBe(70 * mb);
    expect(asked).toMatchObject({ bumps: 3, drops: 3, reclaims: 3 });
  });

  test("under the reserve with no history left to delete, the row is refused until the disk has room again", async () => {
    let free = 10 * mb;
    const { bump, storage } = fakes({ free: () => free, used: () => mb });
    const guard = createSizeGuard(storage, { bump });
    expect(await guard.admit(t0)).toBe(false);
    expect(await guard.admit(t0 + 1)).toBe(false);
    free = 100 * mb;
    expect(await guard.admit(t0 + measurePeriodMs)).toBe(true);
  });

  test("a measurement that fails lets the row through and is logged", async () => {
    const { storage } = fakes({ used: () => mb });
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const guard = createSizeGuard(
        {
          ...storage,
          size: {
            ...storage.size,
            used: () => Promise.reject(new Error("the disk is busy")),
          },
        },
        { bump: () => Promise.resolve() }
      );
      expect(await guard.admit(t0)).toBe(true);
      expect(String(errors.mock.calls[0]?.[0])).toContain("the disk is busy");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the reserve on a nearly full file system", () => {
  let open: { cleanup: () => Promise<void>; storage: Storage } | undefined;

  afterEach(async () => {
    if (open) {
      await open.storage.close();
      await open.cleanup();
      open = undefined;
    }
  });

  const dayMs = 86_400_000;
  const today = Math.floor(t0 / dayMs) * dayMs;

  test("deletes the whole history but today's head rows and then refuses the write; Postgres has no reserve and writes", async () => {
    const scratch = await scratchDatabase();
    // A file system with 8 MB free, whatever is deleted: the fixture of the plan's "done when".
    const opened = await openStorage(scratch.location, {
      freeBytes: () => Promise.resolve(8 * mb),
    });
    if (!opened.ok) {
      throw new Error(opened.message);
    }
    open = { cleanup: scratch.cleanup, storage: opened.storage };
    const store = opened.storage;
    const monitor = await store.monitors.create({
      config: { host: "example.test", port: 443, type: "tcp" },
      intervalMs: 60_000,
      name: "Port",
      retries: 0,
      channels: [],
      events: [...monitorEventKinds],
      tags: [],
      timeoutMs: 10_000,
    });
    for (const at of [today - 2 * dayMs, today - dayMs, today + 1000]) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
      await store.checks.record({
        capture: undefined,
        check: {
          attempts: 1,
          bytes: 0,
          monitorId: monitor.id,
          reason: reasons.ok,
          responseMs: 20,
          result: "up",
          startedAt: at,
          statusCode: undefined,
        },
        detail: undefined,
      });
      if (at < today) {
        await store.checks.seal(monitor.id, at, 120_000, []);
      }
    }
    const counter = await store.changeCounter();
    const guard = createSizeGuard(store, {
      bump: async () => {
        await store.bump();
      },
    });
    const sqlite = scratch.location.backend === "sqlite";
    expect(await guard.admit(t0)).toBe(!sqlite);
    const kept = await store.checks.range(monitor.id, 0, today + dayMs);
    expect(kept.map((check) => check.startedAt)).toEqual(
      sqlite ? [today + 1000] : [today - 2 * dayMs, today - dayMs, today + 1000]
    );
    const [rollups] = await runSql(
      scratch.location,
      "SELECT (SELECT COUNT(*) FROM hourly_rollups) + (SELECT COUNT(*) FROM daily_rollups) AS n"
    );
    expect(Number(rollups?.n) === 0).toBe(sqlite);
    expect((await store.changeCounter()) > counter).toBe(sqlite);
  });
});

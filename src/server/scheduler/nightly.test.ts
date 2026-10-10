import { describe, expect, spyOn, test } from "bun:test";
import type { UnsealedDay } from "@/server/storage/checks.ts";
import type { SettingsRepository } from "@/server/storage/settings.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { createNightlyJob, nightlyRetryMs } from "./nightly.ts";
import { sealingDelayMs } from "./schedule.ts";

/** A UTC day's start. */
const d = 1_700_006_400_000;
const dayMs = 86_400_000;
/** The first moment day `d` is safe to seal. */
const night = d + dayMs + sealingDelayMs;

function monitor(id: string): Monitor {
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
  };
}

interface Faults {
  failList: () => boolean;
  failPurge: () => boolean;
  failSeal: () => boolean;
  gate: Promise<unknown> | undefined;
}

/**
 * The job's storage in memory: `days` are the head's unsealed days, each
 * sealed one leaves the list. `calls` is every storage call in order, a
 * settings read as `retention`; `failSeal`, `failPurge` and `failList` make
 * the next such call throw while they answer true; `gate` holds each seal
 * until it resolves.
 */
function fakes(days: UnsealedDay[]) {
  const head = [...days];
  const calls: string[] = [];
  const settings: SettingsRepository = {
    get: () => {
      calls.push("retention");
      return Promise.resolve(undefined);
    },
    remove: () => Promise.resolve(),
    set: () => Promise.resolve(),
  };
  const faults: Faults = {
    failList: () => false,
    failPurge: () => false,
    failSeal: () => false,
    gate: undefined,
  };
  const storage = {
    checks: {
      purge: (monitorId: string) => {
        calls.push(`purge ${monitorId}`);
        return faults.failPurge()
          ? Promise.reject(new Error(`the purge of ${monitorId} failed`))
          : Promise.resolve(0);
      },
      seal: async (monitorId: string, day: number) => {
        calls.push(`seal ${monitorId}`);
        await faults.gate;
        if (faults.failSeal()) {
          throw new Error(`the seal of ${monitorId} failed`);
        }
        head.splice(
          head.findIndex(
            (one) => one.monitorId === monitorId && one.day === day
          ),
          1
        );
        return 1;
      },
      unsealed: (before: number) => {
        calls.push("unsealed");
        return faults.failList()
          ? Promise.reject(new Error("the disk is busy"))
          : Promise.resolve(head.filter((one) => one.day < before));
      },
    },
    components: { list: () => Promise.resolve([]) },
    maintenance: { since: () => Promise.resolve([]) },
    settings,
    size: { reclaim: () => Promise.resolve() },
  };
  const count = (call: string) => calls.filter((one) => one === call).length;
  return { calls, count, faults, head, storage };
}

const quiet = () =>
  spyOn(process.stderr, "write").mockImplementation(() => true);

const job = (
  storage: ReturnType<typeof fakes>["storage"],
  isStopped = () => false
) => createNightlyJob(storage, { bump: () => Promise.resolve(), isStopped });

describe("the nightly job", () => {
  test("seals a closed day once it is safe to seal, and not before, then purges every monitor", async () => {
    const { calls, head, storage } = fakes([{ day: d, monitorId: "a" }]);
    const nightly = job(storage);
    const monitors = [monitor("a"), monitor("b")];
    nightly.run(night - 1, monitors, "UTC");
    await nightly.idle();
    expect(head).toHaveLength(1);
    calls.length = 0;
    nightly.run(night, monitors, "UTC");
    await nightly.idle();
    expect(head).toEqual([]);
    expect(calls).toEqual([
      "unsealed",
      "seal a",
      "retention",
      "purge a",
      "purge b",
    ]);
  });

  test("a job that sealed and purged everything does not run again that day, and runs again the next night", async () => {
    const { count, storage } = fakes([{ day: d, monitorId: "a" }]);
    const nightly = job(storage);
    const monitors = [monitor("a")];
    nightly.run(night, monitors, "UTC");
    await nightly.idle();
    nightly.run(night + nightlyRetryMs, monitors, "UTC");
    await nightly.idle();
    nightly.run(night + dayMs - 1, monitors, "UTC");
    await nightly.idle();
    expect(count("unsealed")).toBe(1);
    expect(count("purge a")).toBe(1);
    nightly.run(night + dayMs, monitors, "UTC");
    await nightly.idle();
    expect(count("unsealed")).toBe(2);
    expect(count("purge a")).toBe(2);
  });

  test("a job that left a day unsealed runs again a minute after it started, not before", async () => {
    const { count, faults, head, storage } = fakes([
      { day: d, monitorId: "a" },
    ]);
    let failing = true;
    faults.failSeal = () => failing;
    const errors = quiet();
    try {
      const nightly = job(storage);
      const monitors = [monitor("a")];
      nightly.run(night, monitors, "UTC");
      await nightly.idle();
      failing = false;
      nightly.run(night + nightlyRetryMs - 1, monitors, "UTC");
      await nightly.idle();
      expect(count("unsealed")).toBe(1);
      expect(head).toHaveLength(1);
      nightly.run(night + nightlyRetryMs, monitors, "UTC");
      await nightly.idle();
      expect(count("unsealed")).toBe(2);
      expect(head).toEqual([]);
      // The purge ran through every monitor the first time and is done for the day.
      expect(count("purge a")).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("a purge that failed runs again a minute later, without sealing again", async () => {
    const { count, faults, storage } = fakes([{ day: d, monitorId: "a" }]);
    let failing = true;
    faults.failPurge = () => failing;
    const errors = quiet();
    try {
      const nightly = job(storage);
      const monitors = [monitor("a")];
      nightly.run(night, monitors, "UTC");
      await nightly.idle();
      failing = false;
      nightly.run(night + nightlyRetryMs, monitors, "UTC");
      await nightly.idle();
      expect(count("unsealed")).toBe(1);
      expect(count("purge a")).toBe(2);
      nightly.run(night + 2 * nightlyRetryMs, monitors, "UTC");
      await nightly.idle();
      expect(count("purge a")).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });

  test("a job that fails is logged and runs again a minute later", async () => {
    const { count, faults, head, storage } = fakes([
      { day: d, monitorId: "a" },
    ]);
    let failing = true;
    faults.failList = () => failing;
    const errors = quiet();
    try {
      const nightly = job(storage);
      const monitors = [monitor("a")];
      nightly.run(night, monitors, "UTC");
      await nightly.idle();
      expect(String(errors.mock.calls[0]?.[0])).toContain(
        "the nightly job failed: the disk is busy"
      );
      failing = false;
      nightly.run(night + nightlyRetryMs, monitors, "UTC");
      await nightly.idle();
      expect(count("unsealed")).toBe(2);
      expect(head).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a job never runs twice at once, and waiting for the job lasts until the one under way ends", async () => {
    const { count, faults, head, storage } = fakes([
      { day: d, monitorId: "a" },
    ]);
    const gate = Promise.withResolvers<undefined>();
    faults.gate = gate.promise;
    const nightly = job(storage);
    const monitors = [monitor("a")];
    nightly.run(night, monitors, "UTC");
    await Bun.sleep(0);
    nightly.run(night + nightlyRetryMs, monitors, "UTC");
    let idle = false;
    const waiting = nightly.idle().then(() => {
      idle = true;
    });
    await Bun.sleep(0);
    expect(idle).toBe(false);
    gate.resolve(undefined);
    await waiting;
    expect(count("unsealed")).toBe(1);
    expect(head).toEqual([]);
  });
});

describe("the nightly job once the scheduler stops", () => {
  test("the purge does not start after the sealing pass", async () => {
    const { calls, storage } = fakes([{ day: d, monitorId: "a" }]);
    const nightly = job(storage, () => calls.includes("seal a"));
    nightly.run(night, [monitor("a")], "UTC");
    await nightly.idle();
    expect(calls).toEqual(["unsealed", "seal a"]);
  });

  test("a job the stop cut short is not done for the day: run again, it seals what it left", async () => {
    const { calls, head, storage } = fakes([
      { day: d, monitorId: "a" },
      { day: d, monitorId: "b" },
    ]);
    const scheduler: { resumed: boolean } = { resumed: false };
    const nightly = job(
      storage,
      () => !scheduler.resumed && calls.includes("seal a")
    );
    const monitors = [monitor("a"), monitor("b")];
    nightly.run(night, monitors, "UTC");
    await nightly.idle();
    expect(head).toEqual([{ day: d, monitorId: "b" }]);
    scheduler.resumed = true;
    nightly.run(night + nightlyRetryMs, monitors, "UTC");
    await nightly.idle();
    expect(head).toEqual([]);
  });

  test("a purge the stop cut short is not done for the day: run again, it purges the monitors it left", async () => {
    const { calls, count, storage } = fakes([]);
    const scheduler: { resumed: boolean } = { resumed: false };
    const nightly = job(
      storage,
      () => !scheduler.resumed && calls.includes("purge a")
    );
    const monitors = [monitor("a"), monitor("b")];
    nightly.run(night, monitors, "UTC");
    await nightly.idle();
    expect(count("purge b")).toBe(0);
    scheduler.resumed = true;
    nightly.run(night + nightlyRetryMs, monitors, "UTC");
    await nightly.idle();
    expect(count("purge b")).toBe(1);
  });
});

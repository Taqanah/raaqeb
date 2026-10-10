import { describe, expect, spyOn, test } from "bun:test";
import type { ChecksRepository, UnsealedDay } from "@/server/storage/checks.ts";
import { ComponentShapeError } from "@/server/storage/components.ts";
import { MaintenanceShapeError } from "@/server/storage/maintenance.ts";
import type { Monitor, MonitorConfig } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { sealClosedDays } from "./sealing.ts";

/** A UTC day's start. */
const d = 1_700_006_400_000;
const dayMs = 86_400_000;
const hourMs = 3_600_000;

const http: MonitorConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: "https://example.test/",
};

function monitor(id: string, overrides: Partial<Monitor> = {}): Monitor {
  return {
    config: http,
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
    target: "https://example.test/",
    timeoutMs: 10_000,
    updatedAt: 0,
    ...overrides,
  };
}

/** No maintenance window, so no monitor was covered. */
const noWindows = {
  components: { list: () => Promise.resolve([]) },
  maintenance: { since: () => Promise.resolve([]) },
};

interface Seal {
  day: number;
  gapLimitMs: number;
  monitorId: string;
  /** Whether a task queued before the pass had run by this seal. */
  timerFired: boolean;
}

/** A checks repository that lists `unsealed` and records each seal; `fail` names the seals that throw. */
function stores(
  unsealed: readonly UnsealedDay[],
  fail: (seal: Seal) => boolean = () => false
) {
  const seals: Seal[] = [];
  let timerFired = false;
  // A task queued before the pass runs only when the pass gives the loop back; a zero timeout would not be due for a millisecond.
  setImmediate(() => {
    timerFired = true;
  });
  const checks: Pick<ChecksRepository, "seal" | "unsealed"> = {
    seal: (monitorId, day, gapLimitMs) => {
      const seal = { day, gapLimitMs, monitorId, timerFired };
      seals.push(seal);
      // The error names no monitor, so the log line must name it.
      return fail(seal)
        ? Promise.reject(new Error("the disk is busy"))
        : Promise.resolve(1);
    },
    unsealed: () => Promise.resolve([...unsealed]),
  };
  return { checks, seals };
}

const options = (monitors: readonly Monitor[]) => ({
  cutoff: d + dayMs,
  isStopped: () => false,
  monitors,
  now: d + dayMs + hourMs,
  timeZone: "UTC",
});

describe("the sealing job's pass", () => {
  test("seals every unsealed day, one monitor at a time, oldest day first, with each monitor's gap limit", async () => {
    const beat = monitor("b", {
      config: {
        graceMs: 5 * 60_000,
        schedule: { everyMs: hourMs, kind: "every" },
        type: "heartbeat",
      },
    });
    const { checks, seals } = stores([
      { day: d - dayMs, monitorId: "a" },
      { day: d - dayMs, monitorId: "b" },
      { day: d, monitorId: "a" },
    ]);
    const pass = await sealClosedDays(
      { checks, ...noWindows },
      options([monitor("a"), beat])
    );
    expect(pass).toEqual({ failed: 0, sealed: 3 });
    expect(
      seals.map(({ day, gapLimitMs, monitorId }) => [
        monitorId,
        day,
        gapLimitMs,
      ])
    ).toEqual([
      ["a", d - dayMs, 120_000],
      ["a", d, 120_000],
      ["b", d - dayMs, 2 * (hourMs + 5 * 60_000)],
    ]);
  });

  test("a day that fails is logged by its monitor and left for the next pass, and the pass goes on", async () => {
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const { checks, seals } = stores(
        [
          { day: d - dayMs, monitorId: "site" },
          { day: d, monitorId: "site" },
          { day: d, monitorId: "api" },
        ],
        (seal) => seal.day === d - dayMs
      );
      const pass = await sealClosedDays(
        { checks, ...noWindows },
        options([monitor("site"), monitor("api")])
      );
      expect(pass).toEqual({ failed: 1, sealed: 2 });
      expect(seals).toHaveLength(3);
      expect(String(errors.mock.calls[0]?.[0])).toContain("monitor site");
    } finally {
      errors.mockRestore();
    }
  });

  test("a monitor the scheduler has not read yet is left for the next pass", async () => {
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const { checks, seals } = stores([{ day: d, monitorId: "new" }]);
      expect(
        await sealClosedDays({ checks, ...noWindows }, options([]))
      ).toEqual({
        failed: 1,
        sealed: 0,
      });
      expect(seals).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  test("the pass yields to the event loop between monitors", async () => {
    const { checks, seals } = stores([
      { day: d, monitorId: "a" },
      { day: d, monitorId: "c" },
    ]);
    await sealClosedDays(
      { checks, ...noWindows },
      options([monitor("a"), monitor("c")])
    );
    expect(seals.map((seal) => seal.timerFired)).toEqual([false, true]);
  });

  test("once the scheduler stops, the pass ends before the next monitor", async () => {
    const { checks, seals } = stores([
      { day: d, monitorId: "a" },
      { day: d, monitorId: "c" },
    ]);
    const pass = await sealClosedDays(
      { checks, ...noWindows },
      {
        ...options([monitor("a"), monitor("c")]),
        isStopped: () => seals.length > 0,
      }
    );
    expect(pass).toEqual({ failed: 0, sealed: 1 });
    expect(seals.map((seal) => seal.monitorId)).toEqual(["a"]);
  });
});

describe("the sealing pass under maintenance windows", () => {
  test("each seal leaves out the time windows covered its monitor, through the components linked to it now", async () => {
    const excluded: [string, readonly unknown[]][] = [];
    const checks: Pick<ChecksRepository, "seal" | "unsealed"> = {
      seal: (monitorId, _day, _gapLimitMs, spans) => {
        excluded.push([monitorId, spans]);
        return Promise.resolve(1);
      },
      unsealed: () =>
        Promise.resolve([
          { day: d, monitorId: "a" },
          { day: d, monitorId: "c" },
        ]),
    };
    const pass = await sealClosedDays(
      {
        checks,
        components: {
          list: () =>
            Promise.resolve([
              {
                createdAt: 0,
                description: undefined,
                id: "web",
                monitorIds: ["a"],
                name: { ar: "web" },
                status: "operational",
                updatedAt: 0,
              },
            ]),
        },
        maintenance: {
          since: () =>
            Promise.resolve([
              {
                componentIds: ["web"],
                createdAt: 0,
                endsAt: d + 3 * hourMs,
                id: "w1",
                message: { ar: "نص" },
                stage: "completed",
                startsAt: d + hourMs,
                title: { ar: "صيانة" },
                updatedAt: 0,
              },
            ]),
        },
      },
      options([monitor("a"), monitor("c")])
    );
    expect(pass).toEqual({ failed: 0, sealed: 2 });
    expect(excluded).toEqual([
      ["a", [{ from: d + hourMs, to: d + 3 * hourMs }]],
      ["c", []],
    ]);
  });
});

describe("edges of the sealing pass under maintenance windows", () => {
  test("with no day left to seal, the pass reads no window", async () => {
    let reads = 0;
    const counted = () => {
      reads += 1;
      return Promise.resolve([]);
    };
    const { checks } = stores([]);
    await sealClosedDays(
      {
        checks,
        components: { list: counted },
        maintenance: { since: counted },
      },
      options([monitor("a")])
    );
    expect(reads).toBe(0);
  });
});

describe("sealing a day with a window or component this version cannot read", () => {
  test("a window or component this version cannot read leaves every day sealed, with no time left out, and says so", async () => {
    for (const failing of [
      new MaintenanceShapeError("w-bad"),
      new ComponentShapeError("c-bad"),
    ]) {
      const excluded: unknown[] = [];
      const checks: Pick<ChecksRepository, "seal" | "unsealed"> = {
        seal: (_monitorId, _day, _gapLimitMs, spans) => {
          excluded.push(spans);
          return Promise.resolve(1);
        },
        unsealed: () => Promise.resolve([{ day: d, monitorId: "a" }]),
      };
      const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
      );
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each case on its own fakes, one after the other
        const pass = await sealClosedDays(
          {
            checks,
            components: {
              list: () =>
                failing instanceof ComponentShapeError
                  ? Promise.reject(failing)
                  : Promise.resolve([]),
            },
            maintenance: {
              since: () =>
                failing instanceof MaintenanceShapeError
                  ? Promise.reject(failing)
                  : Promise.resolve([]),
            },
          },
          options([monitor("a")])
        );
        expect(pass).toEqual({ failed: 0, sealed: 1 });
        expect(excluded).toEqual([[]]);
        expect(String(stderr.mock.calls[0]?.[0])).toContain(
          failing instanceof MaintenanceShapeError ? "w-bad" : "c-bad"
        );
      } finally {
        stderr.mockRestore();
      }
    }
  });
});

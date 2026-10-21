import { afterEach, describe, expect, test } from "bun:test";
import { coverageOf } from "@/shared/domain/uptime.ts";
import type { Check } from "@/shared/schemas/check.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  type ChecksRepository,
  checksRepository,
  type DayTally,
  type SummaryRead,
} from "./checks.ts";
import { closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import type { DatabaseLocation } from "./storage.ts";

const dayMs = 86_400_000;
const minuteMs = 60_000;
const d = 1_700_006_400_000;

const site: MonitorInput = {
  channels: [],
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  events: [...monitorEventKinds],
  intervalMs: 60_000,
  name: "Site",
  retries: 0,
  tags: [],
  timeoutMs: 10_000,
};

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function install(): Promise<{
  checks: ChecksRepository;
  location: DatabaseLocation;
  monitors: MonitorsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  cleanup = async () => {
    await closeConnection(connection);
    await scratch.cleanup();
  };
  await migrateDatabase(connection);
  const run = executor(connection);
  let next = 0;
  return {
    checks: checksRepository(run),
    location: scratch.location,
    monitors: monitorsRepository(
      run,
      () => d,
      () => {
        next += 1;
        return `id-${String(next).padStart(4, "0")}`;
      }
    ),
  };
}

/** A small seeded generator, so a failing seed replays. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** What `summaries` must answer, summed from the monitor's checks the plain way. */
async function summedFrom(
  checks: ChecksRepository,
  monitorId: string,
  read: SummaryRead,
  to: number
) {
  const rows = await checks.range(monitorId, read.from - read.limitMs, to);
  const days = new Map<number, DayTally>();
  for (const row of rows.filter((each) => each.startedAt >= read.from)) {
    const at = Math.floor(row.startedAt / dayMs) * dayMs;
    const before = days.get(at) ?? {
      checks: 0,
      degraded: 0,
      down: 0,
      timed: 0,
      totalMs: 0,
    };
    const timed = row.result !== "down" && row.responseMs !== undefined;
    days.set(at, {
      checks: before.checks + 1,
      degraded: before.degraded + (row.result === "degraded" ? 1 : 0),
      down: before.down + (row.result === "down" ? 1 : 0),
      timed: before.timed + (timed ? 1 : 0),
      totalMs: before.totalMs + (timed ? (row.responseMs ?? 0) : 0),
    });
  }
  const coverage = coverageOf(
    rows.map((each) => each.startedAt),
    read.limitMs
  );
  return coverage ? { coverage, days } : undefined;
}

const reasonOf: Record<Check["result"], Check["reason"]> = {
  degraded: reasons.slow,
  down: reasons.timeout,
  up: reasons.ok,
};

/** A check's result by a roll in [0, 1): 15 % down, 15 % degraded. */
function resultAt(roll: number): Check["result"] {
  if (roll < 0.15) {
    return "down";
  }
  return roll < 0.3 ? "degraded" : "up";
}

function check(
  monitorId: string,
  startedAt: number,
  result: Check["result"],
  responseMs: number | undefined
): Check {
  return {
    attempts: 1,
    bytes: 1,
    monitorId,
    reason: reasonOf[result],
    responseMs,
    result,
    startedAt,
    statusCode: undefined,
  };
}

describe("a summary against the monitor's checks summed one by one", () => {
  // Six monitors of random cadences, gaps, results and sealed days, each read from a random day with a random limit.
  const seeds = Array.from({ length: 8 }, (_, index) => index + 1);
  for (const seed of seeds) {
    test(`on the random history of seed ${seed}`, async () => {
      const { checks, monitors } = await install();
      const next = random(seed);
      const to = d + 3 * dayMs + 12 * 60 * minuteMs;
      const reads = new Map<string, SummaryRead>();
      for (let index = 0; index < 6; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one monitor's history after another, as the scheduler writes it
        const monitor = await monitors.create({ ...site, name: `M${index}` });
        const step = [5, 10, 20, 30][Math.floor(next() * 4)] ?? 10;
        let at = d + Math.floor(next() * 300) * minuteMs;
        while (at < to + 60 * minuteMs) {
          if (next() < 0.05) {
            at += Math.floor(next() * 200) * minuteMs;
          }
          const roll = next();
          const result = resultAt(roll);
          const responseMs =
            next() < 0.1 ? undefined : Math.floor(next() * 900);
          // biome-ignore lint/performance/noAwaitInLoops: rows in order
          await checks.record({
            capture: undefined,
            check: check(monitor.id, at, result, responseMs),
            detail: undefined,
          });
          at += step * minuteMs + (next() < 0.3 ? 17_000 : 0);
        }
        const sealed = Math.floor(next() * 4);
        // A day left unsealed while the later ones are sealed.
        const skipped = next() < 0.3 ? 0 : -1;
        for (let day = 0; day < sealed; day += 1) {
          if (day !== skipped) {
            // biome-ignore lint/performance/noAwaitInLoops: a day after a day
            await checks.seal(monitor.id, d + day * dayMs, 40 * minuteMs, []);
          }
        }
        reads.set(monitor.id, {
          from: d + (skipped === 0 && sealed > 0 ? 0 : sealed) * dayMs,
          limitMs: ([20, 40, 61][Math.floor(next() * 3)] ?? 20) * minuteMs,
        });
      }
      const got = await checks.summaries(reads, to);
      for (const [id, read] of reads) {
        // biome-ignore lint/performance/noAwaitInLoops: one monitor's oracle after another
        expect(got.get(id)).toEqual(await summedFrom(checks, id, read, to));
      }
    });
  }
});

describe("a head row this version cannot read", () => {
  test("an unknown result code, though not the monitor's latest check, is a CheckShapeError naming the monitor and the check", async () => {
    const { checks, location, monitors } = await install();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    for (const monitor of [a, b]) {
      for (const minute of [0, 1, 2]) {
        // biome-ignore lint/performance/noAwaitInLoops: rows in order
        await checks.record({
          capture: undefined,
          check: check(monitor.id, d + minute * minuteMs, "up", 100),
          detail: undefined,
        });
      }
    }
    await runSql(
      location,
      "UPDATE checks SET result = 7 WHERE monitor_id = ? AND started_at = ?",
      [a.id, d + minuteMs]
    );
    const reads = new Map<string, SummaryRead>([
      [a.id, { from: d, limitMs: 2 * minuteMs }],
      [b.id, { from: d, limitMs: 2 * minuteMs }],
    ]);
    await expect(checks.summaries(reads, d + dayMs)).rejects.toMatchObject({
      monitorId: a.id,
      name: "CheckShapeError",
      startedAt: d + minuteMs,
    });
    // The monitor with only readable rows is read whole.
    const readable = new Map([[b.id, { from: d, limitMs: 2 * minuteMs }]]);
    expect((await checks.summaries(readable, d + dayMs)).get(b.id)).toEqual(
      await summedFrom(
        checks,
        b.id,
        { from: d, limitMs: 2 * minuteMs },
        d + dayMs
      )
    );
  });

  test("an unknown reason code is one too", async () => {
    const { checks, location, monitors } = await install();
    const a = await monitors.create(site);
    await checks.record({
      capture: undefined,
      check: check(a.id, d, "up", 100),
      detail: undefined,
    });
    await runSql(
      location,
      "UPDATE checks SET reason = 999 WHERE monitor_id = ?",
      [a.id]
    );
    await expect(
      checks.summaries(
        new Map([[a.id, { from: d, limitMs: minuteMs }]]),
        d + dayMs
      )
    ).rejects.toMatchObject({ monitorId: a.id, name: "CheckShapeError" });
  });
});

describe("the cost of a summary at 200 monitors with a day of one-minute checks", () => {
  test("is the order of the per-check read it replaces on either backend, never quadratic in the day's rows", async () => {
    const { checks, location, monitors } = await install();
    const ids: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: monitors one after another, as the form creates them
      ids.push((await monitors.create({ ...site, name: `M${index}` })).id);
    }
    const today = Math.floor(Date.now() / dayMs) * dayMs;
    const rows =
      location.backend === "postgres"
        ? `INSERT INTO checks (monitor_id, started_at, result, response_ms, status_code, reason, attempts, bytes) SELECT m.id, ${today} + g * 60000, CASE WHEN g % 50 = 0 THEN 2 ELSE 0 END, 100, 200, 0, 1, 1 FROM monitors m, generate_series(0, 1439) g`
        : `WITH RECURSIVE g(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM g WHERE x < 1439) INSERT INTO checks (monitor_id, started_at, result, response_ms, status_code, reason, attempts, bytes) SELECT m.id, ${today} + x * 60000, CASE WHEN x % 50 = 0 THEN 2 ELSE 0 END, 100, 200, 0, 1, 1 FROM monitors m, g`;
    await runSql(location, rows);
    if (location.backend === "postgres") {
      await runSql(location, "ANALYZE checks");
    }
    const limitMs = 3 * minuteMs;
    const to = today + dayMs;
    const timed = async (work: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await work();
      return performance.now() - start;
    };
    const ranges = new Map(ids.map((id) => [id, today - limitMs]));
    const reads = new Map(ids.map((id) => [id, { from: today, limitMs }]));
    // One run each to warm the plans, then the ones measured.
    await checks.ranges(ranges, to);
    await checks.summaries(reads, to);
    const plain = await timed(() => checks.ranges(ranges, to));
    const summed = await timed(() => checks.summaries(reads, to));
    // A quadratic anti-join took 2 to 7 seconds here on Postgres, against 150 ms for the per-check read.
    expect(summed).toBeLessThan(Math.max(1500, plain * 6));
    expect((await checks.summaries(reads, to)).size).toBe(200);
  }, 120_000);
});

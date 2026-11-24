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
import { closeConnection, type Executor, executor } from "./connection.ts";
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
  run: Executor;
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
    run,
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

/** Monitors with yesterday's last two hours and today's first ten, a check a minute, all still in the head. */
async function twoDaysInTheHead(
  checks: ChecksRepository,
  monitors: MonitorsRepository,
  count: number
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: monitors one after another, as the form creates them
    const monitor = await monitors.create({ ...site, name: `M${index}` });
    ids.push(monitor.id);
    for (
      let at = d + dayMs - 120 * minuteMs;
      at < d + dayMs + 600 * minuteMs;
      at += minuteMs
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await checks.record({
        capture: undefined,
        check: check(monitor.id, at, "up", 100),
        detail: undefined,
      });
    }
  }
  return ids;
}

describe("a day sealed while a summary reads it", () => {
  const read = { from: d, limitMs: 2 * minuteMs };
  const to = d + dayMs + 600 * minuteMs;

  test("is read from its sums again, never check by check, and counted once", async () => {
    const { checks, monitors, run } = await install();
    const ids = await twoDaysInTheHead(checks, monitors, 3);
    let rowsRead = 0;
    let sealed = false;
    // The sealer's pass over yesterday lands right after the summary's first read.
    const racing: Executor = {
      ...run,
      rows: async <T>(query: Parameters<Executor["rows"]>[0]) => {
        const rows = await run.rows<T>(query);
        rowsRead += rows.length;
        if (!sealed) {
          sealed = true;
          for (const id of ids) {
            // biome-ignore lint/performance/noAwaitInLoops: one monitor's seal after another, as the sealer runs
            await checks.seal(id, d, 2 * minuteMs, []);
          }
        }
        return rows;
      },
    };
    const reads = new Map(ids.map((id) => [id, read]));
    const got = await checksRepository(racing).summaries(reads, to);
    expect(sealed).toBe(true);
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: one monitor's oracle after another
      const want = await summedFrom(checks, id, read, to);
      expect(got.get(id)).toEqual(want);
      expect(got.get(id)?.days.get(d)?.checks).toBe(120);
    }
    // Sums, gaps and sealed days are a few rows a monitor; its 720 checks one by one are what ran the install out of memory.
    expect(rowsRead).toBeLessThan(100);
  });

  test("leaves a monitor that stays apart to its checks after one more pass", async () => {
    const { checks, monitors, run } = await install();
    const ids = await twoDaysInTheHead(checks, monitors, 2);
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: one monitor's seal after another, as the sealer runs
      await checks.seal(id, d, 2 * minuteMs, []);
      // A check written into the sealed day, as a clock stepped back writes one: the day stays on both sides until the next pass.
      await checks.record({
        capture: undefined,
        check: check(id, d + dayMs - 30 * minuteMs + 7000, "up", 100),
        detail: undefined,
      });
    }
    let statements = 0;
    const counted: Executor = {
      ...run,
      rows: <T>(query: Parameters<Executor["rows"]>[0]) => {
        statements += 1;
        // A pass that never ends would hang the run; failing here names it.
        if (statements > 20) {
          throw new Error("the summary kept reading the same monitors again");
        }
        return run.rows<T>(query);
      },
    };
    const reads = new Map(ids.map((id) => [id, read]));
    const got = await checksRepository(counted).summaries(reads, to);
    for (const id of ids) {
      expect(got.get(id)?.days.get(d)?.checks).toBe(121);
    }
    // Two passes of three reads, then the head and the sealed days check by check.
    expect(statements).toBe(8);
  });

  test("started in another turn of the event loop than the seal, never finds the day on neither side", async () => {
    const { checks, monitors } = await install();
    // Each way back to the event loop resumes in its own phase; a summary is started from each, one and two turns after the seal.
    const turns: (() => Promise<unknown>)[] = [
      () => Bun.sleep(0),
      () => new Promise((resolve) => setTimeout(resolve, 0)),
      () => new Promise((resolve) => setImmediate(resolve)),
    ];
    const ids = await twoDaysInTheHead(checks, monitors, 2 * turns.length);
    for (const [index, id] of ids.entries()) {
      const sealing = checks.seal(id, d, 2 * minuteMs, []);
      // On SQLite a summary's reads share the seal's connection and see its open transaction: only a seal that never yields to the event loop keeps them out of it.
      for (let turn = 0; turn <= index / turns.length; turn += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one turn of the event loop after another
        await turns[index % turns.length]?.();
      }
      const got = await checks.summaries(new Map([[id, read]]), to);
      await sealing;
      expect(got.get(id)?.days.get(d)?.checks).toBe(120);
    }
  });
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
    const today = Date.UTC(2026, 8, 26);
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

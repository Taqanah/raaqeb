import { afterEach, describe, expect, test } from "bun:test";
import type { Check, CheckOutcome } from "@/shared/schemas/check.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { type ChecksRepository, checksRepository } from "./checks.ts";
import {
  type Connection,
  closeConnection,
  type Executor,
  executor,
} from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import type { DatabaseLocation } from "./storage.ts";

let open:
  | {
      connection: Connection;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

const site: MonitorInput = {
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  intervalMs: 60_000,
  name: "Site",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

async function repositories(): Promise<{
  checks: ChecksRepository;
  location: DatabaseLocation;
  monitors: MonitorsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection, location: scratch.location };
  await migrateDatabase(connection);
  const run = executor(connection);
  let nextId = 0;
  return {
    checks: checksRepository(run),
    location: scratch.location,
    monitors: monitorsRepository(
      run,
      () => 1_700_000_000_000,
      () => {
        nextId += 1;
        return `id-${String(nextId).padStart(3, "0")}`;
      }
    ),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const t0 = 1_700_000_000_000;

function up(monitorId: string, startedAt: number, responseMs = 100): Check {
  return {
    attempts: 1,
    bytes: 512,
    monitorId,
    reason: reasons.ok,
    responseMs,
    result: "up",
    startedAt,
    statusCode: 200,
  };
}

function down(monitorId: string, startedAt: number): CheckOutcome {
  return {
    capture: {
      body: new Uint8Array([0, 255, 104, 105]),
      headers: [
        { name: "content-type", value: "text/html" },
        { name: "set-cookie", value: undefined },
      ],
      monitorId,
      startedAt,
    },
    check: {
      attempts: 3,
      bytes: 0,
      monitorId,
      reason: reasons.unexpected_status,
      responseMs: 40,
      result: "down",
      startedAt,
      statusCode: 503,
    },
    detail: {
      assertion: { codes: ["2xx"], kind: "status" },
      error: "HTTP 503",
      monitorId,
      params: { expected: ["2xx"], observed: 503, reason: "unexpected_status" },
      startedAt,
    },
  };
}

describe("the head table", () => {
  test("a recorded check reads back whole, and the latest per monitor is the newest row of each", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    await checks.record({
      capture: undefined,
      check: up(a.id, t0),
      detail: undefined,
    });
    await checks.record({
      capture: undefined,
      check: up(a.id, t0 + 60_000, 130),
      detail: undefined,
    });
    await checks.record({
      capture: undefined,
      check: up(b.id, t0 + 10, 90),
      detail: undefined,
    });
    const latest = await checks.latest();
    expect(
      latest.toSorted((x, y) => x.monitorId.localeCompare(y.monitorId))
    ).toEqual([up(a.id, t0 + 60_000, 130), up(b.id, t0 + 10, 90)]);
  });

  test("a monitor with no check yet has no latest row", async () => {
    const { checks, monitors } = await repositories();
    await monitors.create(site);
    expect(await checks.latest()).toEqual([]);
  });

  test("a range reads one monitor's rows from the start inclusive to the end exclusive, oldest first", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    // Written out of order on purpose; the read sorts.
    await Promise.all(
      [3, 0, 2, 1].map((offset) =>
        checks.record({
          capture: undefined,
          check: up(a.id, t0 + offset * 60_000, offset),
          detail: undefined,
        })
      )
    );
    await checks.record({
      capture: undefined,
      check: up(b.id, t0 + 60_000),
      detail: undefined,
    });
    const rows = await checks.range(a.id, t0 + 60_000, t0 + 3 * 60_000);
    expect(rows.map((row) => row.responseMs)).toEqual([1, 2]);
    expect(await checks.range(a.id, t0 + 4 * 60_000, t0 + 5 * 60_000)).toEqual(
      []
    );
  });

  test("a heartbeat check with no response time and no status code reads back as none", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const check: Check = {
      ...up(a.id, t0),
      responseMs: undefined,
      statusCode: undefined,
    };
    await checks.record({ capture: undefined, check, detail: undefined });
    expect(await checks.range(a.id, t0, t0 + 1)).toEqual([check]);
  });

  test("a down check's detail and capture read back under the check's key, bytes intact", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const outcome = down(a.id, t0);
    await checks.record(outcome);
    expect(await checks.detail(a.id, t0)).toEqual(outcome.detail);
    const capture = await checks.capture(a.id, t0);
    expect(capture?.headers).toEqual(outcome.capture?.headers);
    expect(Array.from(capture?.body ?? [])).toEqual([0, 255, 104, 105]);
    expect(capture).toMatchObject({ monitorId: a.id, startedAt: t0 });
  });

  test("a check with no detail and no capture reads back none of either", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    await checks.record({
      capture: undefined,
      check: up(a.id, t0),
      detail: undefined,
    });
    expect(await checks.detail(a.id, t0)).toBeUndefined();
    expect(await checks.capture(a.id, t0)).toBeUndefined();
  });

  test("a detail with no assertion and no error keeps only the parameters", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const detail = {
      assertion: undefined,
      error: undefined,
      monitorId: a.id,
      params: { reason: "timeout" as const, timeoutMs: 10_000 },
      startedAt: t0,
    };
    await checks.record({
      capture: undefined,
      check: { ...up(a.id, t0), reason: reasons.timeout, result: "down" },
      detail,
    });
    expect(await checks.detail(a.id, t0)).toEqual(detail);
  });

  test("the three records land together or not at all", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    const outcome = down(a.id, t0);
    await checks.record(outcome);
    // The same key again refuses at the head row; the detail and the capture of the second write must not land either.
    const second = down(a.id, t0);
    await expect(
      checks.record({
        ...second,
        detail: second.detail && { ...second.detail, error: "second" },
      })
    ).rejects.toThrow();
    expect(await checks.detail(a.id, t0)).toEqual(outcome.detail);
    expect(await rowCount(location, "captures")).toBe(1);
  });

  test("deleting a monitor deletes its checks, details and captures", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await checks.record(down(a.id, t0));
    await monitors.remove([a.id]);
    const counts = await Promise.all(
      ["checks", "failure_details", "captures"].map((table) =>
        rowCount(location, table)
      )
    );
    expect(counts).toEqual([0, 0, 0]);
  });

  test("a stored detail this version cannot read is reported by its check, not as a row", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await checks.record(down(a.id, t0));
    await runSql(location, "UPDATE failure_details SET params = ?", [
      '{"reason":"later"}',
    ]);
    await expect(checks.detail(a.id, t0)).rejects.toMatchObject({
      monitorId: a.id,
      name: "CheckShapeError",
      startedAt: t0,
    });
  });

  test("on SQLite the head table has no rowid and a row costs under 80 bytes", async () => {
    const { checks, location, monitors } = await repositories();
    if (location.backend !== "sqlite") {
      return;
    }
    const a = await monitors.create(site);
    await expect(
      runSql(location, "SELECT rowid FROM checks")
    ).rejects.toThrow();
    const before = await pageBytes(location);
    const rows = 5000;
    await Promise.all(
      Array.from({ length: rows }, (_, index) =>
        checks.record({
          capture: undefined,
          check: up(a.id, t0 + index * 60_000, 100 + (index % 50)),
          detail: undefined,
        })
      )
    );
    const perRow = ((await pageBytes(location)) - before) / rows;
    expect(perRow).toBeLessThan(80);
  });
});

/** Postgres answers count(*) as a 64-bit value the raw fixture leaves as text; both backends read as a number here. */
async function rowCount(
  location: DatabaseLocation,
  table: string
): Promise<number> {
  const [row] = await runSql(location, `SELECT count(*) AS n FROM ${table}`);
  return Number(row?.n);
}

async function pageBytes(location: DatabaseLocation): Promise<number> {
  await runSql(location, "PRAGMA wal_checkpoint(TRUNCATE)");
  const [page] = await runSql(location, "PRAGMA page_size");
  const [count] = await runSql(location, "PRAGMA page_count");
  return Number(page?.page_size) * Number(count?.page_count);
}

describe("the detail page's reads of the head table", () => {
  async function recorded(
    checks: ChecksRepository,
    rows: readonly Check[]
  ): Promise<void> {
    for (const check of rows) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
      await checks.record({ capture: undefined, check, detail: undefined });
    }
  }

  test("observed time's read names the first and last check of the range and only the gaps longer than the limit", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    const minutes = [0, 1, 2, 10, 11, 30, 31];
    await recorded(
      checks,
      minutes.map((minute) => up(a.id, t0 + minute * 60_000))
    );
    await recorded(checks, [up(b.id, t0 + 5 * 60_000)]);
    expect(await checks.coverage(a.id, t0, t0 + 60 * 60_000, 120_000)).toEqual({
      first: t0,
      gaps: [
        { from: t0 + 2 * 60_000, to: t0 + 10 * 60_000 },
        { from: t0 + 11 * 60_000, to: t0 + 30 * 60_000 },
      ],
      last: t0 + 31 * 60_000,
    });
    // A gap exactly at the limit is not a gap; the range's ends are inclusive and exclusive.
    expect(
      await checks.coverage(a.id, t0 + 60_000, t0 + 31 * 60_000, 8 * 60_000)
    ).toEqual({
      first: t0 + 60_000,
      gaps: [{ from: t0 + 11 * 60_000, to: t0 + 30 * 60_000 }],
      last: t0 + 30 * 60_000,
    });
  });

  test("a range with no check has nothing to observe", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    expect(await checks.coverage(a.id, t0, t0 + 1, 1)).toBeUndefined();
  });

  test("the recent checks are the newest first, at most the limit, of one monitor", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    await recorded(
      checks,
      [0, 1, 2, 3].map((minute) => up(a.id, t0 + minute * 60_000, minute))
    );
    await recorded(checks, [up(b.id, t0 + 10 * 60_000)]);
    const recent = await checks.recent(a.id, 3);
    expect(recent.map((check) => check.responseMs)).toEqual([3, 2, 1]);
    expect(await checks.recent(a.id, 10)).toHaveLength(4);
  });

  test("the chart's read sums a monitor's checks into buckets from the range's start: the response times of up and degraded checks, and the down and degraded counts", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const bucket = 5 * 60_000;
    const degraded: Check = {
      ...up(a.id, t0 + 60_000, 300),
      reason: reasons.slow,
      result: "degraded",
    };
    await recorded(checks, [
      up(a.id, t0, 100),
      degraded,
      up(a.id, t0 + 2 * 60_000, 200),
    ]);
    // Bucket two holds only a down check; its time is how long it took to fail and is not drawn.
    await checks.record(down(a.id, t0 + 2 * bucket + 60_000));
    await recorded(checks, [up(a.id, t0 + 3 * bucket, 50)]);
    // Outside the range.
    await recorded(checks, [up(a.id, t0 + 4 * bucket, 999)]);
    expect(
      await checks.series(a.id, t0, t0 + 4 * bucket, bucket, "raw")
    ).toEqual([
      {
        at: t0,
        averageMs: 200,
        checks: 3,
        degraded: 1,
        down: 0,
        maxMs: 300,
        minMs: 100,
      },
      {
        at: t0 + 2 * bucket,
        averageMs: undefined,
        checks: 1,
        degraded: 0,
        down: 1,
        maxMs: undefined,
        minMs: undefined,
      },
      {
        at: t0 + 3 * bucket,
        averageMs: 50,
        checks: 1,
        degraded: 0,
        down: 0,
        maxMs: 50,
        minMs: 50,
      },
    ]);
  });

  test("a chart bucket's average response time keeps its fraction", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, [up(a.id, t0, 100), up(a.id, t0 + 1, 101)]);
    const [only] = await checks.series(a.id, t0, t0 + 60_000, 60_000, "raw");
    expect(only?.averageMs).toBe(100.5);
  });

  test("a heartbeat check has no response time, so its bucket counts it and draws nothing", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, [
      { ...up(a.id, t0), responseMs: undefined, statusCode: undefined },
    ]);
    expect(await checks.series(a.id, t0, t0 + 60_000, 60_000, "raw")).toEqual([
      {
        at: t0,
        averageMs: undefined,
        checks: 1,
        degraded: 0,
        down: 0,
        maxMs: undefined,
        minMs: undefined,
      },
    ]);
  });
});

describe("sealed days", () => {
  /** A closed UTC day's start; the day after it is the open day. */
  const d = 1_700_006_400_000;
  const dayMs = 86_400_000;
  const hourMs = 3_600_000;
  const minuteMs = 60_000;
  const limit = 40 * minuteMs;

  /** One check every `stepMs` from `from`, `count` of them; every tenth is down and every seventh degraded. */
  function every(
    monitorId: string,
    from: number,
    count: number,
    stepMs: number
  ): Check[] {
    return Array.from({ length: count }, (_, index) => {
      const startedAt = from + index * stepMs;
      if (index % 10 === 9) {
        return { ...down(monitorId, startedAt).check };
      }
      return {
        ...up(monitorId, startedAt, 100 + index),
        ...(index % 7 === 6
          ? { reason: reasons.slow, result: "degraded" }
          : {}),
      };
    });
  }

  async function recorded(
    checks: ChecksRepository,
    rows: readonly Check[]
  ): Promise<void> {
    for (const check of rows) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
      await checks.record({ capture: undefined, check, detail: undefined });
    }
  }

  async function corruptChunk(location: DatabaseLocation): Promise<void> {
    await runSql(
      location,
      location.backend === "sqlite"
        ? "UPDATE sealed_days SET chunk = X'01020304'"
        : "UPDATE sealed_days SET chunk = '\\x01020304'::bytea"
    );
  }

  test("sealing a closed day moves its checks out of the head into one sealed day that reads back the exact checks, with the day's rollups", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    const sealedRows = every(a.id, d, 72, 20 * minuteMs);
    const openRows = every(a.id, d + dayMs, 2, 20 * minuteMs);
    await recorded(checks, [...sealedRows, ...openRows]);
    expect(await checks.seal(a.id, d, limit, [])).toBe(72);
    expect(await rowCount(location, "checks")).toBe(2);
    expect(await rowCount(location, "sealed_days")).toBe(1);
    expect(await checks.range(a.id, d, d + dayMs)).toEqual(sealedRows);
    expect(await checks.unsealed(d + dayMs)).toEqual([]);
    const hours = await checks.rollups(a.id, "hour", d, d + dayMs);
    expect(hours).toHaveLength(24);
    expect(hours[0]).toMatchObject({ at: d, checks: 3, observedMs: hourMs });
    const [daily] = await checks.rollups(a.id, "day", d, d + dayMs);
    const times = sealedRows
      .filter((row) => row.result !== "down")
      .map((row) => row.responseMs ?? 0);
    expect(daily).toMatchObject({
      at: d,
      averageMs: Math.round(
        times.reduce((sum, time) => sum + time, 0) / times.length
      ),
      checks: 72,
      degraded: sealedRows.filter((row) => row.result === "degraded").length,
      failed: sealedRows.filter((row) => row.result === "down").length,
      maxMs: Math.max(...times),
      minMs: Math.min(...times),
      monitorId: a.id,
      observedMs: dayMs,
    });
    const [header] = await runSql(
      location,
      "SELECT checks, observed_ms FROM sealed_days"
    );
    expect(header).toEqual({ checks: 72, observed_ms: dayMs });
  });

  test("a sealed day and its rollups leave out the time a maintenance window covered the monitor", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, every(a.id, d, 72, 20 * minuteMs));
    const covered = { from: d + 2 * hourMs, to: d + 5 * hourMs };
    expect(await checks.seal(a.id, d, limit, [covered])).toBe(72);
    const [daily] = await checks.rollups(a.id, "day", d, d + dayMs);
    expect(daily?.observedMs).toBe(dayMs - 3 * hourMs);
    expect(daily?.checks).toBe(72);
    const hours = await checks.rollups(a.id, "hour", d, d + dayMs);
    expect(hours.find((each) => each.at === d + 3 * hourMs)?.observedMs).toBe(
      0
    );
    const [header] = await runSql(
      location,
      "SELECT observed_ms FROM sealed_days"
    );
    expect(header).toEqual({ observed_ms: dayMs - 3 * hourMs });
  });

  test("sealing again is safe: a rerun with nothing new changes nothing, and a head row that lands in a sealed day joins it once", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    const rows = every(a.id, d, 72, 20 * minuteMs);
    await recorded(checks, rows);
    await checks.seal(a.id, d, limit, []);
    expect(await checks.seal(a.id, d, limit, [])).toBe(72);
    expect(await checks.range(a.id, d, d + dayMs)).toEqual(rows);
    const late = up(a.id, d + 12 * hourMs + 5 * minuteMs);
    await recorded(checks, [late]);
    expect(await checks.unsealed(d + dayMs)).toEqual([
      { day: d, monitorId: a.id },
    ]);
    expect(await checks.seal(a.id, d, limit, [])).toBe(73);
    expect(await checks.range(a.id, d, d + dayMs)).toEqual(
      [...rows, late].toSorted((x, y) => x.startedAt - y.startedAt)
    );
    expect(await rowCount(location, "checks")).toBe(0);
    expect(await rowCount(location, "sealed_days")).toBe(1);
    expect(await rowCount(location, "hourly_rollups")).toBe(24);
    const [daily] = await checks.rollups(a.id, "day", d, d + dayMs);
    expect(daily?.checks).toBe(73);
  });

  test("a day that cannot be sealed keeps its head rows", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, every(a.id, d, 3, 20 * minuteMs));
    await checks.seal(a.id, d, limit, []);
    await corruptChunk(location);
    await recorded(checks, [up(a.id, d + hourMs)]);
    await expect(checks.seal(a.id, d, limit, [])).rejects.toMatchObject({
      monitorId: a.id,
      name: "CheckShapeError",
    });
    expect(await rowCount(location, "checks")).toBe(1);
  });

  test("the unsealed days are each monitor's days before the cutoff that still have head rows, oldest first", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    await recorded(checks, [
      up(a.id, d - dayMs + 5),
      up(a.id, d),
      up(a.id, d + dayMs - 1),
      up(a.id, d + dayMs),
      up(b.id, d + 7),
    ]);
    expect(await checks.unsealed(d + dayMs)).toEqual([
      { day: d - dayMs, monitorId: a.id },
      { day: d, monitorId: a.id },
      { day: d, monitorId: b.id },
    ]);
    expect(await checks.unsealed(d)).toEqual([
      { day: d - dayMs, monitorId: a.id },
    ]);
  });

  test("the reads merge the head rows and the sealed days at the day boundary", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const sealedRows = every(a.id, d, 72, 20 * minuteMs);
    const openRows = [
      up(a.id, d + dayMs + 10 * minuteMs),
      up(a.id, d + dayMs + 30 * minuteMs),
    ];
    await recorded(checks, [...sealedRows, ...openRows]);
    await checks.seal(a.id, d, limit, []);
    expect(
      await checks.range(a.id, d + 23 * hourMs, d + dayMs + hourMs)
    ).toEqual([...sealedRows.slice(69), ...openRows]);
    expect(await checks.recent(a.id, 4)).toEqual([
      ...openRows.toReversed(),
      ...sealedRows.slice(70).toReversed(),
    ]);
    expect(
      await checks.coverage(a.id, d, d + 2 * dayMs, 25 * minuteMs)
    ).toEqual({
      first: d,
      gaps: [{ from: d + 71 * 20 * minuteMs, to: d + dayMs + 10 * minuteMs }],
      last: d + dayMs + 30 * minuteMs,
    });
  });

  test("the latest check of a monitor with no head row is the last check of its newest sealed day", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    const c = await monitors.create({ ...site, name: "Third" });
    const aRows = [
      ...every(a.id, d - dayMs, 3, hourMs),
      ...every(a.id, d, 3, hourMs),
    ];
    const bRows = every(b.id, d, 3, hourMs);
    const bOpen = up(b.id, d + dayMs + 5);
    await recorded(checks, [...aRows, ...bRows, bOpen]);
    await checks.seal(a.id, d - dayMs, limit, []);
    await checks.seal(a.id, d, limit, []);
    await checks.seal(b.id, d, limit, []);
    const latest = await checks.latest();
    expect(
      latest.toSorted((x, y) => x.monitorId.localeCompare(y.monitorId))
    ).toEqual([...aRows.slice(5), bOpen]);
    expect(latest.some((check) => check.monitorId === c.id)).toBe(false);
  });

  test("the raw chart sums the sealed checks and the head rows into the same buckets across midnight", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, [
      up(a.id, d + dayMs - 2 * minuteMs, 100),
      up(a.id, d + dayMs + minuteMs, 300),
    ]);
    await checks.seal(a.id, d, limit, []);
    expect(
      await checks.series(
        a.id,
        d + dayMs - 5 * minuteMs,
        d + dayMs + 5 * minuteMs,
        10 * minuteMs,
        "raw"
      )
    ).toEqual([
      {
        at: d + dayMs - 5 * minuteMs,
        averageMs: 200,
        checks: 2,
        degraded: 0,
        down: 0,
        maxMs: 300,
        minMs: 100,
      },
    ]);
  });

  test("the hourly chart reads the rollups where a day is sealed and the head rows where it is not", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const sealedRows = every(a.id, d, 72, 20 * minuteMs);
    const openRows = every(a.id, d + dayMs, 6, 20 * minuteMs);
    await recorded(checks, [...sealedRows, ...openRows]);
    await checks.seal(a.id, d, limit, []);
    const buckets = await checks.series(
      a.id,
      d,
      d + dayMs + 2 * hourMs,
      2 * hourMs,
      "hourly"
    );
    expect(buckets).toHaveLength(13);
    expect(buckets.map((bucket) => bucket.checks)).toEqual(
      Array.from({ length: 13 }, () => 6)
    );
    expect(buckets.reduce((sum, bucket) => sum + bucket.down, 0)).toBe(
      [...sealedRows, ...openRows].filter((row) => row.result === "down").length
    );
  });

  test("the rollups read one span of one monitor inside the range, oldest first", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    await recorded(checks, [
      ...every(a.id, d, 72, 20 * minuteMs),
      ...every(b.id, d, 72, 20 * minuteMs),
    ]);
    await checks.seal(a.id, d, limit, []);
    await checks.seal(b.id, d, limit, []);
    const hours = await checks.rollups(
      a.id,
      "hour",
      d + hourMs,
      d + 3 * hourMs
    );
    expect(hours.map((row) => [row.monitorId, row.at])).toEqual([
      [a.id, d + hourMs],
      [a.id, d + 2 * hourMs],
    ]);
    expect(await checks.rollups(a.id, "day", d + 1, d + dayMs)).toEqual([]);
  });

  test("the rollups of many monitors read at once, each monitor's oldest first; one with none and one not asked for are left out", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    const quiet = await monitors.create({ ...site, name: "Quiet" });
    const unasked = await monitors.create({ ...site, name: "Unasked" });
    await recorded(checks, [
      ...every(a.id, d, 72, 20 * minuteMs),
      ...every(b.id, d, 72, 20 * minuteMs),
      ...every(unasked.id, d, 72, 20 * minuteMs),
    ]);
    await checks.seal(a.id, d, limit, []);
    await checks.seal(b.id, d, limit, []);
    await checks.seal(unasked.id, d, limit, []);
    const hours = await checks.rollupsOf(
      [a.id, b.id, quiet.id],
      "hour",
      d + hourMs,
      d + 3 * hourMs
    );
    expect(
      Object.fromEntries(
        [...hours].map(([id, each]) => [
          id,
          each.map((row) => [row.monitorId, row.at]),
        ])
      )
    ).toEqual({
      [a.id]: [
        [a.id, d + hourMs],
        [a.id, d + 2 * hourMs],
      ],
      [b.id]: [
        [b.id, d + hourMs],
        [b.id, d + 2 * hourMs],
      ],
    });
    expect(
      (await checks.rollupsOf([a.id], "day", d, d + dayMs)).get(a.id)
    ).toEqual(await checks.rollups(a.id, "day", d, d + dayMs));
    expect(await checks.rollupsOf([], "day", d, d + dayMs)).toEqual(new Map());
  });

  test("the checks of many monitors read at once, each from its own start, head rows and sealed days merged; one with none and one not asked for are left out", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    const quiet = await monitors.create({ ...site, name: "Quiet" });
    const unasked = await monitors.create({ ...site, name: "Unasked" });
    const sealedRows = every(a.id, d, 72, 20 * minuteMs);
    const openRows = [
      up(a.id, d + dayMs + 10 * minuteMs),
      up(a.id, d + dayMs + 30 * minuteMs),
    ];
    const bRows = [
      up(b.id, d + dayMs + 5 * minuteMs),
      up(b.id, d + dayMs + 25 * minuteMs),
      up(b.id, d + dayMs + 45 * minuteMs),
    ];
    await recorded(checks, [
      ...sealedRows,
      ...openRows,
      ...bRows,
      up(unasked.id, d + dayMs + 15 * minuteMs),
    ]);
    await checks.seal(a.id, d, limit, []);
    const read = await checks.ranges(
      new Map([
        [a.id, d + 23 * hourMs],
        [b.id, d + dayMs + 25 * minuteMs],
        [quiet.id, d],
      ]),
      d + dayMs + 45 * minuteMs
    );
    expect(Object.fromEntries(read)).toEqual({
      [a.id]: [...sealedRows.slice(69), ...openRows],
      [b.id]: bRows.slice(1, 2),
    });
    expect(read.get(a.id)).toEqual(
      await checks.range(a.id, d + 23 * hourMs, d + dayMs + 45 * minuteMs)
    );
    expect(await checks.ranges(new Map(), d + dayMs)).toEqual(new Map());
  });

  test("deleting a monitor deletes its sealed days and rollups", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, every(a.id, d, 3, 20 * minuteMs));
    await checks.seal(a.id, d, limit, []);
    await monitors.remove([a.id]);
    expect(await rowCount(location, "sealed_days")).toBe(0);
    expect(await rowCount(location, "hourly_rollups")).toBe(0);
    expect(await rowCount(location, "daily_rollups")).toBe(0);
  });

  test("a sealed day this version cannot read is reported by its monitor, not as checks", async () => {
    const { checks, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, every(a.id, d, 3, 20 * minuteMs));
    await checks.seal(a.id, d, limit, []);
    await corruptChunk(location);
    await expect(checks.range(a.id, d, d + dayMs)).rejects.toMatchObject({
      monitorId: a.id,
      name: "CheckShapeError",
    });
  });

  test("sealing a day reads its neighbours from sealed days too: the last check of the day before, and on a rerun the first check of a sealed day after", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    // Day d runs from 00:10 to 23:50; the day before ends at 23:40 and the day after starts at 00:30.
    await recorded(checks, [
      ...every(a.id, d - dayMs, 72, 20 * minuteMs),
      ...every(a.id, d + 10 * minuteMs, 72, 20 * minuteMs),
      up(a.id, d + dayMs + 30 * minuteMs),
    ]);
    await checks.seal(a.id, d - dayMs, limit, []);
    await checks.seal(a.id, d, limit, []);
    const [first] = await checks.rollups(a.id, "day", d, d + dayMs);
    expect(first?.observedMs).toBe(dayMs);
    // With the day after sealed and a 35-minute limit, the 40 minutes from 23:50 to 00:30 are no data.
    await checks.seal(a.id, d + dayMs, limit, []);
    await recorded(checks, [up(a.id, d + 5 * minuteMs)]);
    await checks.seal(a.id, d, 35 * minuteMs, []);
    const [rerun] = await checks.rollups(a.id, "day", d, d + dayMs);
    expect(rerun?.observedMs).toBe(dayMs - 10 * minuteMs);
  });

  test("the recent checks reach back across sealed days when the head is empty", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const older = every(a.id, d - dayMs, 2, hourMs);
    const newer = every(a.id, d, 2, hourMs);
    await recorded(checks, [...older, ...newer]);
    await checks.seal(a.id, d - dayMs, limit, []);
    await checks.seal(a.id, d, limit, []);
    expect(await checks.recent(a.id, 3)).toEqual([
      ...newer.toReversed(),
      ...older.slice(1),
    ]);
  });

  test("a read that starts inside a sealed day leaves out that day's earlier checks", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    await recorded(checks, every(a.id, d, 72, 20 * minuteMs));
    await checks.seal(a.id, d, limit, []);
    const from = d + 12 * hourMs;
    expect(await checks.coverage(a.id, from, d + dayMs, limit)).toEqual({
      first: from,
      gaps: [],
      last: d + 23 * hourMs + 40 * minuteMs,
    });
    const buckets = await checks.series(a.id, from, d + dayMs, hourMs, "raw");
    expect(buckets.reduce((sum, bucket) => sum + bucket.checks, 0)).toBe(36);
  });

  test("a heartbeat monitor's sealed day keeps checks with no response time, and its rollups store none", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create({
      ...site,
      config: {
        schedule: { everyMs: hourMs, kind: "every" },
        type: "heartbeat",
      },
    });
    const beats: Check[] = Array.from({ length: 3 }, (_, index) => ({
      attempts: 1,
      bytes: 0,
      monitorId: a.id,
      reason: index === 1 ? reasons.heartbeat_late : reasons.ok,
      responseMs: undefined,
      result: index === 1 ? "down" : "up",
      startedAt: d + index * hourMs,
      statusCode: undefined,
    }));
    await recorded(checks, beats);
    await checks.seal(a.id, d, 2 * hourMs, []);
    expect(await checks.range(a.id, d, d + dayMs)).toEqual(beats);
    const [daily] = await checks.rollups(a.id, "day", d, d + dayMs);
    expect(daily).toMatchObject({
      averageMs: undefined,
      checks: 3,
      failed: 1,
      maxMs: undefined,
      minMs: undefined,
    });
  });

  test("on Postgres, a check written into a day while the day is being sealed is never lost: it is sealed or stays in the head", async () => {
    const { checks, location, monitors } = await repositories();
    if (location.backend !== "postgres" || !open) {
      return;
    }
    const a = await monitors.create(site);
    await recorded(checks, every(a.id, d, 6, 20 * minuteMs));
    // After every statement of the seal, another connection writes one more check of the day.
    const run = executor(open.connection);
    const written: number[] = [];
    const writeOne = async () => {
      const startedAt = d + 5 * hourMs + written.length;
      written.push(startedAt);
      await runSql(
        location,
        "INSERT INTO checks (monitor_id, started_at, result, response_ms, status_code, reason, attempts, bytes) VALUES (?, ?, 0, 100, 200, 0, 1, 10)",
        [a.id, startedAt]
      );
    };
    const racing = (tx: Executor): Executor => ({
      ...tx,
      rows: async <T>(query: Parameters<Executor["rows"]>[0]): Promise<T[]> => {
        const rows = await tx.rows<T>(query);
        await writeOne();
        return rows;
      },
      run: async (query) => {
        const changed = await tx.run(query);
        await writeOne();
        return changed;
      },
    });
    const raced = checksRepository({
      ...run,
      transaction: (work) => run.transaction((tx) => work(racing(tx))),
    });
    await raced.seal(a.id, d, limit, []);
    const kept = new Set(
      (await checks.range(a.id, d, d + dayMs)).map((check) => check.startedAt)
    );
    expect(written.filter((startedAt) => !kept.has(startedAt))).toEqual([]);
    expect(kept.size).toBe(6 + written.length);
  });

  test("the latest check is the newest one even when the head holds only a check older than the newest sealed day", async () => {
    const { checks, monitors } = await repositories();
    const a = await monitors.create(site);
    const sealedRows = every(a.id, d, 4, hourMs);
    await recorded(checks, sealedRows);
    await checks.seal(a.id, d, limit, []);
    // Written late into the day before, after d was sealed.
    await recorded(checks, [up(a.id, d - dayMs + hourMs)]);
    expect(await checks.latest()).toEqual(sealedRows.slice(3));
  });

  /** The repository over an executor whose first statement runs, then `meanwhile` runs to its end, then every later statement. */
  function midRead(run: Executor, meanwhile: () => Promise<unknown>) {
    let between: Promise<unknown> | undefined;
    const once = (): Promise<unknown> => {
      between ??= meanwhile();
      return between;
    };
    let first = true;
    return checksRepository({
      ...run,
      rows: async <T>(query: Parameters<Executor["rows"]>[0]): Promise<T[]> => {
        if (first) {
          first = false;
          const rows = await run.rows<T>(query);
          await once();
          return rows;
        }
        await once();
        return run.rows<T>(query);
      },
    });
  }

  test("a day sealed while a read is under way is read once, not lost: the range and the coverage", async () => {
    const { checks, monitors } = await repositories();
    if (!open) {
      return;
    }
    const a = await monitors.create(site);
    const rows = every(a.id, d, 6, 20 * minuteMs);
    await recorded(checks, rows);
    const run = executor(open.connection);
    const seal = () => checks.seal(a.id, d, limit, []);
    expect(await midRead(run, seal).range(a.id, d, d + dayMs)).toEqual(rows);
    await recorded(checks, [up(a.id, d + dayMs + 5)]);
    await checks.seal(a.id, d, limit, []);
    const other = every(a.id, d + dayMs + 10 * minuteMs, 3, 20 * minuteMs);
    await recorded(checks, other);
    const sealNext = () => checks.seal(a.id, d + dayMs, limit, []);
    expect(
      await midRead(run, sealNext).coverage(a.id, d, d + 2 * dayMs, limit)
    ).toEqual({
      first: d,
      gaps: [{ from: d + 100 * minuteMs, to: d + dayMs + 5 }],
      last: d + dayMs + 50 * minuteMs,
    });
  });

  /** Every row count of the history tables, by table. */
  async function counts(location: DatabaseLocation) {
    const tables = [
      "checks",
      "sealed_days",
      "hourly_rollups",
      "daily_rollups",
      "failure_details",
      "captures",
    ];
    const answer: Record<string, number> = {};
    for (const table of tables) {
      // biome-ignore lint/performance/noAwaitInLoops: one count at a time, on either backend
      const [row] = await runSql(
        location,
        `SELECT COUNT(*) AS n FROM ${table}`
      );
      answer[table] = Number(row?.n);
    }
    return answer;
  }

  /** One down check of each day, with its detail and capture, from `from` for `days` days, each day sealed but the open one. */
  async function history(
    checks: ChecksRepository,
    monitorId: string,
    from: number,
    days: number,
    openDay: number
  ): Promise<void> {
    for (let index = 0; index < days; index += 1) {
      const at = from + index * dayMs + hourMs;
      // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
      await checks.record(down(monitorId, at));
      await checks.record({
        capture: undefined,
        check: up(monitorId, at + hourMs),
        detail: undefined,
      });
      if (from + index * dayMs < openDay) {
        await checks.seal(monitorId, from + index * dayMs, limit, []);
      }
    }
  }

  describe("retention", () => {
    test("the purge deletes one monitor's history past its bounds, each tier by its own bound, and answers how many rows went", async () => {
      const { checks, location, monitors } = await repositories();
      const a = await monitors.create(site);
      const b = await monitors.create({ ...site, name: "Other" });
      await history(checks, a.id, d - 3 * dayMs, 4, d);
      await history(checks, b.id, d - 3 * dayMs, 4, d);
      const otherHours = (await checks.rollups(b.id, "hour", 0, d + dayMs))
        .length;
      const before = await counts(location);
      const deleted = await checks.purge(a.id, {
        daily: d - 3 * dayMs,
        hourly: d - 2 * dayMs,
        raw: d - dayMs,
      });
      const after = await counts(location);
      expect(deleted).toBe(
        Object.keys(before).reduce(
          (sum, table) => sum + (before[table] ?? 0) - (after[table] ?? 0),
          0
        )
      );
      // Raw: the days before d - 1 went, with their details and captures.
      expect(
        (await checks.range(a.id, 0, d + dayMs)).map((row) => row.startedAt)
      ).toEqual([
        d - dayMs + hourMs,
        d - dayMs + 2 * hourMs,
        d + hourMs,
        d + 2 * hourMs,
      ]);
      expect(await checks.detail(a.id, d - 2 * dayMs + hourMs)).toBeUndefined();
      expect(
        await checks.capture(a.id, d - 2 * dayMs + hourMs)
      ).toBeUndefined();
      expect(await checks.detail(a.id, d - dayMs + hourMs)).toBeDefined();
      expect(await checks.capture(a.id, d + hourMs)).toBeDefined();
      // Hourly: the day before d - 2 went; daily: nothing before d - 3 existed.
      const hours = await checks.rollups(a.id, "hour", 0, d + dayMs);
      expect(Math.min(...hours.map((row) => row.at))).toBeGreaterThanOrEqual(
        d - 2 * dayMs
      );
      // Past the raw bound, the day before it keeps its hourly rollups.
      expect(
        hours.some((row) => row.at >= d - 2 * dayMs && row.at < d - dayMs)
      ).toBe(true);
      expect(
        (await checks.rollups(a.id, "day", 0, d + dayMs)).map((row) => row.at)
      ).toEqual([d - 3 * dayMs, d - 2 * dayMs, d - dayMs]);
      // The other monitor keeps everything.
      expect(await checks.range(b.id, 0, d + dayMs)).toHaveLength(8);
      expect(await checks.rollups(b.id, "hour", 0, d + dayMs)).toHaveLength(
        otherHours
      );
      expect(await checks.detail(b.id, d - 3 * dayMs + hourMs)).toBeDefined();
    });

    test("the purge takes head rows past the raw bound that were never sealed, and keeps today's", async () => {
      const { checks, monitors } = await repositories();
      const a = await monitors.create(site);
      await recorded(checks, [up(a.id, d - 2 * dayMs + 5), up(a.id, d + 5)]);
      expect(
        await checks.purge(a.id, {
          daily: d - dayMs,
          hourly: d - dayMs,
          raw: d - dayMs,
        })
      ).toBe(1);
      expect(await checks.range(a.id, 0, d + dayMs)).toEqual([up(a.id, d + 5)]);
    });

    test("a purge with nothing past its bounds deletes nothing and answers zero", async () => {
      const { checks, location, monitors } = await repositories();
      const a = await monitors.create(site);
      await history(checks, a.id, d - dayMs, 2, d);
      const before = await counts(location);
      expect(
        await checks.purge(a.id, {
          daily: d - dayMs,
          hourly: d - dayMs,
          raw: d - dayMs,
        })
      ).toBe(0);
      expect(await counts(location)).toEqual(before);
    });
  });

  describe("the size budget's delete", () => {
    test("takes the oldest raw day across every monitor first, then the next, with their details and captures", async () => {
      const { checks, monitors } = await repositories();
      const a = await monitors.create(site);
      const b = await monitors.create({ ...site, name: "Other" });
      await history(checks, a.id, d - dayMs, 2, d);
      await history(checks, b.id, d - 2 * dayMs, 3, d);
      const first = await checks.dropOldest(d);
      expect(first).toMatchObject({ day: d - 2 * dayMs, tier: "raw" });
      expect(first?.rows).toBeGreaterThan(0);
      expect(await checks.range(b.id, 0, d - dayMs)).toEqual([]);
      expect(await checks.detail(b.id, d - 2 * dayMs + hourMs)).toBeUndefined();
      expect(
        await checks.capture(b.id, d - 2 * dayMs + hourMs)
      ).toBeUndefined();
      expect(await checks.range(a.id, 0, d)).toHaveLength(2);
      expect(await checks.dropOldest(d)).toMatchObject({
        day: d - dayMs,
        tier: "raw",
      });
      expect(await checks.range(a.id, 0, d)).toEqual([]);
      expect(await checks.range(b.id, 0, d)).toEqual([]);
      // Their rollups stay until the raw tier is empty.
      expect(await checks.rollups(b.id, "day", 0, d)).toHaveLength(2);
    });

    test("once no raw day is left, takes the hourly rollups a day at a time, then the daily ones, and then nothing; outages, certificate records and settings stay", async () => {
      const { checks, location, monitors } = await repositories();
      const a = await monitors.create(site);
      await history(checks, a.id, d - 2 * dayMs, 3, d);
      await runSql(
        location,
        "INSERT INTO outages (monitor_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?)",
        [
          a.id,
          d - 2 * dayMs + hourMs,
          d - 2 * dayMs + 2 * hourMs,
          reasons.timeout,
        ]
      );
      await runSql(
        location,
        "INSERT INTO certificate_records (monitor_id, subject, issuer, valid_from, valid_to, names, fingerprint, last_seen_at) VALUES (?, 'CN=example.test', 'CN=CA', ?, ?, '[]', 'AA', ?)",
        [a.id, d - 90 * dayMs, d + 90 * dayMs, d - 2 * dayMs]
      );
      const settingsBefore = await runSql(location, "SELECT key FROM settings");
      const taken: string[] = [];
      for (let round = 0; round < 7; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one round at a time, as the size guard deletes
        const dropped = await checks.dropOldest(d);
        taken.push(
          dropped ? `${dropped.tier} ${(dropped.day - d) / dayMs}` : "nothing"
        );
      }
      expect(taken).toEqual([
        "raw -2",
        "raw -1",
        "hourly -2",
        "hourly -1",
        "daily -2",
        "daily -1",
        "nothing",
      ]);
      expect(await checks.rollups(a.id, "hour", 0, d)).toEqual([]);
      expect(await checks.rollups(a.id, "day", 0, d)).toEqual([]);
      const [kept] = await runSql(
        location,
        "SELECT (SELECT COUNT(*) FROM outages) AS outages, (SELECT COUNT(*) FROM certificate_records) AS certificates"
      );
      expect([Number(kept?.outages), Number(kept?.certificates)]).toEqual([
        1, 1,
      ]);
      expect(await runSql(location, "SELECT key FROM settings")).toEqual(
        settingsBefore
      );
    });

    test("a closed day left unsealed in the head is taken before the sealed days after it", async () => {
      const { checks, monitors } = await repositories();
      const a = await monitors.create(site);
      await history(checks, a.id, d - dayMs, 1, d);
      await recorded(checks, [up(a.id, d - 3 * dayMs + 5)]);
      expect(await checks.dropOldest(d)).toMatchObject({
        day: d - 3 * dayMs,
        tier: "raw",
      });
      expect(await checks.dropOldest(d)).toMatchObject({
        day: d - dayMs,
        tier: "raw",
      });
    });

    test("never touches today's head rows: an unsealed closed day counts as a raw day, the open day does not", async () => {
      const { checks, monitors } = await repositories();
      const a = await monitors.create(site);
      await recorded(checks, [up(a.id, d - dayMs + 5), up(a.id, d + 5)]);
      expect(await checks.dropOldest(d)).toEqual({
        day: d - dayMs,
        rows: 1,
        tier: "raw",
      });
      expect(await checks.dropOldest(d)).toBeUndefined();
      expect(await checks.range(a.id, 0, d + dayMs)).toEqual([up(a.id, d + 5)]);
    });
  });
});

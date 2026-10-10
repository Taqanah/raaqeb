import { afterEach, describe, expect, test } from "bun:test";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import {
  type HeartbeatsRepository,
  heartbeatsRepository,
} from "./heartbeats.ts";
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

const tokenNumber = (n: number) => `token${String(n).padStart(17, "0")}`;

async function repositories(): Promise<{
  heartbeats: HeartbeatsRepository;
  location: DatabaseLocation;
  monitors: MonitorsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection, location: scratch.location };
  await migrateDatabase(connection);
  const run = executor(connection);
  let nextId = 0;
  let nextToken = 0;
  return {
    heartbeats: heartbeatsRepository(run),
    location: scratch.location,
    monitors: monitorsRepository(
      run,
      () => 1_700_000_000_000,
      () => {
        nextId += 1;
        return `id-${String(nextId).padStart(3, "0")}`;
      },
      () => {
        nextToken += 1;
        return tokenNumber(nextToken);
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

const beat: MonitorInput = {
  config: {
    schedule: { everyMs: 300_000, kind: "every" },
    type: "heartbeat",
  },
  intervalMs: 60_000,
  name: "Backup",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

const t0 = 1_700_000_000_000;

async function rowCount(location: DatabaseLocation): Promise<number> {
  const [row] = await runSql(location, "SELECT count(*) AS n FROM heartbeats");
  return Number(row?.n);
}

describe("the heartbeats repository", () => {
  test("a heartbeat for a known token is stored with its arrival time and source address, and answers the monitor", async () => {
    const { heartbeats, monitors } = await repositories();
    const { id } = await monitors.create(beat);
    expect(await heartbeats.record(tokenNumber(1), t0, "203.0.113.7")).toBe(id);
    expect(await heartbeats.latest([id])).toEqual(
      new Map([[id, { arrivedAt: t0, sourceIp: "203.0.113.7" }]])
    );
  });

  test("an unknown token stores nothing and answers nothing", async () => {
    const { heartbeats, location, monitors } = await repositories();
    await monitors.create(beat);
    expect(
      await heartbeats.record(tokenNumber(9), t0, undefined)
    ).toBeUndefined();
    expect(await rowCount(location)).toBe(0);
  });

  test("a heartbeat with no source address keeps none", async () => {
    const { heartbeats, monitors } = await repositories();
    const { id } = await monitors.create(beat);
    await heartbeats.record(tokenNumber(1), t0, undefined);
    expect((await heartbeats.latest([id])).get(id)).toEqual({
      arrivedAt: t0,
      sourceIp: undefined,
    });
  });

  test("a paused monitor's heartbeat is still stored", async () => {
    const { heartbeats, location, monitors } = await repositories();
    const { id } = await monitors.create(beat);
    await monitors.pause([id]);
    expect(await heartbeats.record(tokenNumber(1), t0, undefined)).toBe(id);
    expect(await rowCount(location)).toBe(1);
  });

  test("two heartbeats in the same millisecond are one row, and the second still answers the monitor", async () => {
    const { heartbeats, location, monitors } = await repositories();
    const { id } = await monitors.create(beat);
    await heartbeats.record(tokenNumber(1), t0, "203.0.113.7");
    expect(await heartbeats.record(tokenNumber(1), t0, "203.0.113.8")).toBe(id);
    expect(await rowCount(location)).toBe(1);
  });

  test("the latest heartbeat is the newest of each monitor asked about; a monitor with none is absent", async () => {
    const { heartbeats, monitors } = await repositories();
    const a = await monitors.create(beat);
    const b = await monitors.create(beat);
    const c = await monitors.create(beat);
    await heartbeats.record(tokenNumber(1), t0 + 2, "a2");
    await heartbeats.record(tokenNumber(1), t0 + 1, "a1");
    await heartbeats.record(tokenNumber(2), t0 + 5, "b");
    expect(await heartbeats.latest([a.id, c.id])).toEqual(
      new Map([[a.id, { arrivedAt: t0 + 2, sourceIp: "a2" }]])
    );
    expect(await heartbeats.latest([])).toEqual(new Map());
    expect((await heartbeats.latest([b.id])).get(b.id)?.arrivedAt).toBe(t0 + 5);
  });

  test("the latest heartbeat before a time leaves out the ones at or after it", async () => {
    const { heartbeats, monitors } = await repositories();
    const a = await monitors.create(beat);
    await heartbeats.record(tokenNumber(1), t0, "early");
    await heartbeats.record(tokenNumber(1), t0 + 10, "late");
    expect((await heartbeats.latest([a.id], t0 + 10)).get(a.id)?.sourceIp).toBe(
      "early"
    );
    expect((await heartbeats.latest([a.id], t0)).size).toBe(0);
  });

  test("pruning keeps the monitor's newest heartbeats and leaves other monitors alone", async () => {
    const { heartbeats, location, monitors } = await repositories();
    const a = await monitors.create(beat);
    await monitors.create(beat);
    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await heartbeats.record(tokenNumber(1), t0 + i, undefined);
    }
    await heartbeats.record(tokenNumber(2), t0, undefined);
    await heartbeats.prune(a.id, 2);
    const rows = await runSql(
      location,
      `SELECT arrived_at AS at FROM heartbeats WHERE monitor_id = '${a.id}' ORDER BY arrived_at`
    );
    expect(rows.map((row) => Number(row.at))).toEqual([t0 + 3, t0 + 4]);
    expect(await rowCount(location)).toBe(3);
  });

  test("pruning a monitor with fewer heartbeats than it keeps deletes nothing", async () => {
    const { heartbeats, location, monitors } = await repositories();
    const a = await monitors.create(beat);
    await heartbeats.record(tokenNumber(1), t0, undefined);
    await heartbeats.prune(a.id, 100);
    expect(await rowCount(location)).toBe(1);
  });

  test("deleting a monitor deletes its heartbeats", async () => {
    const { heartbeats, location, monitors } = await repositories();
    const a = await monitors.create(beat);
    await heartbeats.record(tokenNumber(1), t0, undefined);
    await monitors.remove([a.id]);
    expect(await rowCount(location)).toBe(0);
  });

  test("a renewed token no longer records, and the new one does", async () => {
    const { heartbeats, monitors } = await repositories();
    const a = await monitors.create(beat);
    await monitors.update(a.id, beat, undefined, { renewHeartbeatToken: true });
    expect(
      await heartbeats.record(tokenNumber(1), t0, undefined)
    ).toBeUndefined();
    expect(await heartbeats.record(tokenNumber(2), t0, undefined)).toBe(a.id);
  });
});

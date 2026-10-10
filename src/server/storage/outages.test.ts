import { afterEach, describe, expect, test } from "bun:test";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import {
  OutageShapeError,
  type OutagesRepository,
  outagesRepository,
} from "./outages.ts";
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
  location: DatabaseLocation;
  monitors: MonitorsRepository;
  outages: OutagesRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection, location: scratch.location };
  await migrateDatabase(connection);
  const run = executor(connection);
  let nextId = 0;
  return {
    location: scratch.location,
    monitors: monitorsRepository(
      run,
      () => 1_700_000_000_000,
      () => {
        nextId += 1;
        return `id-${String(nextId).padStart(3, "0")}`;
      }
    ),
    outages: outagesRepository(run),
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

describe("the outages repository", () => {
  test("the first confirmed down check opens an outage; while it is open, another down check opens none", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    expect(await outages.open(id, t0, reasons.timeout)).toBe(true);
    expect(
      await outages.open(id, t0 + 60_000, reasons.connection_refused)
    ).toBe(false);
    expect(await outages.ongoing()).toEqual([
      {
        endedAt: undefined,
        monitorId: id,
        reason: reasons.timeout,
        startedAt: t0,
      },
    ]);
  });

  test("the first recovered check closes the outage, which keeps the reason it opened with", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await outages.open(id, t0, reasons.timeout);
    expect(await outages.close(id, t0 + 120_000)).toEqual({
      endedAt: t0 + 120_000,
      monitorId: id,
      reason: reasons.timeout,
      startedAt: t0,
    });
    expect(await outages.ongoing()).toEqual([]);
    expect(await outages.list(id)).toEqual([
      {
        endedAt: t0 + 120_000,
        monitorId: id,
        reason: reasons.timeout,
        startedAt: t0,
      },
    ]);
  });

  test("closing with no open outage does nothing and says so", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    expect(await outages.close(id, t0)).toBeUndefined();
    await outages.open(id, t0, reasons.timeout);
    await outages.close(id, t0 + 1);
    expect(await outages.close(id, t0 + 2)).toBeUndefined();
    expect(await outages.list(id)).toHaveLength(1);
  });

  test("a paused monitor gets no outage: paused time is never downtime", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await monitors.pause([id]);
    expect(await outages.open(id, t0, reasons.timeout)).toBe(false);
    expect(await outages.list(id)).toEqual([]);
  });

  test("a check that started before the monitor's last change opens no outage: it does not speak for the monitor as it is now", async () => {
    const { monitors, outages } = await repositories();
    const { id, updatedAt } = await monitors.create(site);
    expect(await outages.open(id, updatedAt - 1, reasons.timeout)).toBe(false);
    expect(await outages.open(id, updatedAt, reasons.timeout)).toBe(true);
  });

  test("a monitor that does not exist gets no outage", async () => {
    const { outages } = await repositories();
    expect(await outages.open("nobody", t0, reasons.timeout)).toBe(false);
  });

  test("ongoing lists the open outage of every monitor; list answers one monitor's outages, newest first", async () => {
    const { monitors, outages } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "API" });
    await outages.open(a.id, t0, reasons.timeout);
    await outages.close(a.id, t0 + 1000);
    await outages.open(a.id, t0 + 5000, reasons.unexpected_status);
    await outages.open(b.id, t0 + 2000, reasons.dns_failed);
    expect(
      (await outages.ongoing()).map((o) => [o.monitorId, o.startedAt])
    ).toEqual([
      [a.id, t0 + 5000],
      [b.id, t0 + 2000],
    ]);
    expect((await outages.list(a.id)).map((o) => o.startedAt)).toEqual([
      t0 + 5000,
      t0,
    ]);
    expect(await outages.list(b.id)).toHaveLength(1);
  });

  test("the outages of a window are those still open or ended after its start, newest first", async () => {
    const { monitors, outages } = await repositories();
    const a = await monitors.create(site);
    await outages.open(a.id, t0, reasons.timeout);
    await outages.close(a.id, t0 + 1000);
    await outages.open(a.id, t0 + 5000, reasons.timeout);
    await outages.close(a.id, t0 + 6000);
    await outages.open(a.id, t0 + 9000, reasons.timeout);
    expect(
      (await outages.list(a.id, t0 + 1000)).map((o) => o.startedAt)
    ).toEqual([t0 + 9000, t0 + 5000]);
    expect(
      (await outages.list(a.id, t0 + 999)).map((o) => o.startedAt)
    ).toEqual([t0 + 9000, t0 + 5000, t0]);
    expect(
      (await outages.list(a.id, t0 + 100_000)).map((o) => o.startedAt)
    ).toEqual([t0 + 9000]);
  });

  test("the outages of many monitors since one time read at once, each monitor's newest first; a monitor with none and one not asked for are left out", async () => {
    const { monitors, outages } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "API" });
    const quiet = await monitors.create({ ...site, name: "Quiet" });
    const other = await monitors.create({ ...site, name: "Other" });
    await outages.open(a.id, t0, reasons.timeout);
    await outages.close(a.id, t0 + 1000);
    await outages.open(a.id, t0 + 5000, reasons.timeout);
    await outages.close(a.id, t0 + 6000);
    await outages.open(a.id, t0 + 9000, reasons.timeout);
    await outages.open(b.id, t0 + 2000, reasons.dns_failed);
    await outages.open(other.id, t0 + 3000, reasons.timeout);
    const read = await outages.since([a.id, b.id, quiet.id], t0 + 1000);
    expect(
      Object.fromEntries(
        [...read].map(([id, each]) => [id, each.map((o) => o.startedAt)])
      )
    ).toEqual({ [a.id]: [t0 + 9000, t0 + 5000], [b.id]: [t0 + 2000] });
    expect(await outages.since([], t0)).toEqual(new Map());
  });

  test("an outage lives as long as its monitor: deleting the monitor deletes it, nothing else does", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await outages.open(id, t0, reasons.timeout);
    await monitors.remove([id]);
    expect(await outages.ongoing()).toEqual([]);
  });

  test("a stored reason this version does not know throws, naming the outage and never the row", async () => {
    const { location, monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await runSql(
      location,
      "INSERT INTO outages (monitor_id, started_at, ended_at, reason) VALUES (?, ?, NULL, ?)",
      [id, t0, 999]
    );
    const failure = await outages.list(id).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(OutageShapeError);
    expect((failure as OutageShapeError).monitorId).toBe(id);
    expect((failure as OutageShapeError).startedAt).toBe(t0);
    expect((failure as OutageShapeError).message).not.toContain("999");
  });
});

describe('acknowledging an outage (CONTEXT.md "Acknowledge")', () => {
  test("records when the open outage was acknowledged; it stays open with the reason it opened with", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await outages.open(id, t0, reasons.timeout);
    const acknowledged = {
      acknowledgedAt: t0 + 5 * 60_000,
      endedAt: undefined,
      monitorId: id,
      reason: reasons.timeout,
      startedAt: t0,
    };
    expect(await outages.acknowledge(id, t0, t0 + 5 * 60_000)).toEqual(
      acknowledged
    );
    expect(await outages.ongoing()).toEqual([acknowledged]);
    expect(await outages.list(id)).toEqual([acknowledged]);
    expect(await outages.since([id], t0)).toEqual(
      new Map([[id, [acknowledged]]])
    );
  });

  test("an outage acknowledged once is not acknowledged again: the first time stands", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await outages.open(id, t0, reasons.timeout);
    await outages.acknowledge(id, t0, t0 + 1000);
    expect(await outages.acknowledge(id, t0, t0 + 2000)).toBeUndefined();
    expect((await outages.list(id))[0]?.acknowledgedAt).toBe(t0 + 1000);
  });

  test("with no open outage there is nothing to acknowledge: a monitor never down, one recovered, one that does not exist", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    expect(await outages.acknowledge(id, t0, t0)).toBeUndefined();
    await outages.open(id, t0, reasons.timeout);
    await outages.close(id, t0 + 1000);
    expect(await outages.acknowledge(id, t0, t0 + 2000)).toBeUndefined();
    // Strict: toEqual takes an empty list for one of undefined items.
    expect(
      (await outages.list(id)).map((each) => each.acknowledgedAt)
    ).toStrictEqual([undefined]);
    expect(await outages.acknowledge("nobody", t0, t0)).toBeUndefined();
  });

  test("an acknowledged outage closes as usual and keeps when it was acknowledged; the next outage starts unacknowledged", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await outages.open(id, t0, reasons.timeout);
    await outages.acknowledge(id, t0, t0 + 1000);
    expect(await outages.close(id, t0 + 2000)).toEqual({
      acknowledgedAt: t0 + 1000,
      endedAt: t0 + 2000,
      monitorId: id,
      reason: reasons.timeout,
      startedAt: t0,
    });
    await outages.open(id, t0 + 3000, reasons.timeout);
    const [next, closed] = await outages.list(id);
    expect(next?.acknowledgedAt).toBeUndefined();
    expect(closed?.acknowledgedAt).toBe(t0 + 1000);
  });

  test("acknowledges only the outage the screen showed: one that recovered leaves the outage opened since unacknowledged", async () => {
    const { monitors, outages } = await repositories();
    const { id } = await monitors.create(site);
    await outages.open(id, t0, reasons.timeout);
    await outages.close(id, t0 + 1000);
    await outages.open(id, t0 + 2000, reasons.timeout);
    expect(await outages.acknowledge(id, t0, t0 + 3000)).toBeUndefined();
    expect(
      (await outages.list(id)).map((each) => each.acknowledgedAt)
    ).toStrictEqual([undefined, undefined]);
  });

  test("acknowledging one monitor's outage leaves another's alone", async () => {
    const { monitors, outages } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "API" });
    await outages.open(a.id, t0, reasons.timeout);
    await outages.open(b.id, t0, reasons.timeout);
    await outages.acknowledge(a.id, t0, t0 + 1000);
    expect(
      (await outages.list(b.id)).map((each) => each.acknowledgedAt)
    ).toStrictEqual([undefined]);
  });
});

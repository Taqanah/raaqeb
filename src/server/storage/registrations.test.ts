import { afterEach, describe, expect, test } from "bun:test";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import type { DomainRegistration } from "@/shared/schemas/registration.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import {
  type RegistrationsRepository,
  registrationsRepository,
} from "./registrations.ts";
import type { DatabaseLocation } from "./storage.ts";

let open:
  | {
      connection: Connection;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

const database: MonitorInput = {
  config: { host: "db.raaqeb.dev", port: 5432, type: "tcp" },
  intervalMs: 60_000,
  name: "Database",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

async function repositories(): Promise<{
  location: DatabaseLocation;
  monitors: MonitorsRepository;
  registrations: RegistrationsRepository;
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
    registrations: registrationsRepository(run),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const day = 86_400_000;
const now = 1_700_000_000_000;

function read(
  monitorId: string,
  more: Partial<DomainRegistration> = {}
): Omit<DomainRegistration, "warned"> {
  return {
    domain: "raaqeb.dev",
    expiresAt: now + 300 * day,
    monitorId,
    readAt: now,
    ...more,
  };
}

async function rowCount(location: DatabaseLocation): Promise<number> {
  const [row] = await runSql(
    location,
    "SELECT count(*) AS n FROM domain_registrations"
  );
  return Number(row?.n);
}

describe("the domain registrations", () => {
  test("a stored registration reads back whole with no warning, and a monitor without one reads as nothing", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    expect(await registrations.find(a.id)).toEqual({
      ...read(a.id),
      warned: false,
    });
    expect(await registrations.find("missing")).toBeUndefined();
  });

  test("a registration with neither a domain nor an expiry date reads back as unknown", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(
      read(a.id, { domain: undefined, expiresAt: undefined })
    );
    expect(await registrations.find(a.id)).toEqual({
      domain: undefined,
      expiresAt: undefined,
      monitorId: a.id,
      readAt: now,
      warned: false,
    });
  });

  test("a new read replaces the monitor's previous registration whole, leaving one row", async () => {
    const { location, monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    const later = read(a.id, {
      domain: "example.com",
      expiresAt: now + 400 * day,
      readAt: now + day,
    });
    await registrations.replace(later);
    expect(await registrations.find(a.id)).toEqual({ ...later, warned: false });
    expect(await rowCount(location)).toBe(1);
  });

  test("the list holds every monitor's registration", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    const b = await monitors.create({ ...database, name: "Other" });
    await registrations.replace(read(a.id));
    await registrations.replace(read(b.id, { expiresAt: undefined }));
    const listed = await registrations.list();
    expect(
      listed.toSorted((x, y) => x.monitorId.localeCompare(y.monitorId))
    ).toEqual([
      { ...read(a.id), warned: false },
      { ...read(b.id, { expiresAt: undefined }), warned: false },
    ]);
  });

  test("removing a registration leaves the monitor without one; removing twice is fine", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    await registrations.remove(a.id);
    await registrations.remove(a.id);
    expect(await registrations.find(a.id)).toBeUndefined();
  });

  test("deleting the monitor deletes its registration", async () => {
    const { location, monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    await monitors.remove([a.id]);
    expect(await rowCount(location)).toBe(0);
  });
});

describe("the warning a registration got", () => {
  test("a warning sent is remembered with the expiry date and reads back", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    expect(await registrations.warned(a.id, now + 300 * day)).toBe(true);
    expect(await registrations.find(a.id)).toEqual({
      ...read(a.id),
      warned: true,
    });
    expect((await registrations.list())[0]?.warned).toBe(true);
  });

  test("a later read with the same expiry date keeps the warning it got", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    await registrations.warned(a.id, now + 300 * day);
    await registrations.replace(read(a.id, { readAt: now + day }));
    expect(await registrations.find(a.id)).toEqual({
      ...read(a.id, { readAt: now + day }),
      warned: true,
    });
  });

  test("a renewed registration, with a new expiry date, starts over with no warning", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    await registrations.warned(a.id, now + 300 * day);
    await registrations.replace(read(a.id, { expiresAt: now + 665 * day }));
    expect((await registrations.find(a.id))?.warned).toBe(false);
  });

  test("a read that lost its expiry date starts over with no warning", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    await registrations.replace(read(a.id));
    await registrations.warned(a.id, now + 300 * day);
    await registrations.replace(read(a.id, { expiresAt: undefined }));
    expect((await registrations.find(a.id))?.warned).toBe(false);
  });

  test("a warning for an expiry date that is no longer the monitor's is not recorded", async () => {
    const { monitors, registrations } = await repositories();
    const a = await monitors.create(database);
    expect(await registrations.warned(a.id, now + 300 * day)).toBe(false);
    await registrations.replace(read(a.id, { expiresAt: now + 665 * day }));
    expect(await registrations.warned(a.id, now + 300 * day)).toBe(false);
    expect((await registrations.find(a.id))?.warned).toBe(false);
  });
});

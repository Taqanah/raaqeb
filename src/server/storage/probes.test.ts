import { afterEach, describe, expect, test } from "bun:test";
import {
  type MonitorInput,
  mainLocation,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import { type ProbesRepository, probesRepository } from "./probes.ts";

let open: { cleanup: () => Promise<void>; connection: Connection } | undefined;

let clock = 1_700_000_000_000;

async function repositories(): Promise<{
  monitors: MonitorsRepository;
  probes: ProbesRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  await migrateDatabase(connection);
  const run = executor(connection);
  let nextId = 0;
  const newId = () => {
    nextId += 1;
    return `id-${String(nextId).padStart(3, "0")}`;
  };
  return {
    monitors: monitorsRepository(run, () => clock, newId),
    probes: probesRepository(run, () => clock, newId),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

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
  name: "الموقع",
  retries: 2,
  tags: [],
  timeoutMs: 10_000,
};

describe("the probes repository", () => {
  test("a probe is stored with its name and creation time, and its token's hash never comes back", async () => {
    const { probes } = await repositories();
    clock = 1_700_000_000_000;
    const made = await probes.create("Frankfurt", "a".repeat(64));
    expect(made).toEqual({
      createdAt: 1_700_000_000_000,
      id: "id-001",
      lastSeenAt: undefined,
      name: "Frankfurt",
      roundTripMs: undefined,
      version: undefined,
    });
    expect(JSON.stringify(await probes.list())).not.toContain("a".repeat(64));
  });

  test("probes list in the order they were made", async () => {
    const { probes } = await repositories();
    clock = 2000;
    await probes.create("Riyadh", "b".repeat(64));
    clock = 1000;
    await probes.create("Frankfurt", "c".repeat(64));
    expect((await probes.list()).map((probe) => probe.name)).toEqual([
      "Frankfurt",
      "Riyadh",
    ]);
  });

  test("a probe is found by its token's hash, and a new token stops the old one", async () => {
    const { probes } = await repositories();
    const made = await probes.create("Frankfurt", "a".repeat(64));
    expect((await probes.byTokenHash("a".repeat(64)))?.id).toBe(made.id);
    expect((await probes.replaceToken(made.id, "d".repeat(64)))?.name).toBe(
      "Frankfurt"
    );
    expect(await probes.byTokenHash("a".repeat(64))).toBeUndefined();
    expect((await probes.byTokenHash("d".repeat(64)))?.id).toBe(made.id);
  });

  test("a new token for a probe that does not exist changes nothing", async () => {
    const { probes } = await repositories();
    expect(await probes.replaceToken("nope", "d".repeat(64))).toBeUndefined();
  });

  test("a probe's last contact keeps when, which build and its round trip", async () => {
    const { probes } = await repositories();
    const made = await probes.create("Frankfurt", "a".repeat(64));
    await probes.seen(made.id, {
      at: 1_700_000_050_000,
      roundTripMs: 42,
      version: "0.3.0",
    });
    expect((await probes.list())[0]).toMatchObject({
      lastSeenAt: 1_700_000_050_000,
      roundTripMs: 42,
      version: "0.3.0",
    });
  });

  test("deleting a probe answers whether it existed", async () => {
    const { probes } = await repositories();
    const made = await probes.create("Frankfurt", "a".repeat(64));
    expect(await probes.remove(made.id)).toBe(true);
    expect(await probes.remove(made.id)).toBe(false);
    expect(await probes.list()).toEqual([]);
  });
});

describe("a monitor's locations", () => {
  test("a monitor saved with no locations is checked from the main location alone, needing one confirmation, sharing nothing", async () => {
    const { monitors } = await repositories();
    const saved = await monitors.create(site);
    expect(saved.locations).toBeUndefined();
    expect(saved.confirmations).toBeUndefined();
    expect(saved.shareCredentials).toBeUndefined();
  });

  test("a monitor keeps its probes, the main location first, its confirmation count and its sharing", async () => {
    const { monitors, probes } = await repositories();
    const riyadh = await probes.create("Riyadh", "b".repeat(64));
    const frankfurt = await probes.create("Frankfurt", "c".repeat(64));
    const saved = await monitors.create({
      ...site,
      confirmations: 2,
      locations: [frankfurt.id, mainLocation, riyadh.id],
      shareCredentials: true,
    });
    expect(saved.locations).toEqual([mainLocation, riyadh.id, frankfurt.id]);
    expect(saved.confirmations).toBe(2);
    expect(saved.shareCredentials).toBe(true);
    expect((await monitors.list())[0]?.locations).toEqual(saved.locations);
  });

  test("a monitor may be checked from probes without the main location", async () => {
    const { monitors, probes } = await repositories();
    const frankfurt = await probes.create("Frankfurt", "c".repeat(64));
    const saved = await monitors.create({ ...site, locations: [frankfurt.id] });
    expect(saved.locations).toEqual([frankfurt.id]);
  });

  test("an edit replaces the monitor's locations", async () => {
    const { monitors, probes } = await repositories();
    const frankfurt = await probes.create("Frankfurt", "c".repeat(64));
    const saved = await monitors.create({
      ...site,
      locations: [mainLocation, frankfurt.id],
    });
    const edited = await monitors.update(saved.id, {
      ...site,
      locations: [mainLocation],
    });
    expect(edited?.locations).toBeUndefined();
  });

  test("a probe that does not exist is left out of a saved monitor's locations", async () => {
    const { monitors } = await repositories();
    const saved = await monitors.create({
      ...site,
      locations: [mainLocation, "gone"],
    });
    expect(saved.locations).toBeUndefined();
  });

  test("deleting a probe drops it from every monitor's locations, and a monitor it alone checked is checked from the main location", async () => {
    const { monitors, probes } = await repositories();
    const frankfurt = await probes.create("Frankfurt", "c".repeat(64));
    const riyadh = await probes.create("Riyadh", "b".repeat(64));
    const both = await monitors.create({
      ...site,
      locations: [mainLocation, frankfurt.id, riyadh.id],
    });
    const alone = await monitors.create({ ...site, locations: [frankfurt.id] });
    await probes.remove(frankfurt.id);
    expect((await monitors.find(both.id))?.locations).toEqual([
      mainLocation,
      riyadh.id,
    ]);
    expect((await monitors.find(alone.id))?.locations).toBeUndefined();
  });
});

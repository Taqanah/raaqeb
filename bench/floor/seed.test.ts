import { afterEach, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { decrypt, type InstallKey } from "@/server/boot/installkey.ts";
import { openCredentials } from "@/server/monitors/credentials.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import {
  capacityFleet,
  type FleetMember,
  fixedFleet,
  pageComponents,
} from "./fleet.ts";
import {
  historyBatch,
  type SeedOptions,
  seedInstall,
  syntheticDay,
} from "./seed.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    // biome-ignore lint/performance/noAwaitInLoops: one database a test
    await cleanup();
  }
});

async function scratch(): Promise<DatabaseLocation> {
  const { cleanup, location } = await scratchDatabase();
  cleanups.push(cleanup);
  return location;
}

async function reopen(location: DatabaseLocation): Promise<Storage> {
  const opened = await openStorage(location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  cleanups.unshift(() => opened.storage.close());
  return opened.storage;
}

const target = { host: "raaqeb-bench-target-1", ip: "172.18.0.2" };
const day = 86_400_000;
const yesterday = Date.UTC(2026, 9, 2);

const databases = {
  mysql: "mysql://raaqeb:raaqeb@raaqeb-bench-mysql-1:3306/raaqeb",
  postgres: "postgres://raaqeb:raaqeb@raaqeb-bench-postgres-1:5432/raaqeb",
  redis: "redis://:raaqeb@raaqeb-bench-redis-1:6379",
};

function fleet(monitors: number, intervalMs = 20_000): FleetMember[] {
  return fixedFleet({
    databases,
    failing: false,
    intervalMs,
    monitors,
    quiet: false,
    target,
  });
}

async function options(
  overrides: Partial<SeedOptions> & { key?: InstallKey } = {}
): Promise<SeedOptions> {
  return {
    channels: undefined,
    draftPage: false,
    fleet: fleet(20),
    history: undefined,
    incidents: false,
    key: await scratchInstallKey(),
    ...overrides,
  };
}

describe("seeding an install for the benchmark", () => {
  test("leaves the install past onboarding, with its operator account", async () => {
    const location = await scratch();
    await seedInstall(location, await options());
    const storage = await reopen(location);
    expect(await storage.operatorAccount.exists()).toBe(true);
  });

  test("stores the fleet in its order, active, with the ids in creation order", async () => {
    const location = await scratch();
    const members = fleet(20);
    const seeded = await seedInstall(
      location,
      await options({ fleet: members })
    );
    const monitors = await (await reopen(location)).monitors.list();
    expect(monitors.map((monitor) => monitor.name)).toEqual(
      members.map((member) => member.fields.name)
    );
    expect(monitors.map((monitor) => monitor.id)).toEqual([
      ...seeded.monitorIds,
    ]);
    expect(monitors.every((monitor) => !monitor.paused)).toBe(true);
  });

  test("stores the interval asked, even under the form's 20 s minimum", async () => {
    const location = await scratch();
    await seedInstall(location, await options({ fleet: fleet(20, 1000) }));
    const monitors = await (await reopen(location)).monitors.list();
    const checked = monitors.filter(
      (monitor) => monitor.config.type !== "heartbeat"
    );
    expect(checked.every((monitor) => monitor.intervalMs === 1000)).toBe(true);
  });

  test("answers each heartbeat monitor's token, the one its URL carries", async () => {
    const location = await scratch();
    const seeded = await seedInstall(location, await options());
    const storage = await reopen(location);
    const heartbeats = (await storage.monitors.list()).filter(
      (monitor) => monitor.config.type === "heartbeat"
    );
    expect(heartbeats.length).toBeGreaterThan(0);
    const tokens = await Promise.all(
      heartbeats.map((monitor) => storage.monitors.heartbeatTokenOf(monitor.id))
    );
    expect(seeded.heartbeatTokens as readonly (string | undefined)[]).toEqual(
      tokens
    );
  });

  test("the default status page shows a component for each monitor the fleet puts on it", async () => {
    const location = await scratch();
    const members = fleet(20);
    const seeded = await seedInstall(
      location,
      await options({ fleet: members })
    );
    const storage = await reopen(location);
    const [page] = await storage.pages.list();
    expect(page?.isDefault).toBe(true);
    expect(page?.published).toBe(true);
    expect(seeded.pageId).toBe(page?.id);
    const shown = (await storage.pages.componentsShown()).get(page?.id ?? "");
    expect(shown).toHaveLength(pageComponents);
    const components = await storage.components.list();
    const onPage = seeded.monitorIds.filter(
      (_, index) => members[index]?.onPage
    );
    expect(new Set(components.flatMap((each) => each.monitorIds))).toEqual(
      new Set(onPage)
    );
  });

  test("a fleet with nothing on a page seeds no page", async () => {
    const location = await scratch();
    const seeded = await seedInstall(
      location,
      await options({ fleet: capacityFleet(5, 20_000, target) })
    );
    expect(seeded.pageId).toBeUndefined();
    expect(await (await reopen(location)).pages.list()).toEqual([]);
  });

  test("the channels are an email channel to the SMTP sink and a webhook to the target's sink, selected by the monitors that notify", async () => {
    const location = await scratch();
    const key = await scratchInstallKey();
    const members = fleet(20);
    await seedInstall(
      location,
      await options({
        channels: {
          smtpHost: "raaqeb-bench-mailpit-1",
          smtpPort: 1025,
          webhookUrl: "http://raaqeb-bench-target-1:8080/sink",
        },
        fleet: members,
        key,
      })
    );
    const storage = await reopen(location);
    const channels = await storage.channels.list();
    expect(
      channels
        .map((channel) => channel.type)
        .toSorted((a, b) => a.localeCompare(b))
    ).toEqual(["email", "webhook"]);
    const webhook = channels.find((channel) => channel.type === "webhook");
    const sealed = await storage.channels.credentialsOf(webhook?.id ?? "");
    expect(await decrypt(key, sealed ?? "")).toContain(
      "http://raaqeb-bench-target-1:8080/sink"
    );
    const monitors = await storage.monitors.list();
    for (const [index, monitor] of monitors.entries()) {
      expect(monitor.channels.length).toBe(members[index]?.notifies ? 2 : 0);
    }
  });

  test("the draft page is an unpublished copy of the default page, shown at its own path", async () => {
    const location = await scratch();
    const seeded = await seedInstall(
      location,
      await options({ draftPage: true })
    );
    const storage = await reopen(location);
    const pages = await storage.pages.list();
    const draft = pages.find((page) => !page.published);
    expect(draft).toBeDefined();
    expect(draft?.isDefault).toBe(false);
    expect(seeded.draftPath).toBe(`/status/${draft?.slug}`);
    const shown = await storage.pages.componentsShown();
    expect(shown.get(draft?.id ?? "")).toEqual(shown.get(seeded.pageId ?? ""));
  });

  test("incidents: one open on the default page's components, and resolved ones for its history", async () => {
    const location = await scratch();
    await seedInstall(location, await options({ incidents: true }));
    const storage = await reopen(location);
    const all = await storage.incidents.list();
    const open = await storage.incidents.open();
    expect(open).toHaveLength(1);
    expect(all.length - open.length).toBeGreaterThanOrEqual(2);
  });

  test("the history writes a day of head rows for every checked monitor and none for heartbeat monitors", async () => {
    const location = await scratch();
    const members = fleet(20, 1000);
    const seeded = await seedInstall(
      location,
      await options({
        fleet: members,
        history: { dayStart: yesterday, intervalMs: 600_000, monitors: 200 },
      })
    );
    const rows = await runSql(
      location,
      "SELECT monitor_id, COUNT(*) AS n, MIN(started_at) AS first, MAX(started_at) AS last FROM checks GROUP BY monitor_id"
    );
    const checked = members.filter((member) => member.role !== "heartbeat");
    expect(rows).toHaveLength(checked.length);
    for (const row of rows) {
      expect(Number(row.n)).toBe(day / 600_000);
      expect(Number(row.first)).toBeGreaterThanOrEqual(yesterday);
      expect(Number(row.last)).toBeLessThan(yesterday + day);
    }
    const heartbeatIds = seeded.monitorIds.filter(
      (_, index) => members[index]?.role === "heartbeat"
    );
    expect(
      rows.some((row) => heartbeatIds.includes(String(row.monitor_id)))
    ).toBe(false);
  });
});

describe("seeding the new check types", () => {
  test("a database monitor keeps its connection URL sealed with the install key, and its address as the list shows it", async () => {
    const location = await scratch();
    const key = await scratchInstallKey();
    const members = fleet(200);
    const seeded = await seedInstall(
      location,
      await options({ fleet: members, key })
    );
    const storage = await reopen(location);
    const monitors = await storage.monitors.list();
    const sealed = await Promise.all(
      seeded.monitorIds.map((id) => storage.monitors.credentialsOf(id))
    );
    const opened = await Promise.all(
      sealed.map((text) =>
        text === undefined ? undefined : openCredentials(key, text)
      )
    );
    let databaseMonitors = 0;
    for (const [index, member] of members.entries()) {
      if (member.connectionUrl === undefined) {
        expect(sealed[index]).toBeUndefined();
        continue;
      }
      databaseMonitors += 1;
      expect(opened[index]?.url).toBe(member.connectionUrl);
      expect(monitors[index]?.config).toMatchObject({
        address: new URL(member.connectionUrl).host,
      });
    }
    expect(databaseMonitors).toBe(15);
  });

  test("the history covers only as many checked monitors as asked, the first ones", async () => {
    const location = await scratch();
    const members = fleet(20, 1000);
    const seeded = await seedInstall(
      location,
      await options({
        fleet: members,
        history: { dayStart: yesterday, intervalMs: 3_600_000, monitors: 5 },
      })
    );
    const rows = await runSql(
      location,
      "SELECT DISTINCT monitor_id FROM checks"
    );
    const checked = seeded.monitorIds.filter(
      (_, index) => members[index]?.role !== "heartbeat"
    );
    expect(new Set(rows.map((row) => String(row.monitor_id)))).toEqual(
      new Set(checked.slice(0, 5))
    );
  });
});

describe("a synthetic day", () => {
  const ids = ["a", "b", "c"];

  test("each monitor's checks run its interval apart inside the day", () => {
    const checks = [...syntheticDay(ids, yesterday, 60_000)].flat();
    expect(checks).toHaveLength(3 * 1440);
    for (const id of ids) {
      const times = checks
        .filter((check) => check.monitorId === id)
        .map((check) => check.startedAt);
      expect(
        times.every((at, i) => i === 0 || at - (times[i - 1] ?? 0) === 60_000)
      ).toBe(true);
      expect(Math.min(...times)).toBeGreaterThanOrEqual(yesterday);
      expect(Math.max(...times)).toBeLessThan(yesterday + day);
    }
  });

  test("comes in batches no larger than the batch size", () => {
    const batches = [...syntheticDay(ids, yesterday, 20_000)];
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.length <= historyBatch)).toBe(true);
  });

  test("is the same day every time, mostly up with a few down", () => {
    const one = [...syntheticDay(ids, yesterday, 60_000)].flat();
    const two = [...syntheticDay(ids, yesterday, 60_000)].flat();
    expect(two).toEqual(one);
    const down = one.filter((check) => check.result === "down").length;
    expect(down).toBeGreaterThan(0);
    expect(down / one.length).toBeLessThan(0.05);
    const up = one.filter((check) => check.result === "up");
    expect(new Set(up.map((check) => check.responseMs)).size).toBeGreaterThan(
      50
    );
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { historyRecords } from "@/server/export/export.ts";
import {
  day,
  hour,
  now,
  sourceInstall,
  targetInstall,
  today,
} from "@/server/export/fixture.ts";
import type { Check } from "@/shared/schemas/check.ts";
import {
  type Configuration,
  type ConfigurationTable,
  configurationSchema,
  travellingSettings,
} from "@/shared/schemas/export.ts";
import { pageCustomizationSchema } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { tables } from "./connection.ts";
import { runSql } from "./fixture.ts";
import type { HistoryCount } from "./transfer.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function source() {
  const install = await sourceInstall();
  cleanups.push(install.cleanup);
  return install;
}

async function target() {
  const install = await targetInstall();
  cleanups.push(install.cleanup);
  return install;
}

async function count(
  install: Awaited<ReturnType<typeof target>>,
  table: string
): Promise<number> {
  const [row] = await runSql(
    install.location,
    `SELECT count(*) AS n FROM ${table}`
  );
  return Number(row?.n);
}

function check(monitorId: string, startedAt: number): Check {
  return {
    attempts: 1,
    bytes: 10,
    monitorId,
    reason: reasons.ok,
    responseMs: 120,
    result: "up",
    startedAt,
    statusCode: 200,
  };
}

describe("the configuration export and import carry", () => {
  test("every column of every table they carry, on both schema files, so a new column cannot be left behind unseen", () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    for (const name of Object.keys(configurationSchema.shape)) {
      const carried = Object.keys(
        configurationSchema.shape[name as ConfigurationTable].element.shape
      ).sort(byName);
      for (const dialect of [tables.sqlite, tables.postgres]) {
        const table = dialect[name as keyof typeof dialect];
        expect(Object.keys(getTableColumns(table)).sort(byName)).toEqual(
          carried
        );
      }
    }
  });
});

describe("the transfer repository", () => {
  test("reads the configuration with credentials as they are sealed and only the settings that travel", async () => {
    const { ids, storage } = await source();
    const configuration = await storage.transfer.configuration();
    expect(configuration.monitors.map((row) => row.name).sort()).toEqual([
      "API",
      "DNS",
      "Nightly backup",
    ]);
    const api = configuration.monitors.find((row) => row.id === ids.api);
    expect(api?.credentials).toBe(
      (await storage.monitors.credentialsOf(ids.api)) ?? null
    );
    expect(api?.credentials?.startsWith("1.")).toBe(true);
    expect(configuration.settings.map((row) => row.key).sort()).toEqual(
      [...travellingSettings].sort()
    );
    expect(configuration.pageImages[0]?.body).toBeInstanceOf(Uint8Array);
    for (const name of Object.keys(configuration) as ConfigurationTable[]) {
      expect({ name, rows: configuration[name].length }).not.toEqual({
        name,
        rows: 0,
      });
    }
  });

  test("writes a configuration back with its ids and times as they were", async () => {
    const from = await source();
    const into = await target();
    const configuration = await from.storage.transfer.configuration();
    await into.storage.transfer.restore(configuration);
    await into.storage.transfer.writeSettings(configuration.settings);
    expect(await into.storage.transfer.configuration()).toEqual(configuration);
  });

  test("reads each table's rows in the order of their keys, whatever order they were written in", async () => {
    const from = await source();
    const into = await target();
    const configuration = await from.storage.transfer.configuration();
    const reversed = Object.fromEntries(
      Object.entries(configuration).map(([name, rows]) => [
        name,
        [...rows].reverse(),
      ])
    ) as unknown as Configuration;
    await into.storage.transfer.restore(reversed);
    await into.storage.transfer.writeSettings(reversed.settings);
    expect(await into.storage.transfer.configuration()).toEqual(configuration);
  });

  test("an install holding a monitor, a status page or a component holds content, and one with channels alone does not", async () => {
    const into = await target();
    expect(await into.storage.transfer.holdsContent()).toBe(false);
    await into.storage.channels.create({
      appliesToNew: false,
      config: {},
      locale: undefined,
      name: "Mail",
      type: "webhook",
    });
    expect(await into.storage.transfer.holdsContent()).toBe(false);
    const component = await into.storage.components.create({
      description: undefined,
      monitorIds: [],
      name: { ar: "Web" },
      status: "operational",
    });
    expect(await into.storage.transfer.holdsContent()).toBe(true);
    await into.storage.components.remove(component.id);
    const page = await into.storage.pages.create({
      customDomain: undefined,
      customization: pageCustomizationSchema.parse({}),
      isDefault: true,
      published: true,
      locale: "ar",
      slug: "main",
      title: { ar: "Status" },
    });
    expect(await into.storage.transfer.holdsContent()).toBe(true);
    await into.storage.pages.remove(page.id);
    const { ids, storage } = await source();
    const monitor = await storage.monitors.find(ids.dns);
    if (!monitor) {
      throw new Error("the source has no DNS monitor");
    }
    await into.storage.monitors.create({ ...monitor, channels: [] });
    expect(await into.storage.transfer.holdsContent()).toBe(true);
  });

  test("deleting every component takes the incidents and windows that named only them, so the install holds no content", async () => {
    const from = await source();
    const into = await target();
    await into.storage.transfer.restore(
      await from.storage.transfer.configuration()
    );
    await into.storage.monitors.remove([
      from.ids.api,
      from.ids.backup,
      from.ids.dns,
    ]);
    for (const page of await into.storage.pages.list()) {
      // biome-ignore lint/performance/noAwaitInLoops: one at a time is plenty for a test
      await into.storage.pages.remove(page.id);
    }
    for (const component of await into.storage.components.list()) {
      // biome-ignore lint/performance/noAwaitInLoops: one at a time is plenty for a test
      await into.storage.components.remove(component.id);
    }
    expect(await into.storage.incidents.list()).toEqual([]);
    expect(await into.storage.maintenance.list()).toEqual([]);
    expect(await into.storage.transfer.holdsContent()).toBe(false);
  });

  test("refuses to write a configuration into an install that holds content, and writes nothing", async () => {
    const from = await source();
    const into = await target();
    await into.storage.components.create({
      description: undefined,
      monitorIds: [],
      name: { ar: "Web" },
      status: "operational",
    });
    const configuration = await from.storage.transfer.configuration();
    expect(await into.storage.transfer.restore(configuration)).toBeUndefined();
    expect(await count(into, "monitors")).toBe(0);
    expect(await count(into, "channels")).toBe(0);
    expect(await count(into, "components")).toBe(1);
  });

  test("keeps a channel the install already has under the same id as the install has it, and does not count it as written", async () => {
    const from = await source();
    const into = await target();
    const configuration = await from.storage.transfer.configuration();
    const nothing = Object.fromEntries(
      Object.keys(configurationSchema.shape).map((name) => [name, []])
    ) as unknown as Configuration;
    const email = configuration.channels.find(
      (row) => row.id === from.ids.email
    );
    if (!email) {
      throw new Error("the source has no email channel");
    }
    await into.storage.transfer.restore({
      ...nothing,
      channels: [{ ...email, name: "The install's own" }],
    });
    const written = await into.storage.transfer.restore(configuration);
    expect(written?.channels).toEqual([from.ids.webhook]);
    expect((await into.storage.channels.find(from.ids.email))?.name).toBe(
      "The install's own"
    );
  });

  test("takes out what a restore wrote, history included, and leaves what the install had", async () => {
    const from = await source();
    const into = await target();
    const own = await into.storage.channels.create({
      appliesToNew: false,
      config: {},
      locale: undefined,
      name: "Own",
      type: "webhook",
    });
    const written = await into.storage.transfer.restore(
      await from.storage.transfer.configuration()
    );
    await into.storage.transfer.writeChecks([check(from.ids.api, now - hour)]);
    await into.storage.transfer.writeOutages([
      {
        endedAt: undefined,
        monitorId: from.ids.api,
        reason: reasons.timeout,
        startedAt: now - hour,
      },
    ]);
    if (!written) {
      throw new Error("the restore was refused");
    }
    await into.storage.transfer.remove(written);
    expect(await into.storage.transfer.holdsContent()).toBe(false);
    for (const table of [
      "monitors",
      "groups",
      "tags",
      "incidents",
      "maintenance_windows",
      "subscriptions",
      "checks",
      "outages",
      "page_images",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one count after another is plenty for a test
      expect({ table, rows: await count(into, table) }).toEqual({
        rows: 0,
        table,
      });
    }
    expect((await into.storage.channels.list()).map((row) => row.id)).toEqual([
      own.id,
    ]);
  });

  test("writes checks as head rows a few hundred to a statement and keeps a check already stored", async () => {
    const from = await source();
    const into = await target();
    await into.storage.transfer.restore(
      await from.storage.transfer.configuration()
    );
    await into.storage.checks.record({
      capture: undefined,
      check: { ...check(from.ids.dns, today), attempts: 3 },
      detail: undefined,
    });
    const many = Array.from({ length: 1200 }, (_, index) =>
      check(from.ids.dns, today + index * 1000)
    );
    await into.storage.transfer.writeChecks(many);
    const stored = await into.storage.checks.range(
      from.ids.dns,
      today,
      today + day
    );
    expect(stored).toHaveLength(1200);
    expect(stored[0]?.attempts).toBe(3);
  });

  test("writes rollups of a span, replacing one at the same monitor and time", async () => {
    const from = await source();
    const into = await target();
    await into.storage.transfer.restore(
      await from.storage.transfer.configuration()
    );
    const rollup = {
      at: today - 50 * day,
      averageMs: 100,
      checks: 4,
      degraded: 0,
      failed: 0,
      maxMs: 150,
      minMs: 50,
      monitorId: from.ids.api,
      observedMs: day,
    };
    await into.storage.transfer.writeRollups("day", [rollup]);
    await into.storage.transfer.writeRollups("day", [{ ...rollup, checks: 5 }]);
    await into.storage.transfer.writeRollups("hour", [
      { ...rollup, observedMs: hour },
    ]);
    expect(
      await into.storage.checks.rollups(
        from.ids.api,
        "day",
        today - 60 * day,
        today
      )
    ).toEqual([{ ...rollup, checks: 5 }]);
    expect(
      await into.storage.checks.rollups(
        from.ids.api,
        "hour",
        today - 60 * day,
        today
      )
    ).toEqual([{ ...rollup, observedMs: hour }]);
  });

  test("writes outages and keeps one already stored", async () => {
    const from = await source();
    const into = await target();
    await into.storage.transfer.restore(
      await from.storage.transfer.configuration()
    );
    const outage = {
      endedAt: now - hour,
      monitorId: from.ids.api,
      reason: reasons.timeout,
      startedAt: now - 2 * hour,
    };
    await into.storage.transfer.writeOutages([outage]);
    await into.storage.transfer.writeOutages([
      { ...outage, endedAt: undefined },
    ]);
    expect(await into.storage.outages.list(from.ids.api)).toEqual([outage]);
  });

  test("writes outages past the parameters one statement may bind, counting the five each carries", async () => {
    const from = await source();
    const into = await target();
    await into.storage.transfer.restore(
      await from.storage.transfer.configuration()
    );
    // 13,200 outages of five parameters bind 66,000, over Postgres's 65,535 if one statement took them all.
    const many = Array.from({ length: 13_200 }, (_, index) => ({
      acknowledgedAt: now - 2 * index * 1000 - 500,
      endedAt: now - 2 * index * 1000,
      monitorId: from.ids.api,
      reason: reasons.timeout,
      startedAt: now - 2 * index * 1000 - 1000,
    }));
    await into.storage.transfer.writeOutages(many);
    expect(await count(into, "outages")).toBe(13_200);
  });

  test("a configuration with nothing in it restores nothing", async () => {
    const into = await target();
    const nothing = Object.fromEntries(
      Object.keys(configurationSchema.shape).map((name) => [name, []])
    ) as unknown as Configuration;
    const written = await into.storage.transfer.restore(nothing);
    expect(written?.monitors).toEqual([]);
    expect(await into.storage.transfer.holdsContent()).toBe(false);
  });
});

describe("the days a monitor has checks on", () => {
  test("are its sealed days and its days in the head, each once, oldest first, inside the span", async () => {
    const { ids, storage } = await source();
    expect(await storage.checks.days(ids.api, 0, now)).toEqual([
      today - 3 * day,
      today - 2 * day,
      today - day,
      today,
    ]);
    expect(await storage.checks.days(ids.api, today - 2 * day, today)).toEqual([
      today - 2 * day,
      today - day,
    ]);
    expect(await storage.checks.days(ids.backup, 0, now)).toEqual([]);
  });
});

describe("the history counts", () => {
  test("are each monitor's lines of each kind as the full export writes them, a day in its finest kind alone", async () => {
    const { storage } = await source();
    const written = new Map<string, HistoryCount>();
    for (const monitor of await storage.monitors.list()) {
      const lines = { checks: 0, daily: 0, hourly: 0 };
      // biome-ignore lint/performance/noAwaitInLoops: one monitor's records after another, as the export writes them
      for await (const record of historyRecords(
        storage,
        monitor.id,
        0,
        Number.MAX_SAFE_INTEGER
      )) {
        if (record.kind === "check") {
          lines.checks += 1;
        } else if (record.kind !== "outage") {
          lines[record.kind] += 1;
        }
      }
      if (lines.checks + lines.daily + lines.hourly > 0) {
        written.set(monitor.id, lines);
      }
    }
    // The source holds every kind, so a count that leaves one out cannot match by accident.
    const kinds = [...written.values()];
    expect(kinds.some((each) => each.checks > 0)).toBe(true);
    expect(kinds.some((each) => each.hourly > 0)).toBe(true);
    expect(kinds.some((each) => each.daily > 0)).toBe(true);
    expect(await storage.transfer.historyCounts()).toEqual(written);
  });
});

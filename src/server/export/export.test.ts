import { afterEach, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { ExportRecord } from "@/shared/schemas/export.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  exportInstall,
  exportSizes,
  historyDownload,
  historyRecords,
} from "./export.ts";
import {
  channelUrl,
  day,
  hour,
  type Install,
  linesOf,
  minute,
  monitorPassword,
  now,
  signingSecret,
  sourceInstall,
  subscriberUrl,
  targetInstall,
  today,
} from "./fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function source() {
  const install = await sourceInstall();
  cleanups.push(install.cleanup);
  return install;
}

async function exported(
  install: Awaited<ReturnType<typeof source>>,
  mode: "full" | "configuration" = "full"
) {
  const started = await exportInstall(install.storage, install.key, mode, now);
  if (!started.ok) {
    throw new Error(`the export did not start: ${started.reason}`);
  }
  return linesOf(started.body);
}

type Line = Record<string, unknown>;
const configurationOf = (header: Line | undefined) =>
  (header?.configuration ?? {}) as Partial<Record<string, Line[]>>;

/** A monitor checked every minute from four days before today to now, each check varied as a real one is, its closed days sealed. */
async function variedMonitor(
  install: Awaited<ReturnType<typeof source>>
): Promise<void> {
  const { storage } = install;
  const monitor = await storage.monitors.create({
    channels: [],
    config: { name: "example.test", recordType: "A", type: "dns" },
    events: [],
    intervalMs: minute,
    name: "Varied",
    retries: 0,
    tags: [],
    timeoutMs: 5000,
  });
  for (let at = today - 4 * day; at < now; at += minute) {
    const roll = Number(BigInt(Bun.hash(`${at}`)) % 1000n);
    const down = roll < 10;
    // biome-ignore lint/performance/noAwaitInLoops: the head table's rows go in one at a time, as the scheduler writes them
    await storage.checks.record({
      capture: undefined,
      check: {
        attempts: down ? 2 : 1,
        bytes: down ? 0 : 2000 + (roll % 300),
        monitorId: monitor.id,
        reason: down ? reasons.timeout : reasons.ok,
        responseMs: down ? 5000 : 40 + roll,
        result: down ? "down" : "up",
        startedAt: at,
        statusCode: undefined,
      },
      detail: undefined,
    });
  }
  for (let sealed = today - 4 * day; sealed < today; sealed += day) {
    // biome-ignore lint/performance/noAwaitInLoops: oldest day first, as the sealing job seals
    await storage.checks.seal(monitor.id, sealed, 10 * minute, []);
  }
}

describe("an export", () => {
  test("starts with a header naming the export, its version, its mode and when it was made", async () => {
    const [header] = await exported(await source());
    expect(header).toMatchObject({
      exportedAt: new Date(now).toISOString(),
      mode: "full",
      raaqeb: "export",
      version: 1,
    });
  });

  test("carries every credential in clear and nothing sealed", async () => {
    const install = await source();
    const lines = await exported(install);
    const configuration = configurationOf(lines[0]);
    const api = configuration.monitors?.find(
      (row) => row.id === install.ids.api
    );
    expect(api?.credentials).toEqual({
      auth: { kind: "basic", password: monitorPassword, user: "raaqeb" },
      headers: [{ name: "X-Api-Key", value: "header secret" }],
    });
    const webhook = configuration.channels?.find(
      (row) => row.id === install.ids.webhook
    );
    expect(webhook?.credentials).toEqual({
      secret: signingSecret,
      url: channelUrl,
    });
    const subscriber = configuration.subscriptions?.find(
      (row) => row.channel === "webhook"
    );
    expect(subscriber?.credentials).toBe(subscriberUrl);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('"1.');
  });

  test("carries the settings that travel and none of the install's own", async () => {
    const [header] = await exported(await source());
    const keys = (configurationOf(header).settings ?? []).map((row) => row.key);
    expect(keys).toContain("time_zone");
    expect(keys).toContain("install_language");
    expect(keys).toContain("calendar");
    for (const own of [
      "public_address",
      "better_auth_secrets",
      "operator_language",
      "operator_calendar",
    ]) {
      expect(keys).not.toContain(own);
    }
  });

  test("in the configuration mode is the header alone", async () => {
    const lines = await exported(await source(), "configuration");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mode: "configuration" });
  });

  test("in the full mode follows each monitor's outages with its days oldest first, each day in the finest kind it still has", async () => {
    const install = await source();
    const lines = await exported(install);
    const api = lines.filter((line) => line.monitor === install.ids.api);
    const kinds = api.map((line) => line.kind);
    const firstHistory = kinds.findIndex((kind) => kind !== "outage");
    expect(kinds.slice(0, firstHistory)).toEqual(["outage"]);
    const times = api
      .slice(firstHistory)
      .map((line) => Date.parse(String(line.at)));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const kindOn = (at: number) =>
      new Set(
        api
          .filter((line) => {
            const time = Date.parse(String(line.at));
            return line.kind !== "outage" && time >= at && time < at + day;
          })
          .map((line) => line.kind)
      );
    expect(kindOn(today - 200 * day)).toEqual(new Set(["daily"]));
    expect(kindOn(today - 41 * day)).toEqual(new Set(["hourly"]));
    expect(kindOn(today - 40 * day)).toEqual(new Set(["hourly"]));
    // Sealed, left in the head though closed, and today.
    for (const checked of [today - 3 * day, today - day, today]) {
      expect(kindOn(checked)).toEqual(new Set(["check"]));
    }
  });

  test("decodes a sealed day to the checks it holds, every field as recorded", async () => {
    const install = await source();
    const lines = await exported(install);
    const sealedDay = lines.filter(
      (line) =>
        line.monitor === install.ids.api &&
        line.kind === "check" &&
        Date.parse(String(line.at)) >= today - 3 * day &&
        Date.parse(String(line.at)) < today - 2 * day
    );
    const recorded = await install.storage.checks.range(
      install.ids.api,
      today - 3 * day,
      today - 2 * day
    );
    expect(sealedDay).toHaveLength(72);
    expect(sealedDay[3]).toEqual({
      at: new Date(recorded[3]?.startedAt ?? 0).toISOString(),
      attempts: 2,
      bytes: 0,
      kind: "check",
      monitor: install.ids.api,
      reason: "timeout",
      responseMs: 10_000,
      result: "down",
      statusCode: null,
    });
  });

  test("carries every outage, open ones too, with when it was acknowledged, and none for one nobody acknowledged", async () => {
    const install = await source();
    const lines = await exported(install);
    expect(
      lines
        .filter((line) => line.kind === "outage")
        .map((line) => [line.endedAt === null, line.acknowledgedAt])
    ).toEqual([
      [false, null],
      [true, new Date(now - 2 * minute).toISOString()],
    ]);
  });

  test("carries no history of a monitor with none", async () => {
    const install = await source();
    const lines = await exported(install);
    expect(lines.filter((line) => line.monitor === install.ids.backup)).toEqual(
      []
    );
  });

  test("does not start when the install key cannot open a record's credentials, and names the record", async () => {
    const install = await source();
    const other = await scratchInstallKey();
    await runSql(
      install.location,
      "UPDATE channels SET credentials = ? WHERE id = ?",
      [await encrypt(other, '{"url":"https://x.example"}'), install.ids.email]
    );
    expect(
      await exportInstall(install.storage, install.key, "full", now)
    ).toEqual({ ok: false, reason: "unreadable", record: install.ids.email });
  });

  test("does not start when a stored row does not fit the file, and names the row", async () => {
    const install = await source();
    await runSql(
      install.location,
      "UPDATE components SET status = ? WHERE id = ?",
      ["not a status", install.ids.payments]
    );
    expect(
      await exportInstall(install.storage, install.key, "full", now)
    ).toEqual({
      ok: false,
      reason: "unreadable",
      record: install.ids.payments,
    });
  });

  test("breaks off, rather than hangs, when the database stops answering while the history streams", async () => {
    const install = await source();
    const started = await exportInstall(
      install.storage,
      install.key,
      "full",
      now
    );
    if (!started.ok) {
      throw new Error(started.reason);
    }
    await install.storage.close();
    await expect(new Response(started.body).arrayBuffer()).rejects.toThrow();
  });

  test("starts once the download before it broke off, the database gone", async () => {
    const install = await source();
    const first = await exportInstall(
      install.storage,
      install.key,
      "full",
      now
    );
    await install.storage.close();
    await (first.ok && new Response(first.body).arrayBuffer().catch(() => 0));
    // Not busy: the next download reaches the database, which no longer answers.
    expect(
      await exportInstall(install.storage, install.key, "full", now)
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  test("does not start without a database", async () => {
    expect(
      await exportInstall(undefined, await scratchInstallKey(), "full", now)
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  test("is refused as busy while another downloads, and starts once that one has ended", async () => {
    const install = await source();
    const first = await exportInstall(
      install.storage,
      install.key,
      "full",
      now
    );
    expect(
      await exportInstall(install.storage, install.key, "configuration", now)
    ).toEqual({ ok: false, reason: "busy" });
    if (!first.ok) {
      throw new Error(first.reason);
    }
    await new Response(first.body).arrayBuffer();
    const next = await exportInstall(install.storage, install.key, "full", now);
    expect(next.ok).toBe(true);
    await (next.ok && next.body.cancel());
  });

  test("starts once a download before it could not, the database not answering", async () => {
    const install = await source();
    const failing = {
      ...install.storage,
      transfer: {
        ...install.storage.transfer,
        configuration: () =>
          Promise.reject(new Error("the database went away")),
      },
    };
    expect(await exportInstall(failing, install.key, "full", now)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const next = await exportInstall(failing, install.key, "full", now);
    expect(next).toEqual({ ok: false, reason: "unavailable" });
  });

  /** The download that starts first once the one before it lets go, asked for every tick. */
  async function nextDownload(install: Pick<Install, "key" | "storage">) {
    for (let tick = 0; tick < 1000; tick += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one ask a tick, so the first free moment is the one taken
      const next = await exportInstall(
        install.storage,
        install.key,
        "full",
        now
      );
      if (next.ok) {
        return next;
      }
      await Bun.sleep(0);
    }
    throw new Error("the download before it never let go");
  }

  test("stays busy for the download after a cancelled one, whatever the cancelled one's last read does", async () => {
    const install = await source();
    await variedMonitor(install);
    // Every day's read waits for the gate, so the cancel finds the first download's read in flight.
    const gate = Promise.withResolvers<void>();
    const storage: Storage = {
      ...install.storage,
      checks: {
        ...install.storage.checks,
        range: async (...args) => {
          await gate.promise;
          return install.storage.checks.range(...args);
        },
      },
    };
    const gated = { key: install.key, storage };
    const first = await exportInstall(storage, install.key, "full", now);
    await Bun.sleep(20);
    await (first.ok && first.body.cancel());
    const second = await nextDownload(gated);
    // The first download's read ends after the second started, and its stream asks for one more line.
    gate.resolve();
    await Bun.sleep(50);
    expect(await exportInstall(storage, install.key, "full", now)).toEqual({
      ok: false,
      reason: "busy",
    });
    await second.body.cancel();
  });

  test("starts once the download before it was cancelled, as a browser that goes away cancels it", async () => {
    const install = await source();
    await variedMonitor(install);
    const first = await exportInstall(
      install.storage,
      install.key,
      "full",
      now
    );
    // Nobody reads, so the stream fills and stops pulling: the cancel finds no pull to finish the lines.
    await Bun.sleep(50);
    await (first.ok && first.body.cancel());
    const next = await nextDownload(install);
    await next.body.cancel();
  });
});

describe("one monitor's history", () => {
  test("is the export's records of that monitor alone inside the span", async () => {
    const install = await source();
    const records: ExportRecord[] = [];
    for await (const record of historyRecords(
      install.storage,
      install.ids.api,
      today - day,
      now
    )) {
      records.push(record);
    }
    // Yesterday's and this morning's checks, every one inside the span; the API's outage ended two days ago.
    const inside = await install.storage.checks.range(
      install.ids.api,
      today - day,
      now
    );
    expect(
      records.map((record) => record.kind === "check" && record.at)
    ).toEqual(inside.map((check) => check.startedAt));
    expect(records.every((record) => record.monitor === install.ids.api)).toBe(
      true
    );
  });

  test("lists a monitor's outages oldest first, and none that starts at or after the span's end", async () => {
    const install = await source();
    await runSql(
      install.location,
      "INSERT INTO outages (monitor_id, started_at, ended_at, reason) VALUES (?, ?, ?, 1), (?, ?, NULL, 1)",
      [
        install.ids.api,
        today - 3 * day,
        today - 3 * day + hour,
        install.ids.api,
        now,
      ]
    );
    const starts: number[] = [];
    for await (const record of historyRecords(
      install.storage,
      install.ids.api,
      0,
      now
    )) {
      if (record.kind === "outage") {
        starts.push(record.startedAt);
      }
    }
    expect(starts).toEqual([today - 3 * day, today - 2 * day + 2 * hour]);
  });

  test("cuts a span that starts or ends inside a day at its edges", async () => {
    const install = await source();
    const from = today - day + 6 * hour;
    const to = today - day + 12 * hour;
    const records: ExportRecord[] = [];
    for await (const record of historyRecords(
      install.storage,
      install.ids.api,
      from,
      to
    )) {
      records.push(record);
    }
    const inside = await install.storage.checks.range(
      install.ids.api,
      from,
      to
    );
    expect(inside.length).toBeGreaterThan(0);
    expect(
      records.map((record) => record.kind === "check" && record.at)
    ).toEqual(inside.map((check) => check.startedAt));
    const hours: number[] = [];
    for await (const record of historyRecords(
      install.storage,
      install.ids.api,
      today - 40 * day + hour,
      today - 39 * day
    )) {
      if (record.kind === "hourly") {
        hours.push(record.at);
      }
    }
    expect(hours).toEqual([
      today - 40 * day + hour,
      today - 40 * day + 2 * hour,
    ]);
  });

  test("includes an outage that overlaps the span", async () => {
    const install = await source();
    const kinds: string[] = [];
    for await (const record of historyRecords(
      install.storage,
      install.ids.dns,
      now - hour,
      now
    )) {
      kinds.push(record.kind);
    }
    expect(kinds[0]).toBe("outage");
  });

  test("downloads over the chart's range as the export's lines", async () => {
    const install = await source();
    const download = await historyDownload(
      install.storage,
      install.ids.dns,
      "24h",
      now
    );
    if (!download.ok) {
      throw new Error(download.reason);
    }
    const lines = await linesOf(download.body);
    expect(lines.filter((line) => line.kind === "check")).toHaveLength(
      (5 * minute + 12 * hour) / (5 * minute)
    );
    expect(lines.every((line) => line.monitor === install.ids.dns)).toBe(true);
  });

  test("downloads no check older than the range", async () => {
    const install = await source();
    const download = await historyDownload(
      install.storage,
      install.ids.api,
      "24h",
      now
    );
    if (!download.ok) {
      throw new Error(download.reason);
    }
    const checks = (await linesOf(download.body)).filter(
      (line) => line.kind === "check"
    );
    expect(checks.length).toBeGreaterThan(0);
    expect(
      checks.every((line) => Date.parse(String(line.at)) >= now - day)
    ).toBe(true);
  });

  test("downloads only the span zoomed into, when there is one", async () => {
    const install = await source();
    const span = { from: now - 2 * hour, to: now - hour };
    const download = await historyDownload(
      install.storage,
      install.ids.api,
      "24h",
      now,
      span
    );
    if (!download.ok) {
      throw new Error(download.reason);
    }
    const checks = (await linesOf(download.body)).filter(
      (line) => line.kind === "check"
    );
    expect(checks.length).toBeGreaterThan(0);
    expect(
      checks.every((line) => {
        const at = Date.parse(String(line.at));
        return at >= span.from && at < span.to;
      })
    ).toBe(true);
  });

  test("is not found for a monitor the install does not have, and unavailable without a database", async () => {
    const install = await source();
    expect(
      await historyDownload(install.storage, "no-such-monitor", "24h", now)
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await historyDownload(undefined, install.ids.api, "24h", now)
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the size of each export", () => {
  async function bytesOf(
    install: Pick<Install, "key" | "storage">,
    mode: "full" | "configuration",
    at: number
  ): Promise<number> {
    const started = await exportInstall(install.storage, install.key, mode, at);
    if (!started.ok) {
      throw new Error(started.reason);
    }
    return (await new Response(started.body).arrayBuffer()).byteLength;
  }

  /** The install's storage, counting the reads of one method of one repository. */
  function counted<
    Repository extends "checks" | "transfer",
    Method extends keyof Storage[Repository],
  >(storage: Storage, repository: Repository, method: Method) {
    const calls = { count: 0 };
    const original = storage[repository][method];
    if (typeof original !== "function") {
      throw new Error(`${String(method)} is not a method`);
    }
    const wrapped = {
      ...storage,
      [repository]: {
        ...storage[repository],
        [method]: (...args: unknown[]) => {
          calls.count += 1;
          return Reflect.apply(original, storage[repository], args);
        },
      },
    };
    return { calls, storage: wrapped };
  }

  test("is the configuration file's bytes exactly, the full one the larger", async () => {
    const install = await source();
    const sizes = await exportSizes(install.storage, install.key, now);
    expect(sizes.ok && sizes.configuration).toBe(
      await bytesOf(install, "configuration", now)
    );
    expect(sizes.ok && sizes.full > sizes.configuration).toBe(true);
  });

  test("estimates the full file within a tenth of its bytes, for checks varied as real ones are", async () => {
    const install = await source();
    await variedMonitor(install);
    const sizes = await exportSizes(install.storage, install.key, now);
    const full = await bytesOf(install, "full", now);
    expect(sizes.ok && Math.abs(sizes.full - full) / full).toBeLessThan(0.1);
  });

  test("writes no file to answer, so it reads no day of checks whole", async () => {
    const install = await source();
    const { calls, storage } = counted(install.storage, "checks", "range");
    expect((await exportSizes(storage, install.key, now)).ok).toBe(true);
    expect(calls.count).toBe(0);
  });

  test("is read once for every caller that asks while it is read", async () => {
    const install = await source();
    const { calls, storage } = counted(
      install.storage,
      "transfer",
      "configuration"
    );
    const [first, second] = await Promise.all([
      exportSizes(storage, install.key, now),
      exportSizes(storage, install.key, now),
    ]);
    expect(second).toEqual(first);
    expect(first.ok).toBe(true);
    expect(calls.count).toBe(1);
  });

  test("is kept for five minutes, so a second visit reads no history again", async () => {
    const install = await source();
    const first = await exportSizes(install.storage, install.key, now);
    await install.storage.checks.record({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 900,
        monitorId: install.ids.api,
        reason: reasons.ok,
        responseMs: 123,
        result: "up",
        startedAt: now + minute,
        statusCode: 200,
      },
      detail: undefined,
    });
    expect(
      await exportSizes(install.storage, install.key, now + 4 * minute)
    ).toEqual(first);
    const later = await exportSizes(
      install.storage,
      install.key,
      now + 6 * minute
    );
    expect(later.ok && first.ok && later.full > first.full).toBe(true);
  });

  test("is unavailable without a database", async () => {
    const install = await source();
    expect(await exportSizes(undefined, install.key, now)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  /** An empty install with one monitor that is checked no more, so it holds no head rows and no sealed days. */
  async function retiredMonitor() {
    const install = await targetInstall();
    cleanups.push(install.cleanup);
    const monitor = await install.storage.monitors.create({
      channels: [],
      config: { name: "example.test", recordType: "A", type: "dns" },
      events: [],
      intervalMs: minute,
      name: "Retired",
      retries: 0,
      tags: [],
      timeoutMs: 5000,
    });
    return { install, monitorId: monitor.id };
  }

  /** The history's bytes in the full file, estimated and written. */
  async function historyBytes(install: Pick<Install, "key" | "storage">) {
    const sizes = await exportSizes(install.storage, install.key, now);
    const configuration = await bytesOf(install, "configuration", now);
    return {
      estimated: sizes.ok ? sizes.full - sizes.configuration : 0,
      written: (await bytesOf(install, "full", now)) - configuration,
    };
  }

  // Each sample is compressed on its own, a few dozen bytes more than inside the file, so the histories below are a real retired monitor's size.
  test("estimates the rollups of a monitor checked no more from its older ones", async () => {
    const { install, monitorId } = await retiredMonitor();
    await install.storage.transfer.writeRollups(
      "hour",
      Array.from({ length: 20 * 24 }, (_, index) => ({
        at: today - 30 * day + index * hour,
        averageMs: 100 + (index % 97),
        checks: 60,
        degraded: 1,
        failed: 0,
        maxMs: 900,
        minMs: 90,
        monitorId,
        observedMs: hour,
      }))
    );
    const { estimated, written } = await historyBytes(install);
    expect(Math.abs(estimated - written) / written).toBeLessThan(0.1);
  });

  test("counts the outages of a monitor whose checks are all gone, since outages are never purged", async () => {
    const { install, monitorId } = await retiredMonitor();
    await install.storage.transfer.writeOutages(
      Array.from({ length: 30 * 24 }, (_, index) => ({
        endedAt: today - 60 * day + index * hour + 20 * minute,
        monitorId,
        reason: reasons.timeout,
        startedAt: today - 60 * day + index * hour,
      }))
    );
    const { estimated, written } = await historyBytes(install);
    expect(Math.abs(estimated - written) / written).toBeLessThan(0.1);
  });

  test("is not kept when it could not be read, so the next visit reads it again", async () => {
    const install = await source();
    const { calls, storage } = counted(
      install.storage,
      "transfer",
      "historyCounts"
    );
    const failing = {
      ...storage,
      transfer: {
        ...storage.transfer,
        historyCounts: async () => {
          await storage.transfer.historyCounts();
          throw new Error("the database went away");
        },
      },
    };
    expect(await exportSizes(failing, install.key, now)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect((await exportSizes(failing, install.key, now)).ok).toBe(false);
    expect(calls.count).toBe(2);
  });

  test("is read while a download streams, which it does not wait for", async () => {
    const install = await source();
    const download = await exportInstall(
      install.storage,
      install.key,
      "full",
      now
    );
    expect((await exportSizes(install.storage, install.key, now)).ok).toBe(
      true
    );
    await (download.ok && download.body.cancel());
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type {
  CheckRequests,
  OutageRequests,
} from "@/server/scheduler/scheduler.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { Check, CheckOutcome } from "@/shared/schemas/check.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  acknowledgeOutage,
  checkNow,
  readCheckRecord,
  readMonitorDetail,
} from "./detail.ts";

let open:
  | {
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
      storage: Storage;
    }
  | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    cleanup: scratch.cleanup,
    location: scratch.location,
    storage: opened.storage,
  };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** A storage whose reads fail, as a database outage would. */
function broken(store: Storage): Storage {
  const failing = () => Promise.reject(new Error("database gone"));
  return {
    ...store,
    checks: { ...store.checks, capture: failing, detail: failing },
    monitors: { ...store.monitors, find: failing },
  };
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

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
  intervalMs: minute,
  name: "Site",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

const beat: MonitorInput = {
  ...site,
  config: {
    schedule: { everyMs: hour, kind: "every" },
    type: "heartbeat",
  },
  name: "Backup",
};

function check(
  monitorId: string,
  startedAt: number,
  result: Check["result"] = "up",
  responseMs: number | undefined = 100
): CheckOutcome {
  return {
    capture: undefined,
    check: {
      attempts: 1,
      bytes: 10,
      monitorId,
      reason: result === "down" ? reasons.timeout : reasons.ok,
      responseMs,
      result,
      startedAt,
      statusCode: result === "down" ? undefined : 200,
    },
    detail:
      result === "down"
        ? {
            assertion: undefined,
            error: "The operation timed out.",
            monitorId,
            params: { reason: "timeout", timeoutMs: 10_000 },
            startedAt,
          }
        : undefined,
  };
}

/** Records a check each minute from `from` for `count` minutes; the minutes listed in `down` are down. */
async function minutes(
  store: Storage,
  monitorId: string,
  from: number,
  count: number,
  down: readonly number[] = []
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
    await store.checks.record(
      check(
        monitorId,
        from + index * minute,
        down.includes(index) ? "down" : "up"
      )
    );
  }
}

/** Seals every day before `before` that still has head rows, as the nightly job does. */
async function sealClosedDays(
  store: Storage,
  before: number,
  gapLimit: number
): Promise<void> {
  for (const { day: sealed, monitorId } of await store.checks.unsealed(
    before
  )) {
    // biome-ignore lint/performance/noAwaitInLoops: one day at a time, oldest first, as the job seals
    await store.checks.seal(monitorId, sealed, gapLimit, []);
  }
}

const options = (now: number) => ({
  now,
  range: "24h" as const,
  requestOrigin: "https://raaqeb.example.test",
});

describe("the monitor detail's read", () => {
  test("an unknown monitor is not found; a database that cannot answer is unavailable", async () => {
    const store = await storage();
    expect(await readMonitorDetail(store, "nope", options(Date.now()))).toEqual(
      { ok: false, reason: "not_found" }
    );
    expect(
      await readMonitorDetail(broken(store), "nope", options(Date.now()))
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  test("uptime is one minus the outage time over the observed time, in every window", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 60);
    await store.outages.open(monitor.id, base + 10 * minute, reasons.timeout);
    await store.outages.close(monitor.id, base + 15 * minute);
    const now = base + 60 * minute;
    const result = await readMonitorDetail(store, monitor.id, options(now));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.uptime).toEqual(
      (["24h", "7d", "30d", "90d"] as const).map((window) => ({
        downtimeMs: 5 * minute,
        observedMs: hour,
        window,
      }))
    );
  });

  test("the time a window covered the monitor is not observed time, and its outage there is not downtime; the page says a window covers it now", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    // Checks keep running through the window and record their true result.
    await minutes(store, monitor.id, base, 60, [20, 21, 22, 23, 24, 25]);
    await store.outages.open(monitor.id, base + 20 * minute, reasons.timeout);
    await store.outages.close(monitor.id, base + 26 * minute);
    const web = await store.components.create({
      description: undefined,
      monitorIds: [monitor.id],
      name: { ar: "الموقع" },
      status: "operational",
    });
    await store.maintenance.create({
      componentIds: [web.id],
      endsAt: base + 70 * minute,
      message: { ar: "نص" },
      startsAt: base + 15 * minute,
      title: { ar: "صيانة" },
    });
    await store.maintenance.advance(base + 15 * minute);
    const now = base + 60 * minute;
    const result = await readMonitorDetail(store, monitor.id, options(now));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.covered).toBe(true);
    expect(result.detail.uptime[0]).toEqual({
      downtimeMs: 0,
      observedMs: 15 * minute,
      window: "24h",
    });
  });

  test("a completed window's time is no observed time either, and the page no longer says a window covers the monitor", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 60);
    const web = await store.components.create({
      description: undefined,
      monitorIds: [monitor.id],
      name: { ar: "الموقع" },
      status: "operational",
    });
    await store.maintenance.create({
      componentIds: [web.id],
      endsAt: base + 25 * minute,
      message: { ar: "نص" },
      startsAt: base + 15 * minute,
      title: { ar: "صيانة" },
    });
    await store.maintenance.advance(base + 15 * minute);
    await store.maintenance.advance(base + 25 * minute);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(base + 60 * minute)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.covered).toBe(false);
    expect(result.detail.uptime[0]?.observedMs).toBe(50 * minute);
  });

  test("a gap longer than twice the interval is no data, and an outage across it counts only its observed part", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 10);
    // Raaqeb was stopped for half an hour, with the monitor down on both sides.
    await minutes(store, monitor.id, base + 40 * minute, 20);
    await store.outages.open(monitor.id, base + 5 * minute, reasons.timeout);
    await store.outages.close(monitor.id, base + 45 * minute);
    const now = base + 60 * minute;
    const result = await readMonitorDetail(store, monitor.id, options(now));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    // Observed: minutes 0 to 9 (the last check covers nothing past the gap) and 40 to 60.
    expect(result.detail.uptime[0]).toEqual({
      downtimeMs: 4 * minute + 5 * minute,
      observedMs: 9 * minute + 20 * minute,
      window: "24h",
    });
  });

  test("paused time is no data: the pause is a gap in the checks, and the outage the pause closed counts only up to the pause", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 10, [8, 9]);
    await store.outages.open(monitor.id, base + 8 * minute, reasons.timeout);
    // Paused at minute 10 for half an hour, then resumed and checked again.
    await store.outages.close(monitor.id, base + 10 * minute);
    await minutes(store, monitor.id, base + 40 * minute, 20);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(base + 60 * minute)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.uptime[0]).toEqual({
      downtimeMs: minute,
      observedMs: 9 * minute + 20 * minute,
      window: "24h",
    });
  });

  test("an open outage counts up to now", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 30, [25, 26, 27, 28, 29]);
    await store.outages.open(monitor.id, base + 25 * minute, reasons.timeout);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(base + 30 * minute)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.uptime[0]).toEqual({
      downtimeMs: 5 * minute,
      observedMs: 30 * minute,
      window: "24h",
    });
    expect(result.detail.outages[0]?.endedAt).toBeUndefined();
  });

  test("a check just before the longest window covers its start, so a monitor checked daily for months observes the whole 90 days", async () => {
    const store = await storage();
    const monitor = await store.monitors.create({ ...site, intervalMs: day });
    const base = monitor.updatedAt + 1000;
    for (let index = 0; index <= 90; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await store.checks.record(check(monitor.id, base + index * day));
    }
    // The 90-day window starts an hour after the oldest check.
    const now = base + 90 * day + hour;
    await sealClosedDays(store, Math.floor(now / day) * day, 2 * day);
    const result = await readMonitorDetail(store, monitor.id, options(now));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.uptime[3]).toEqual({
      downtimeMs: 0,
      observedMs: 90 * day,
      window: "90d",
    });
  });

  test("beyond the raw window uptime reads the observed time of the hourly rollups, and their hours' outage time", async () => {
    const store = await storage();
    const monitor = await store.monitors.create({
      ...site,
      intervalMs: 2 * hour,
    });
    // 45 days of a check every two hours, the oldest days sealed, with a ten-hour silence on the fifth day.
    const base = Math.floor(Date.now() / day) * day - 45 * day;
    for (let index = 0; index < 45 * 12; index += 1) {
      if (index > 60 && index < 65) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await store.checks.record(check(monitor.id, base + index * 2 * hour));
    }
    // Written by hand: `open` refuses an outage older than the monitor's last edit, and this history is.
    if (!open) {
      throw new Error("no database");
    }
    await runSql(
      open.location,
      "INSERT INTO outages (monitor_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?)",
      [
        monitor.id,
        base + 2 * day,
        base + 2 * day + 30 * minute,
        reasons.timeout,
      ]
    );
    const now = base + 45 * day;
    await sealClosedDays(store, now, 4 * hour);
    const result = await readMonitorDetail(store, monitor.id, options(now));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.uptime[2]).toEqual({
      downtimeMs: 0,
      observedMs: 30 * day,
      window: "30d",
    });
    expect(result.detail.uptime[3]).toEqual({
      downtimeMs: 30 * minute,
      observedMs: 45 * day - 10 * hour,
      window: "90d",
    });
  });

  test("after a size-budget delete took the oldest raw days, uptime reads those days from the hourly rollups they left", async () => {
    const store = await storage();
    const monitor = await store.monitors.create({
      ...site,
      intervalMs: 2 * hour,
    });
    // Ten days of a check every two hours, every closed day sealed.
    const base = Math.floor(Date.now() / day) * day - 10 * day;
    for (let index = 0; index < 10 * 12; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await store.checks.record(check(monitor.id, base + index * 2 * hour));
    }
    const now = base + 10 * day;
    await sealClosedDays(store, now, 4 * hour);
    const before = await readMonitorDetail(store, monitor.id, options(now));
    // The two oldest raw days go; their rollups stay.
    await store.checks.dropOldest(now);
    await store.checks.dropOldest(now);
    const after = await readMonitorDetail(store, monitor.id, options(now));
    if (!(before.ok && after.ok)) {
      throw new Error("the detail did not read");
    }
    expect(after.detail.uptime[2]?.observedMs).toBe(
      before.detail.uptime[2]?.observedMs
    );
    expect(after.detail.uptime[2]?.observedMs).toBeGreaterThan(9 * day);
  });

  test("a heartbeat monitor's gap limit is twice its period plus grace, not twice the stored interval", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(beat);
    const base = monitor.updatedAt + 1000;
    for (const index of [0, 1, 2, 3]) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await store.checks.record(
        check(monitor.id, base + index * 72 * minute, "up", undefined)
      );
    }
    const now = base + 3 * 72 * minute + 10 * minute;
    const result = await readMonitorDetail(store, monitor.id, options(now));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.uptime[0]).toEqual({
      downtimeMs: 0,
      observedMs: now - base,
      window: "24h",
    });
  });

  test("the state is the latest check's result, and the recent checks are the newest twenty, newest first", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 25, [24]);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(base + 25 * minute)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.state).toBe("down");
    expect(result.detail.recent).toHaveLength(20);
    expect(result.detail.recent[0]?.startedAt).toBe(base + 24 * minute);
    expect(result.detail.recent[19]?.startedAt).toBe(base + 5 * minute);
  });

  test("a monitor with no check yet has no state, no recent checks and no uptime figure", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(monitor.updatedAt + minute)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.state).toBeUndefined();
    expect(result.detail.recent).toEqual([]);
    for (const reading of result.detail.uptime) {
      expect(reading.observedMs).toBe(0);
    }
    expect(result.detail.chart?.buckets).toEqual([]);
  });

  test("the outages listed are those of the longest window, newest first, with their total", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await store.outages.open(monitor.id, base, reasons.timeout);
    await store.outages.close(monitor.id, base + minute);
    const now = base + 91 * day;
    for (let index = 0; index < 25; index += 1) {
      const at = now - 10 * day + index * hour;
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await store.outages.open(monitor.id, at, reasons.timeout);
      await store.outages.close(monitor.id, at + minute);
    }
    const result = await readMonitorDetail(store, monitor.id, options(now));
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.outagesTotal).toBe(25);
    expect(result.detail.outages).toHaveLength(20);
    expect(result.detail.outages[0]?.startedAt).toBe(
      now - 10 * day + 24 * hour
    );
  });

  test("the day bar's days run oldest first to today, each with its downtime and the outages that ran on it", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const today = Math.floor(monitor.updatedAt / day) * day + 2 * day;
    await minutes(store, monitor.id, today - hour, 3 * 60);
    // One outage across midnight, one inside today.
    await store.outages.open(monitor.id, today - 30 * minute, reasons.timeout);
    await store.outages.close(monitor.id, today + 30 * minute);
    await store.outages.open(monitor.id, today + hour, reasons.timeout);
    await store.outages.close(monitor.id, today + hour + 10 * minute);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(today + 2 * hour)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { days } = result.detail;
    const date = (at: number) => new Date(at).toISOString().slice(0, 10);
    expect(days).toHaveLength(90);
    expect(days[0]?.date).toBe(date(today - 89 * day));
    expect(days[0]?.outages).toEqual([]);
    const across = {
      endedAt: today + 30 * minute,
      monitorId: monitor.id,
      reason: reasons.timeout,
      startedAt: today - 30 * minute,
    };
    expect(days.at(-3)?.outages).toEqual([]);
    expect(days.at(-2)).toMatchObject({
      date: date(today - day),
      downtimeMs: 30 * minute,
      outages: [across],
    });
    expect(days.at(-1)).toMatchObject({
      date: date(today),
      downtimeMs: 40 * minute,
      outages: [
        across,
        {
          endedAt: today + hour + 10 * minute,
          monitorId: monitor.id,
          reason: reasons.timeout,
          startedAt: today + hour,
        },
      ],
    });
  });

  test("an outage that ended as it started at midnight ran on the day it started, not the day before", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const today = Math.floor(monitor.updatedAt / day) * day + 2 * day;
    await store.outages.open(monitor.id, today, reasons.timeout);
    await store.outages.close(monitor.id, today);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(today + hour)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.days.at(-1)?.outages).toHaveLength(1);
    expect(result.detail.days.at(-2)?.outages).toEqual([]);
  });

  test("the chart reads the range asked for, in buckets from its start to now, with the monitor's gap limit", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 10);
    const now = base + 10 * minute;
    const day24 = await readMonitorDetail(store, monitor.id, options(now));
    const week = await readMonitorDetail(store, monitor.id, {
      ...options(now),
      range: "7d",
    });
    if (!(day24.ok && week.ok)) {
      throw new Error("unavailable");
    }
    expect(day24.detail.chart).toMatchObject({
      bucketMs: 5 * minute,
      from: now - day,
      gapLimitMs: 2 * minute,
      range: "24h",
      to: now,
    });
    const checks = day24.detail.chart?.buckets.reduce(
      (sum, bucket) => sum + bucket.checks,
      0
    );
    expect(checks).toBe(10);
    expect(week.detail.chart).toMatchObject({
      bucketMs: 30 * minute,
      from: now - 7 * day,
      range: "7d",
    });
  });

  test("a zoomed span reads its own chart in finer points, still under the range it came from", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const base = monitor.updatedAt + 1000;
    await minutes(store, monitor.id, base, 10);
    const now = base + 30 * minute;
    const zoomed = await readMonitorDetail(store, monitor.id, {
      ...options(now),
      span: { from: base, to: base + 10 * minute },
    });
    if (!zoomed.ok) {
      throw new Error(zoomed.reason);
    }
    expect(zoomed.detail.chart).toMatchObject({
      bucketMs: minute,
      from: Math.floor(base / minute) * minute,
      range: "24h",
      to: base + 10 * minute,
    });
    expect(
      zoomed.detail.chart?.buckets.reduce(
        (sum, bucket) => sum + bucket.checks,
        0
      )
    ).toBe(10);
  });

  test("a span narrower than the smallest zoom reads the range as it is", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const now = monitor.updatedAt + hour;
    const read = await readMonitorDetail(store, monitor.id, {
      ...options(now),
      span: { from: now - 2 * minute, to: now },
    });
    if (!read.ok) {
      throw new Error(read.reason);
    }
    expect(read.detail.chart).toMatchObject({ from: now - day, to: now });
  });

  test("the 30 and 90 day charts read the hourly rollups, in buckets of whole hours", async () => {
    const store = await storage();
    const monitor = await store.monitors.create({
      ...site,
      intervalMs: 2 * hour,
    });
    const base = Math.floor(Date.now() / day) * day - 3 * day;
    for (let index = 0; index < 3 * 12; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order
      await store.checks.record(check(monitor.id, base + index * 2 * hour));
    }
    const now = base + 3 * day + hour;
    await sealClosedDays(store, base + 3 * day, 4 * hour);
    for (const [range, bucketMs] of [
      ["30d", 2 * hour],
      ["90d", 6 * hour],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: two reads
      const read = await readMonitorDetail(store, monitor.id, {
        ...options(now),
        range,
      });
      if (!read.ok) {
        throw new Error(read.reason);
      }
      const { chart } = read.detail;
      expect(chart?.bucketMs).toBe(bucketMs);
      expect(chart?.from).toBe(
        Math.floor((now - (range === "30d" ? 30 : 90) * day) / bucketMs) *
          bucketMs
      );
      expect(chart?.buckets.every((bucket) => bucket.at % hour === 0)).toBe(
        true
      );
      expect(
        chart?.buckets.reduce((sum, bucket) => sum + bucket.checks, 0)
      ).toBe(36);
    }
  });

  test("a heartbeat monitor has no chart, and shows its URL and last heartbeat", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(beat);
    const token = await store.monitors.heartbeatTokenOf(monitor.id);
    await store.heartbeats.record(
      token ?? "",
      monitor.updatedAt + 5,
      "10.0.0.7"
    );
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(monitor.updatedAt + minute)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.detail.chart).toBeUndefined();
    expect(result.detail.heartbeat).toEqual({
      last: { arrivedAt: monitor.updatedAt + 5, sourceIp: "10.0.0.7" },
      url: `https://raaqeb.example.test/api/heartbeat/${token}`,
    });
  });

  test("an HTTPS monitor's certificate record is read with it", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const record = {
      fingerprint: "AB:CD",
      issuer: "CN=Issuer",
      lastSeenAt: monitor.updatedAt,
      monitorId: monitor.id,
      names: ["example.test"],
      subject: "CN=example.test",
      validFrom: monitor.updatedAt - day,
      validTo: monitor.updatedAt + 90 * day,
    };
    await store.certificates.replace(record);
    const result = await readMonitorDetail(
      store,
      monitor.id,
      options(monitor.updatedAt + minute)
    );
    expect(result.ok && result.detail.certificate).toEqual(record);
  });

  test("a stored check this version cannot read names the monitor", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    await store.checks.record(check(monitor.id, monitor.updatedAt + 1));
    if (!open) {
      throw new Error("no database");
    }
    await runSql(open.location, "UPDATE checks SET reason = 250", []);
    expect(
      await readMonitorDetail(
        store,
        monitor.id,
        options(monitor.updatedAt + minute)
      )
    ).toEqual({ id: monitor.id, ok: false, reason: "corrupt" });
  });
});

describe("one check's record", () => {
  test("a down check opens to its failure detail and its capture, the body as text", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const at = monitor.updatedAt + 1;
    const outcome = check(monitor.id, at, "down");
    await store.checks.record({
      ...outcome,
      capture: {
        body: new TextEncoder().encode("<h1>عطل</h1>"),
        headers: [{ name: "content-type", value: "text/html" }],
        monitorId: monitor.id,
        startedAt: at,
      },
    });
    expect(await readCheckRecord(store, monitor.id, at)).toEqual({
      ok: true,
      record: {
        capture: {
          body: "<h1>عطل</h1>",
          headers: [{ name: "content-type", value: "text/html" }],
        },
        failure: {
          assertion: undefined,
          error: "The operation timed out.",
          params: { reason: "timeout", timeoutMs: 10_000 },
        },
      },
    });
  });

  test("a check that kept neither opens to none of either; a database that cannot answer is unavailable", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    expect(await readCheckRecord(store, monitor.id, 1)).toEqual({
      ok: true,
      record: { capture: undefined, failure: undefined },
    });
    expect(await readCheckRecord(broken(store), monitor.id, 1)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("check now", () => {
  function requests(answer: "queued" | "running") {
    const asked: string[] = [];
    const scheduler: CheckRequests = {
      checkNow: (id) => {
        asked.push(id);
        return { answer, from: 1_700_000_000_000 };
      },
    };
    return { asked, scheduler };
  }

  test("hands an active monitor to the scheduler and answers what it said, with when the asked check starts", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    const { asked, scheduler } = requests("running");
    expect(await checkNow(store, scheduler, monitor.id)).toEqual({
      answer: "running",
      from: 1_700_000_000_000,
      ok: true,
    });
    expect(asked).toEqual([monitor.id]);
  });

  test("refuses a paused monitor, a heartbeat monitor and an unknown one, without asking the scheduler", async () => {
    const store = await storage();
    const paused = await store.monitors.create(site);
    await store.monitors.pause([paused.id]);
    const heartbeat = await store.monitors.create(beat);
    const { asked, scheduler } = requests("queued");
    expect(await checkNow(store, scheduler, paused.id)).toEqual({
      ok: false,
      reason: "paused",
    });
    expect(await checkNow(store, scheduler, heartbeat.id)).toEqual({
      ok: false,
      reason: "heartbeat",
    });
    expect(await checkNow(store, scheduler, "nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(asked).toEqual([]);
  });

  test("with no scheduler, or a database that cannot answer, it is unavailable", async () => {
    const store = await storage();
    const monitor = await store.monitors.create(site);
    expect(await checkNow(store, undefined, monitor.id)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(
      await checkNow(broken(store), requests("queued").scheduler, monitor.id)
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe('acknowledging an outage (CONTEXT.md "Acknowledge")', () => {
  function told() {
    const outages: Outage[] = [];
    const scheduler: OutageRequests = {
      acknowledge: (outage) => {
        outages.push(outage);
      },
    };
    return { outages, scheduler };
  }

  /** A monitor down since its outage opened a second after it was saved. */
  async function downMonitor(store: Storage) {
    const monitor = await store.monitors.create(site);
    const startedAt = monitor.updatedAt + 1000;
    await store.outages.open(monitor.id, startedAt, reasons.timeout);
    return { id: monitor.id, startedAt };
  }

  test("stores when the open outage was acknowledged, hands it to the scheduler and moves the change counter; the outage stays open", async () => {
    const store = await storage();
    const { id, startedAt } = await downMonitor(store);
    const { outages, scheduler } = told();
    const before = await store.changeCounter();
    const at = startedAt + 5 * minute;
    expect(
      await acknowledgeOutage(store, scheduler, { id, startedAt }, at)
    ).toEqual({
      acknowledgedAt: at,
      ok: true,
    });
    const acknowledged = {
      acknowledgedAt: at,
      endedAt: undefined,
      monitorId: id,
      reason: reasons.timeout,
      startedAt,
    };
    expect(await store.outages.list(id)).toEqual([acknowledged]);
    expect(outages).toEqual([acknowledged]);
    expect(await store.changeCounter()).toBe(before + 1);
  });

  test("refuses a monitor with no open outage, and one whose outage was acknowledged before, telling the scheduler nothing and moving no counter", async () => {
    const store = await storage();
    const up = await store.monitors.create(site);
    const { id, startedAt } = await downMonitor(store);
    const { outages, scheduler } = told();
    await acknowledgeOutage(
      store,
      scheduler,
      { id, startedAt },
      startedAt + minute
    );
    outages.length = 0;
    const before = await store.changeCounter();
    expect(
      await acknowledgeOutage(
        store,
        scheduler,
        { id: up.id, startedAt },
        startedAt
      )
    ).toEqual({ ok: false, reason: "no_outage" });
    expect(
      await acknowledgeOutage(
        store,
        scheduler,
        { id: "nope", startedAt },
        startedAt
      )
    ).toEqual({ ok: false, reason: "no_outage" });
    expect(
      await acknowledgeOutage(
        store,
        scheduler,
        { id, startedAt },
        startedAt + 2 * minute
      )
    ).toEqual({ ok: false, reason: "acknowledged" });
    expect((await store.outages.list(id))[0]?.acknowledgedAt).toBe(
      startedAt + minute
    );
    expect(outages).toEqual([]);
    expect(await store.changeCounter()).toBe(before);
  });

  test("refuses the outage a screen showed once it recovered, and leaves the outage opened since unacknowledged", async () => {
    const store = await storage();
    const { id, startedAt } = await downMonitor(store);
    await store.outages.close(id, startedAt + minute);
    await store.outages.open(id, startedAt + 2 * minute, reasons.timeout);
    const { outages, scheduler } = told();
    expect(
      await acknowledgeOutage(
        store,
        scheduler,
        { id, startedAt },
        startedAt + 3 * minute
      )
    ).toEqual({ ok: false, reason: "no_outage" });
    expect(
      (await store.outages.ongoing()).map((each) => each.acknowledgedAt)
    ).toStrictEqual([undefined]);
    expect(outages).toEqual([]);
  });

  test("a paused monitor has nothing to acknowledge: the pause closed its outage", async () => {
    const store = await storage();
    const { id, startedAt } = await downMonitor(store);
    await store.monitors.pause([id]);
    expect(
      await acknowledgeOutage(
        store,
        told().scheduler,
        { id, startedAt },
        Date.now()
      )
    ).toEqual({ ok: false, reason: "no_outage" });
    expect((await store.outages.list(id))[0]?.startedAt).toBe(startedAt);
  });

  test("with no scheduler running, the acknowledgement is still stored, for the reminders to read when it starts", async () => {
    const store = await storage();
    const { id, startedAt } = await downMonitor(store);
    expect(
      await acknowledgeOutage(
        store,
        undefined,
        { id, startedAt },
        startedAt + minute
      )
    ).toEqual({ acknowledgedAt: startedAt + minute, ok: true });
    expect((await store.outages.ongoing())[0]?.acknowledgedAt).toBe(
      startedAt + minute
    );
  });

  test("a database that cannot answer is unavailable, and never throws", async () => {
    const store = await storage();
    const { id, startedAt } = await downMonitor(store);
    const failing = () => Promise.reject(new Error("database gone"));
    expect(
      await acknowledgeOutage(
        { ...store, outages: { ...store.outages, acknowledge: failing } },
        told().scheduler,
        { id, startedAt },
        startedAt + minute
      )
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

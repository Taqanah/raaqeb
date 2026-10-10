import { afterEach, describe, expect, test } from "bun:test";
import {
  checksEveryMinute,
  d0,
  day,
  hour,
  type PagesScratch,
  scratchPages,
  site,
} from "@/server/pages/fixture.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { dayView, readMonitorDays } from "./days.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const today = d0 + day;
const noon = today + 12 * hour;

describe("a monitor's own days for the list's bar", () => {
  test("a day counts the monitor's outage over its observed time, with its mean response time", async () => {
    scratch = await scratchPages(today);
    const { storage } = scratch;
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, today, today + 11 * hour, "up");
    await checksEveryMinute(storage, monitor, today + 11 * hour, noon, "down");
    await storage.outages.open(monitor.id, today + 11 * hour, reasons.timeout);
    const days = await readMonitorDays(storage, [monitor], {
      days: 2,
      now: noon,
    });
    expect(days.get(monitor.id)).toEqual([
      {
        day: d0,
        downtimeMs: 0,
        incidents: [],
        maintenance: [],
        observedMs: 0,
        responseMs: undefined,
      },
      {
        day: today,
        downtimeMs: hour,
        incidents: [],
        maintenance: [],
        observedMs: 12 * hour,
        responseMs: 120,
      },
    ]);
  });

  test("a window that covered the monitor is neither observed time nor downtime, and is named on its day", async () => {
    scratch = await scratchPages(today);
    const { at, storage } = scratch;
    const monitor = await storage.monitors.create(site);
    const web = await storage.components.create({
      description: undefined,
      monitorIds: [monitor.id],
      name: { ar: "الموقع" },
      status: "operational",
    });
    const window = await storage.maintenance.create({
      componentIds: [web.id],
      endsAt: noon,
      message: { ar: "نص" },
      startsAt: today + 10 * hour,
      title: { ar: "صيانة" },
    });
    at(today + 10 * hour);
    await storage.maintenance.advance(today + 10 * hour);
    await checksEveryMinute(storage, monitor, today, today + 10 * hour, "up");
    await checksEveryMinute(storage, monitor, today + 10 * hour, noon, "down");
    await storage.outages.open(monitor.id, today + 10 * hour, reasons.timeout);
    const days = await readMonitorDays(storage, [monitor], {
      days: 1,
      now: noon,
    });
    expect(days.get(monitor.id)).toEqual([
      {
        day: today,
        downtimeMs: 0,
        incidents: [],
        maintenance: [{ id: window.id, title: { ar: "صيانة" } }],
        observedMs: 10 * hour,
        responseMs: 120,
      },
    ]);
  });
});

describe("the bars' reads of history", () => {
  /** A repository whose every call adds one to `count`. */
  function counted<T extends object>(repository: T, count: { n: number }): T {
    return new Proxy(repository, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          count.n += 1;
          return Reflect.apply(value, target, args);
        };
      },
    });
  }

  async function readsFor(monitorCount: number): Promise<number> {
    scratch = await scratchPages(today);
    const { storage } = scratch;
    const monitors = await Promise.all(
      Array.from({ length: monitorCount }, (_, index) =>
        storage.monitors.create({ ...site, name: `site ${index}` })
      )
    );
    for (const monitor of monitors) {
      // biome-ignore lint/performance/noAwaitInLoops: one monitor's checks after another, as the scheduler writes them
      await checksEveryMinute(storage, monitor, today, today + hour, "up");
      await storage.outages.open(monitor.id, today + hour, reasons.timeout);
    }
    const count = { n: 0 };
    await readMonitorDays(
      {
        ...storage,
        checks: counted(storage.checks, count),
        outages: counted(storage.outages, count),
      },
      monitors,
      { days: 30, now: noon }
    );
    await scratch.cleanup();
    scratch = undefined;
    return count.n;
  }

  test("are as many for ten monitors as for one: no round trip per monitor, which a remote database pays in full", async () => {
    const one = await readsFor(1);
    expect(await readsFor(10)).toBe(one);
  });
});

describe("a bar day as a document carries it", () => {
  test("it has its UTC date, its parts, its displayed uptime and nulls for what it lacks", () => {
    expect(
      dayView({
        day: today,
        downtimeMs: hour,
        incidents: [],
        maintenance: [{ id: "w1", title: { ar: "صيانة" } }],
        observedMs: 12 * hour,
        responseMs: 120,
      })
    ).toEqual({
      date: "2026-09-02",
      downtimeMs: hour,
      incidents: [],
      maintenance: [{ id: "w1", title: { ar: "صيانة" } }],
      observedMs: 12 * hour,
      responseMs: 120,
      uptime: { decimals: 2, percent: 91.66 },
    });
    expect(
      dayView({
        day: today,
        downtimeMs: 0,
        incidents: [],
        maintenance: [],
        observedMs: 0,
        responseMs: undefined,
      })
    ).toMatchObject({ responseMs: null, uptime: null });
  });
});

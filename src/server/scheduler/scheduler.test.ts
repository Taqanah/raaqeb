import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import { type LiveIo, liveIo } from "@/server/checks/io.ts";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { readMonitorDetail } from "@/server/monitors/detail.ts";
import {
  createMonitor,
  editMonitor,
  pauseMonitors,
  resumeMonitors,
} from "@/server/monitors/monitors.ts";
import { type FakeSmtp, fakeSmtp, parse } from "@/server/notify/fixture.ts";
import type { SubscriberEvent } from "@/server/notify/subscribers.ts";
import { newSigningSecret } from "@/server/notify/webhook.ts";
import { readComponentStatuses } from "@/server/pages/components.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { timeZone } from "@/server/settings/clock.ts";
import { retentionDays, sizeBudgetBytes } from "@/server/settings/retention.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  type OpenStorageOptions,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import { askedCheckLanded } from "@/shared/domain/checks.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import type { HttpConfig, MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { exitAfterMs } from "./health.ts";
import {
  type MonitorEvent,
  refreshPeriodMs,
  sealingDelayMs,
  spreadWindowMs,
} from "./schedule.ts";
import { createScheduler, type SchedulerOptions } from "./scheduler.ts";

const byText = (a: string, b: string) => a.localeCompare(b);

const key = await scratchInstallKey();

/** How the local target answers: "slow" after a delay, "held" only once the test releases it. */
type Mode = "ok" | "error" | "slow" | "held";

interface Harness {
  advance: (ms: number) => void;
  count: (monitorId: string) => Promise<number>;
  events: MonitorEvent[];
  io: LiveIo;
  location: DatabaseLocation;
  port: number;
  /** Lets the held requests answer, those still on their way included, so the check in flight settles. */
  release: () => void;
  /** The request headers the local target got, in order. */
  seen: Headers[];
  /** Sets how the target answers; a slow answer takes `slowMs`, past any degraded threshold under it. */
  setMode: (mode: Mode, slowMs?: number) => void;
  storage: Storage;
}

let open:
  | {
      cleanup: () => Promise<void>;
      server: Bun.Server<undefined>;
      storage: Storage;
    }
  | undefined;

/** A local target whose answer the test flips, the open storage, and the live I/O on a clock the test moves. */
async function harness(options: OpenStorageOptions = {}): Promise<Harness> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location, options);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  let mode: Mode = "ok";
  let slow = 0;
  const hold = Promise.withResolvers<undefined>();
  const seen: Headers[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      seen.push(request.headers);
      if (mode === "slow") {
        await Bun.sleep(slow);
      }
      if (mode === "held") {
        await hold.promise;
      }
      const failing = mode === "error";
      return new Response(failing ? "error" : "hello", {
        status: failing ? 500 : 200,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  open = { cleanup: scratch.cleanup, server, storage: opened.storage };
  if (server.port === undefined) {
    throw new Error("the local target has no port");
  }
  const { port } = server;
  let offset = 0;
  const live = liveIo();
  const io: LiveIo = {
    ...live,
    now: () => Date.now() + offset,
    sleep: () => Promise.resolve(),
  };
  return {
    advance: (ms) => {
      offset += ms;
    },
    count: async (monitorId) =>
      (await opened.storage.checks.range(monitorId, 0, Number.MAX_SAFE_INTEGER))
        .length,
    events: [],
    io,
    location: scratch.location,
    port,
    release: () => hold.resolve(undefined),
    seen,
    setMode: (next, slowMs = 10) => {
      mode = next;
      slow = slowMs;
    },
    storage: opened.storage,
  };
}

afterEach(async () => {
  if (open) {
    await open.server.stop(true);
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const http = (port: number, path = "/"): HttpConfig => ({
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: `http://127.0.0.1:${port}${path}`,
});

const input = (
  name: string,
  config: MonitorInput["config"],
  overrides: Partial<MonitorInput> = {}
): MonitorInput => ({
  config,
  intervalMs: 20_000,
  name,
  retries: 1,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 5000,
  ...overrides,
});

/** The three monitors of the plan's "done when": two HTTP and one TCP, all at the local target. */
async function threeMonitors(h: Harness) {
  const site = await h.storage.monitors.create(input("Site", http(h.port)));
  const body = await h.storage.monitors.create(
    input("Body", {
      ...http(h.port, "/status"),
      assertions: [
        { codes: ["2xx"], kind: "status" },
        { kind: "body_contains", text: "hello" },
      ],
    })
  );
  const port = await h.storage.monitors.create(
    input("Port", { host: "127.0.0.1", port: h.port, type: "tcp" })
  );
  return { body, port, site };
}

function scheduler(h: Harness, options: Partial<SchedulerOptions> = {}) {
  return createScheduler(h.storage, h.io, {
    installKey: key,
    onEvent: (event) => h.events.push(event),
    // The five-minute refresh has its own tests; the counts of the others stay exact across long advances.
    refreshPeriodMs: Number.POSITIVE_INFINITY,
    ...options,
  });
}

describe("the scheduler over three monitors and a local target", () => {
  test("first runs are spread over the window after boot, then each monitor runs once per interval", async () => {
    const h = await harness();
    const { body, port, site } = await threeMonitors(h);
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    expect(await h.count(site.id)).toBe(1);
    expect(await h.count(body.id)).toBe(0);
    expect(await h.count(port.id)).toBe(0);
    h.advance(spreadWindowMs);
    await s.tick();
    await s.idle();
    // Site was due again at 20 s; Body at 10 s and Port at 20 s ran their first.
    expect(await h.count(site.id)).toBe(2);
    expect(await h.count(body.id)).toBe(1);
    expect(await h.count(port.id)).toBe(1);
    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect(await h.count(site.id)).toBe(3);
    expect(await h.count(body.id)).toBe(2);
    expect(await h.count(port.id)).toBe(2);
    for (const check of await h.storage.checks.latest()) {
      expect(check.result).toBe("up");
      expect(check.reason).toBe(reasons.ok);
    }
  });

  test("an outage opens on the first confirmed down check and closes on the first recovered one; the counter moves on each transition and on every failing check while down", async () => {
    const h = await harness();
    const { body, port, site } = await threeMonitors(h);
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    h.advance(spreadWindowMs);
    await s.tick();
    await s.idle();
    const c0 = await h.storage.changeCounter();
    h.setMode("error");
    h.advance(20_000);
    await s.tick();
    await s.idle();
    const ongoing = await h.storage.outages.ongoing();
    const byId = (a: string, b: string) => a.localeCompare(b);
    expect(ongoing.map((o) => o.monitorId).toSorted(byId)).toEqual(
      [body.id, site.id].toSorted(byId)
    );
    for (const outage of ongoing) {
      expect(outage.reason).toBe(reasons.unexpected_status);
      expect(outage.endedAt).toBeUndefined();
    }
    const down = (await h.storage.checks.latest()).filter(
      (c) => c.monitorId !== port.id
    );
    expect(down.map((c) => c.result)).toEqual(["down", "down"]);
    expect(down.map((c) => c.attempts)).toEqual([2, 2]);
    const byTime = (a: number, b: number) => a - b;
    expect(ongoing.map((o) => o.startedAt).toSorted(byTime)).toEqual(
      down.map((c) => c.startedAt).toSorted(byTime)
    );
    expect(await h.storage.changeCounter()).toBe(c0 + 2);
    expect(h.events.map((e) => e.kind)).toEqual(["down", "down"]);

    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect(await h.storage.outages.ongoing()).toEqual(ongoing);
    expect(await h.storage.changeCounter()).toBe(c0 + 4);
    expect(h.events).toHaveLength(2);

    h.setMode("ok");
    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect(await h.storage.outages.ongoing()).toEqual([]);
    const [closed] = await h.storage.outages.list(site.id);
    const [latest] = await h.storage.checks
      .range(site.id, closed?.startedAt ?? 0, Number.MAX_SAFE_INTEGER)
      .then((rows) => rows.slice(-1));
    expect(closed?.endedAt).toBe(latest?.startedAt);
    expect(await h.storage.changeCounter()).toBe(c0 + 6);
    expect(h.events.slice(2).map((e) => e.kind)).toEqual([
      "recovered",
      "recovered",
    ]);
    expect(h.events[2]).toMatchObject({ reason: reasons.ok });
  });

  test("a degraded check is a success: it starts degraded, opens no outage, and closes one that is open", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(
      input("Site", http(h.port), { degradedMs: 1 })
    );
    const s = scheduler(h);
    h.setMode("slow");
    await s.tick();
    await s.idle();
    const c0 = await h.storage.changeCounter();
    expect((await h.storage.checks.latest())[0]?.result).toBe("degraded");
    expect(await h.storage.outages.ongoing()).toEqual([]);
    expect(h.events.map((e) => e.kind)).toEqual(["degraded_started"]);

    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect(await h.storage.changeCounter()).toBe(c0);
    expect(h.events).toHaveLength(1);

    h.setMode("error");
    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect((await h.storage.outages.ongoing()).map((o) => o.monitorId)).toEqual(
      [id]
    );
    // Down alone speaks for a degraded monitor going down.
    expect(h.events.slice(1).map((e) => e.kind)).toEqual(["down"]);

    h.setMode("slow");
    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect(await h.storage.outages.ongoing()).toEqual([]);
    expect(h.events.slice(2).map((e) => e.kind)).toEqual([
      "recovered",
      "degraded_started",
    ]);
    expect(await h.storage.changeCounter()).toBe(c0 + 2);
  });

  test("a paused monitor runs no check and pausing closes its outage at the pause time; a resumed one runs at once", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    h.setMode("error");
    await s.tick();
    await s.idle();
    expect(await h.storage.outages.ongoing()).toHaveLength(1);
    const before = Date.now();
    expect(await pauseMonitors(h.storage, [id])).toEqual({
      count: 1,
      ok: true,
    });
    const endedAt = (await h.storage.outages.list(id))[0]?.endedAt;
    expect(endedAt).toBeGreaterThanOrEqual(before);
    expect(endedAt).toBeLessThanOrEqual(Date.now());
    h.advance(20_000);
    await s.tick();
    await s.idle();
    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(1);

    await h.storage.monitors.resume([id]);
    await h.storage.bump();
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(2);
    expect(await h.storage.outages.list(id)).toHaveLength(2);
  });

  test("a monitor the operator creates runs at the next tick, and the monitors are re-read only when the operator changed something", async () => {
    const h = await harness();
    await h.storage.monitors.create(input("Site", http(h.port)));
    const list = spyOn(h.storage.monitors, "list");
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    expect(list).toHaveBeenCalledTimes(1);
    h.setMode("error");
    h.advance(20_000);
    await s.tick();
    await s.idle();
    h.advance(20_000);
    await s.tick();
    await s.idle();
    // Two own bumps (the down transition, a failing check while down) are not the operator's.
    expect(list).toHaveBeenCalledTimes(1);

    const created = await createMonitor(
      h.storage,
      key,
      input("API", http(h.port))
    );
    if (!created.ok) {
      throw new Error(created.reason);
    }
    await s.tick();
    await s.idle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(await h.count(created.monitor.id)).toBe(1);
  });

  test("a monitor with a check in flight is not started again", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    h.setMode("held");
    await s.tick();
    h.advance(60_000);
    await s.tick();
    h.release();
    await s.idle();
    expect(await h.count(id)).toBe(1);
  });

  test("check now runs the monitor's next check at the next tick, recorded like any check, and the cadence continues one interval after it", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(1);
    h.advance(5000);
    h.setMode("error");
    expect(s.checkNow(id).answer).toBe("queued");
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(2);
    // Recorded like any check: the down check opened an outage and raised down.
    expect(await h.storage.outages.ongoing()).toHaveLength(1);
    expect(h.events.map((event) => event.kind)).toEqual(["down"]);
    h.setMode("ok");
    h.advance(19_000);
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(2);
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(3);
  });

  test("check now while a check is in flight answers running and starts no second one", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    h.setMode("held");
    await s.tick();
    expect(s.checkNow(id).answer).toBe("running");
    await s.tick();
    h.release();
    await s.idle();
    expect(await h.count(id)).toBe(1);
  });

  /** The start times of the monitor's checks, oldest first. */
  async function starts(h: Harness, id: string): Promise<number[]> {
    return (await h.storage.checks.range(id, 0, Number.MAX_SAFE_INTEGER))
      .map((check) => check.startedAt)
      .toSorted((a, b) => a - b);
  }

  test("check now answered queued waits for the check the next tick brings forward, not one that landed before the ask", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    h.advance(5000);
    const asked = s.checkNow(id);
    expect(asked.answer).toBe("queued");
    const [landed] = await starts(h, id);
    expect(askedCheckLanded(landed, asked.from)).toBe(false);
    h.advance(1000);
    await s.tick();
    await s.idle();
    const [, brought] = await starts(h, id);
    expect(askedCheckLanded(brought, asked.from)).toBe(true);
  });

  test("check now asked while a tick that read its time before the ask is under way waits for the check that tick brings forward", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    h.advance(5000);
    const ticking = s.tick();
    h.advance(1000);
    const asked = s.checkNow(id);
    expect(asked.answer).toBe("queued");
    await ticking;
    await s.idle();
    const [landed, brought] = await starts(h, id);
    expect(brought).toBeDefined();
    expect(askedCheckLanded(landed, asked.from)).toBe(false);
    expect(askedCheckLanded(brought, asked.from)).toBe(true);
  });

  test("check now answered running waits for the check in flight, not the one before it", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    h.setMode("held");
    h.advance(20_000);
    await s.tick();
    // The ask arrives a while after the check in flight started.
    h.advance(1000);
    const asked = s.checkNow(id);
    expect(asked.answer).toBe("running");
    h.release();
    await s.idle();
    const [before, inFlight] = await starts(h, id);
    expect(askedCheckLanded(before, asked.from)).toBe(false);
    expect(askedCheckLanded(inFlight, asked.from)).toBe(true);
  });

  test("check now asked for a paused monitor runs nothing", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    await h.storage.monitors.pause([id]);
    await h.storage.bump();
    s.checkNow(id);
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(1);
  });

  test("a heartbeat monitor sends no request, and has no check before its first window closes", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(
      input("Backup", {
        schedule: { everyMs: 3_600_000, kind: "every" },
        type: "heartbeat",
      })
    );
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    h.advance(spreadWindowMs);
    await s.tick();
    await s.idle();
    expect(await h.count(id)).toBe(0);
    expect(h.seen).toEqual([]);
  });

  test("the tick records its time, and the watchdog asks the entry to exit once the last tick is five minutes old", async () => {
    const h = await harness();
    const stale: number[] = [];
    const s = scheduler(h, { onStale: (since) => stale.push(since) });
    expect(s.lastTickAt()).toBeUndefined();
    const before = h.io.now();
    await s.tick();
    const ticked = s.lastTickAt();
    expect(ticked).toBeGreaterThanOrEqual(before);
    expect(ticked).toBeLessThanOrEqual(h.io.now());
    // The harness clock is real time plus an offset, so the bound is approached with a second to spare.
    h.advance(exitAfterMs - 1000);
    s.watch();
    expect(stale).toEqual([]);
    h.advance(1000);
    s.watch();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBeGreaterThanOrEqual(exitAfterMs);
  });

  test("stopping drops a check still in flight", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    h.setMode("held");
    await s.tick();
    await s.stop();
    h.release();
    await s.idle();
    expect(await h.count(id)).toBe(0);
    expect(await h.storage.outages.ongoing()).toEqual([]);
  });

  test("a stored monitor this version cannot read is logged by id and the schedule stays as it was", async () => {
    const h = await harness();
    const site = await h.storage.monitors.create(input("Site", http(h.port)));
    const api = await h.storage.monitors.create(input("API", http(h.port)));
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    h.advance(spreadWindowMs);
    await s.tick();
    await s.idle();
    await runSql(h.location, "UPDATE monitors SET config = ? WHERE id = ?", [
      "{}",
      api.id,
    ]);
    await h.storage.bump();
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      h.advance(20_000);
      await s.tick();
      await s.idle();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain(api.id);
      expect(String(stderr.mock.calls[0]?.[0])).not.toContain("{}");
    } finally {
      stderr.mockRestore();
    }
    expect(await h.count(site.id)).toBe(3);
    expect(await h.count(api.id)).toBe(2);
  });

  test("a monitors read that fails is tried again on the next tick, and the first read that succeeds still spreads the first runs", async () => {
    const h = await harness();
    const site = await h.storage.monitors.create(input("Site", http(h.port)));
    const api = await h.storage.monitors.create(input("API", http(h.port)));
    let failures = 1;
    const s = createScheduler(
      {
        ...h.storage,
        monitors: {
          ...h.storage.monitors,
          list: () => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(new Error("database blip"));
            }
            return h.storage.monitors.list();
          },
        },
      },
      h.io,
      { installKey: key }
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await s.tick();
      await s.idle();
      expect(await h.count(site.id)).toBe(0);
      await s.tick();
      await s.idle();
    } finally {
      stderr.mockRestore();
    }
    // The spread: Site at once, API half a window later, never both at once.
    expect(await h.count(site.id)).toBe(1);
    expect(await h.count(api.id)).toBe(0);
    h.advance(spreadWindowMs / 2);
    await s.tick();
    await s.idle();
    expect(await h.count(api.id)).toBe(1);
  });

  test("a check that outlives a pause and a resume opens no outage over the paused time", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    // The check's request is held until the pause, the resume and the bump are done.
    const requested = Promise.withResolvers<undefined>();
    const reply = Promise.withResolvers<undefined>();
    const held = ((resource: string | URL | Request, init?: RequestInit) => {
      requested.resolve(undefined);
      return reply.promise.then(() => h.io.fetch(resource, init));
    }) as typeof fetch;
    const s = scheduler({ ...h, io: { ...h.io, fetch: held } });
    h.setMode("error");
    await s.tick();
    await requested.promise;
    // The storage stamps the pause with the real clock, so it must land in a later millisecond than the check's start.
    await Bun.sleep(2);
    // The check is in flight; the operator pauses and resumes before it settles down.
    await pauseMonitors(h.storage, [id]);
    await h.storage.monitors.resume([id]);
    await h.storage.bump();
    reply.resolve(undefined);
    await s.idle();
    expect((await h.storage.checks.latest())[0]?.result).toBe("down");
    expect(await h.storage.outages.ongoing()).toEqual([]);
    // The next check, started after the resume, speaks for the monitor and opens the outage.
    h.setMode("error");
    h.advance(20_000);
    await s.tick();
    await s.idle();
    const [outage] = await h.storage.outages.ongoing();
    expect(outage?.startedAt).toBe(
      (await h.storage.checks.latest())[0]?.startedAt
    );
  });

  test("stopping waits for a settlement already under way, so no write lands after the storage closes", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const recording = Promise.withResolvers<undefined>();
    const s = createScheduler(
      {
        ...h.storage,
        checks: {
          ...h.storage.checks,
          record: async (outcome) => {
            recording.resolve(undefined);
            await Bun.sleep(100);
            await h.storage.checks.record(outcome);
          },
        },
      },
      h.io,
      { installKey: key }
    );
    h.setMode("error");
    await s.tick();
    await recording.promise;
    await s.stop();
    expect(await h.count(id)).toBe(1);
    expect(await h.storage.outages.ongoing()).toHaveLength(1);
  });

  test("a certificate read that ends after stop writes no record", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(
      input("Site", {
        ...http(h.port),
        tlsExpiryDays: 14,
        url: "https://example.test/",
      })
    );
    const reading = Promise.withResolvers<undefined>();
    const read = Promise.withResolvers<undefined>();
    const s = createScheduler(
      h.storage,
      {
        ...h.io,
        // The check answers at once, so waiting for the scheduler waits only for the pass.
        fetch: ((_resource: string | URL | Request) =>
          Promise.resolve(new Response("hello"))) as typeof fetch,
        readTls: async () => {
          reading.resolve(undefined);
          await read.promise;
          return {
            fingerprint256: "AA:BB",
            issuer: { CN: "issuer" },
            subject: { CN: "example.test" },
            valid_from: "Jan  1 00:00:00 2026 GMT",
            valid_to: "Jan  1 00:00:00 2027 GMT",
          };
        },
      },
      { installKey: key }
    );
    await s.tick();
    await reading.promise;
    await s.stop();
    read.resolve(undefined);
    await s.idle();
    expect(await h.storage.certificates.find(id)).toBeUndefined();
  });

  test("the certificate reader's pass stores the record it read, and waiting for the scheduler waits for the pass", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(
      input("Site", {
        ...http(h.port),
        tlsExpiryDays: 14,
        url: "https://example.test/",
      })
    );
    const s = createScheduler(
      h.storage,
      {
        ...h.io,
        readTls: async () => {
          await Bun.sleep(30);
          return {
            fingerprint256: "AA:BB",
            issuer: { CN: "issuer" },
            subject: { CN: "example.test" },
            valid_from: "Jan  1 00:00:00 2026 GMT",
            valid_to: "Jan  1 00:00:00 2027 GMT",
          };
        },
      },
      { installKey: key }
    );
    await s.tick();
    await s.idle();
    expect(await h.storage.certificates.find(id)).toMatchObject({
      fingerprint: "AA:BB",
      monitorId: id,
    });
    await s.stop();
  });

  test("stopping waits for a certificate record write already under way, so it lands before the storage closes", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(
      input("Site", {
        ...http(h.port),
        tlsExpiryDays: 14,
        url: "https://example.test/",
      })
    );
    const writing = Promise.withResolvers<undefined>();
    let landed = false;
    const s = createScheduler(
      {
        ...h.storage,
        certificates: {
          ...h.storage.certificates,
          replace: async (record) => {
            writing.resolve(undefined);
            await Bun.sleep(60);
            await h.storage.certificates.replace(record);
            landed = true;
          },
        },
      },
      {
        ...h.io,
        readTls: () =>
          Promise.resolve({
            fingerprint256: "AA:BB",
            issuer: { CN: "issuer" },
            subject: { CN: "example.test" },
            valid_from: "Jan  1 00:00:00 2026 GMT",
            valid_to: "Jan  1 00:00:00 2027 GMT",
          }),
      },
      { installKey: key }
    );
    await s.tick();
    await writing.promise;
    await s.stop();
    expect(landed).toBe(true);
    expect(await h.storage.certificates.find(id)).toMatchObject({
      fingerprint: "AA:BB",
    });
  });

  test("a latest-checks read that fails at boot is tried again before any check starts, so a restart never repeats a degraded event", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(
      input("Site", http(h.port), { degradedMs: 1 })
    );
    await h.storage.checks.record({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 5,
        monitorId: id,
        reason: reasons.ok,
        responseMs: 300,
        result: "degraded",
        startedAt: h.io.now() - 20_000,
        statusCode: 200,
      },
      detail: undefined,
    });
    let failures = 1;
    const s = createScheduler(
      {
        ...h.storage,
        checks: {
          ...h.storage.checks,
          latest: () => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(new Error("database blip"));
            }
            return h.storage.checks.latest();
          },
        },
      },
      h.io,
      { installKey: key, onEvent: (event) => h.events.push(event) }
    );
    h.setMode("slow");
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await s.tick();
      await s.idle();
      // No check starts until the states are known: one tick's delay, never a repeated event.
      expect(await h.count(id)).toBe(1);
      await s.tick();
      await s.idle();
    } finally {
      stderr.mockRestore();
    }
    expect(await h.count(id)).toBe(2);
    expect((await h.storage.checks.latest())[0]?.result).toBe("degraded");
    expect(h.events).toEqual([]);
  });

  test("a change counter that cannot be read is logged and the tick starts nothing, without throwing", async () => {
    const h = await harness();
    await h.storage.monitors.create(input("Site", http(h.port)));
    const s = createScheduler(
      {
        ...h.storage,
        changeCounter: () => Promise.reject(new Error("database gone")),
      },
      h.io,
      { installKey: key }
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await s.tick();
      await s.idle();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain("change counter");
    } finally {
      stderr.mockRestore();
    }
    expect(await h.storage.checks.latest()).toEqual([]);
    expect(s.lastTickAt()).toBeDefined();
  });

  test("a monitor deleted while its check is in flight is logged by id when the check cannot be recorded, and nothing else stops", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h);
    h.setMode("held");
    await s.tick();
    await h.storage.monitors.remove([id]);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      h.release();
      await s.idle();
      expect(stderr).toHaveBeenCalledTimes(1);
      // The failed query's own message carries the id among its parameters, so the scheduler's words must name the monitor.
      expect(String(stderr.mock.calls[0]?.[0])).toContain(`monitor ${id}`);
    } finally {
      stderr.mockRestore();
    }
    expect(await h.storage.checks.latest()).toEqual([]);
    expect(await h.storage.outages.ongoing()).toEqual([]);
  });

  test("a check that cannot be recorded logs the monitor and the reason, never the values of its capture", async () => {
    const h = await harness();
    const secret = "s3cret-header-value";
    const target = Bun.serve({
      fetch: async () => {
        await Bun.sleep(100);
        return new Response("hello", { headers: { "x-trace": secret } });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const { id } = await h.storage.monitors.create(
        input("Site", { ...http(target.port ?? 0), captureMode: "always" })
      );
      const s = scheduler(h);
      await s.tick();
      await runSql(h.location, "DROP TABLE captures");
      await s.idle();
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      const line = lines.find((text) => text.includes("could not be recorded"));
      expect(line).toContain(id);
      expect(line).not.toContain(secret);
    } finally {
      stderr.mockRestore();
      await target.stop(true);
    }
  });

  test("the certificate reader's pass runs on its own cadence beside the checks, at the period the entry hands in", async () => {
    const h = await harness();
    const list = spyOn(h.storage.certificates, "list");
    // Not the default period, so a pass that ignored the one handed in would run off this cadence.
    const s = scheduler(h, { certificatePeriodMs: 5000 });
    await s.tick();
    await s.idle();
    expect(list).toHaveBeenCalledTimes(1);
    h.advance(4000);
    await s.tick();
    await s.idle();
    expect(list).toHaveBeenCalledTimes(1);
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("start ticks at once and then every period; stop ends it", async () => {
    const h = await harness();
    const { id } = await h.storage.monitors.create(input("Site", http(h.port)));
    const s = scheduler(h, { tickPeriodMs: 20, watchdogPeriodMs: 20 });
    s.start();
    expect(s.lastTickAt()).toBeDefined();
    await s.idle();
    await Bun.sleep(30);
    await s.idle();
    expect(await h.count(id)).toBe(1);
    h.advance(20_000);
    await Bun.sleep(60);
    await s.idle();
    expect(await h.count(id)).toBe(2);
    await s.stop();
    const ticked = s.lastTickAt();
    await Bun.sleep(50);
    expect(s.lastTickAt()).toBe(ticked);
  });
});

describe("an HTTP monitor's credentials on its scheduled checks", () => {
  const bearer = (token: string): Partial<MonitorInput> => ({
    credentials: { auth: { kind: "bearer", token }, headers: [] },
  });

  /** Runs the first check of every monitor. */
  async function firstChecks(h: Harness, s: ReturnType<typeof scheduler>) {
    await s.tick();
    h.advance(spreadWindowMs);
    await s.tick();
    await s.idle();
  }

  test("the stored credentials are opened with the install key and sent", async () => {
    const h = await harness();
    const created = await createMonitor(
      h.storage,
      key,
      input("API", http(h.port), bearer("tok-1"))
    );
    expect(created.ok).toBe(true);
    const s = scheduler(h, { installKey: key });
    await firstChecks(h, s);
    expect(h.seen.at(-1)?.get("authorization")).toBe("Bearer tok-1");
    await s.stop();
  });

  test("an edit of the credentials is sent from the next tick", async () => {
    const h = await harness();
    const created = await createMonitor(
      h.storage,
      key,
      input("API", http(h.port), bearer("tok-1"))
    );
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const s = scheduler(h, { installKey: key });
    await firstChecks(h, s);
    await editMonitor(
      h.storage,
      key,
      created.monitor.id,
      input("API", http(h.port), bearer("tok-2"))
    );
    h.advance(20_000);
    await s.tick();
    await s.idle();
    expect(h.seen.at(-1)?.get("authorization")).toBe("Bearer tok-2");
    await s.stop();
  });

  test("credentials the key cannot open are not sent, the check still runs, and the monitor is named in the log", async () => {
    const h = await harness();
    const created = await createMonitor(
      h.storage,
      await scratchInstallKey(),
      input("API", http(h.port), bearer("tok-1"))
    );
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const s = scheduler(h, { installKey: key });
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await firstChecks(h, s);
      const logged = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(logged).toContain(created.monitor.id);
      expect(logged).not.toContain("tok-1");
    } finally {
      stderr.mockRestore();
    }
    expect(h.seen.at(-1)?.has("authorization")).toBe(false);
    expect(await h.count(created.monitor.id)).toBe(1);
    await s.stop();
  });
});

describe("heartbeat monitors", () => {
  const everyMinute: MonitorInput["config"] = {
    schedule: { everyMs: 60_000, kind: "every" },
    type: "heartbeat",
  };
  // A period of a minute and the default grace of a fifth: evaluated 72 seconds after the window opens.
  const window = 72_000;

  async function beat(h: Harness, config = everyMinute) {
    const monitor = await h.storage.monitors.create(input("Backup", config));
    const token = await h.storage.monitors.heartbeatTokenOf(monitor.id);
    if (token === undefined) {
      throw new Error("a heartbeat monitor without a token");
    }
    return {
      id: monitor.id,
      send: (at = h.io.now()) =>
        h.storage.heartbeats.record(token, at, "203.0.113.7"),
    };
  }

  async function heartbeatCount(h: Harness, id: string): Promise<number> {
    const [row] = await runSql(
      h.location,
      `SELECT count(*) AS n FROM heartbeats WHERE monitor_id = '${id}'`
    );
    return Number(row?.n);
  }

  test("a burst of heartbeats in one window yields one up check", async () => {
    const h = await harness();
    const b = await beat(h);
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(0);
    for (let i = 1; i <= 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: arrivals in order
      await b.send(h.io.now() + i * 1000);
    }
    h.advance(window);
    await s.tick();
    await s.idle();
    const checks = await h.storage.checks.range(
      b.id,
      0,
      Number.MAX_SAFE_INTEGER
    );
    expect(checks.map((check) => [check.result, check.reason])).toEqual([
      ["up", reasons.ok],
    ]);
    expect(checks[0]?.responseMs).toBeUndefined();
    expect(h.events).toEqual([]);
  });

  test("a silent period yields one down check with heartbeat late, opens an outage, raises down and moves the counter", async () => {
    const h = await harness();
    const b = await beat(h);
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    const c0 = await h.storage.changeCounter();
    h.advance(window - 1000);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(0);
    h.advance(1000);
    await s.tick();
    await s.idle();
    const [check] = await h.storage.checks.range(
      b.id,
      0,
      Number.MAX_SAFE_INTEGER
    );
    expect(check?.result).toBe("down");
    expect(check?.reason).toBe(reasons.heartbeat_late);
    expect(check?.responseMs).toBeUndefined();
    expect(
      (await h.storage.checks.detail(b.id, check?.startedAt ?? 0))?.params
    ).toEqual({ graceMs: 12_000, reason: "heartbeat_late" });
    expect((await h.storage.outages.ongoing()).map((o) => o.monitorId)).toEqual(
      [b.id]
    );
    expect(h.events.map((event) => event.kind)).toEqual(["down"]);
    expect(await h.storage.changeCounter()).toBeGreaterThan(c0);
  });

  test("a heartbeat while down is evaluated at the next tick: one up check, the outage closes, recovered is raised", async () => {
    const h = await harness();
    const b = await beat(h);
    const s = scheduler(h);
    await s.tick();
    h.advance(window);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(1);
    await b.send(h.io.now() + 500);
    h.advance(1000);
    await s.tick();
    await s.idle();
    const checks = await h.storage.checks.range(
      b.id,
      0,
      Number.MAX_SAFE_INTEGER
    );
    expect(checks.map((check) => check.result)).toEqual(["down", "up"]);
    expect(await h.storage.outages.ongoing()).toEqual([]);
    expect(h.events.map((event) => event.kind)).toEqual(["down", "recovered"]);
    // The next window opens at the recovery: nothing more until a period plus grace later.
    h.advance(window - 1000);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(2);
  });

  test("a heartbeat while up waits for the window's end: no check before it", async () => {
    const h = await harness();
    const b = await beat(h);
    const s = scheduler(h);
    await s.tick();
    await b.send(h.io.now() + 500);
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(0);
  });

  test("a paused heartbeat monitor is never evaluated, and its heartbeats are kept", async () => {
    const h = await harness();
    const b = await beat(h);
    await pauseMonitors(h.storage, [b.id]);
    const s = scheduler(h);
    await s.tick();
    await b.send();
    h.advance(10 * window);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(0);
    expect(await heartbeatCount(h, b.id)).toBe(1);
  });

  test("each evaluation keeps the monitor's latest hundred heartbeats and deletes the rest", async () => {
    const h = await harness();
    const b = await beat(h);
    const s = scheduler(h);
    await s.tick();
    const start = h.io.now();
    for (let i = 1; i <= 150; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: arrivals in order
      await b.send(start + i * 10);
    }
    h.advance(window);
    await s.tick();
    await s.idle();
    expect(await heartbeatCount(h, b.id)).toBe(100);
    const [oldest] = await runSql(
      h.location,
      `SELECT min(arrived_at) AS at FROM heartbeats WHERE monitor_id = '${b.id}'`
    );
    expect(Number(oldest?.at)).toBe(start + 51 * 10);
  });

  test("a cron schedule is read in the install time zone", async () => {
    const h = await harness();
    await h.storage.settings.set(timeZone, "Asia/Riyadh");
    // Wednesday 23 September 2026, 12:00 UTC.
    h.advance(Date.UTC(2026, 8, 23, 12) - h.io.now());
    const b = await beat(h, {
      graceMs: 600_000,
      schedule: { expression: "0 3 * * *", kind: "cron" },
      type: "heartbeat",
    });
    const s = scheduler(h);
    await s.tick();
    // 03:00 in Riyadh is 00:00 UTC; the evaluation is ten minutes of grace later.
    h.advance(Date.UTC(2026, 8, 24, 0, 10) - h.io.now() - 1000);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(0);
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(1);
  });

  test("an edit opens a new window, so a heartbeat monitor edited just before its evaluation is not judged on a period it was not configured for", async () => {
    const h = await harness();
    const b = await beat(h);
    const s = scheduler(h);
    await s.tick();
    h.advance(window - 1000);
    // The storage stamps the edit with the real clock: a create and an edit in one millisecond would not move updatedAt.
    await Bun.sleep(2);
    await editMonitor(h.storage, key, b.id, input("Backup", everyMinute));
    await s.tick();
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(await h.count(b.id)).toBe(0);
  });

  test("after a restart a down heartbeat monitor recovers on the first heartbeat, and one stored before the boot does not count", async () => {
    const h = await harness();
    const b = await beat(h);
    const first = scheduler(h);
    await first.tick();
    h.advance(window);
    await first.tick();
    await first.idle();
    await first.stop();
    // Sent while Raaqeb was stopping: before the next boot's window opens.
    await b.send();
    h.advance(1000);
    const second = scheduler(h);
    await second.tick();
    await second.idle();
    expect(await h.count(b.id)).toBe(1);
    await b.send(h.io.now() + 500);
    h.advance(1000);
    await second.tick();
    await second.idle();
    const checks = await h.storage.checks.range(
      b.id,
      0,
      Number.MAX_SAFE_INTEGER
    );
    expect(checks.map((check) => check.result)).toEqual(["down", "up"]);
    expect(await h.storage.outages.ongoing()).toEqual([]);
  });

  test("a heartbeat sent while paused does not count for the window that opens at the resume", async () => {
    const h = await harness();
    const b = await beat(h);
    await pauseMonitors(h.storage, [b.id]);
    const s = scheduler(h);
    await s.tick();
    await b.send();
    await Bun.sleep(2);
    await resumeMonitors(h.storage, [b.id]);
    h.advance(1000);
    await s.tick();
    h.advance(window);
    await s.tick();
    await s.idle();
    const [check] = await h.storage.checks.range(
      b.id,
      0,
      Number.MAX_SAFE_INTEGER
    );
    expect(check?.reason).toBe(reasons.heartbeat_late);
  });

  test("a heartbeat that arrives while its window is being evaluated counts once, for the next window", async () => {
    const h = await harness();
    const b = await beat(h);
    const token = await h.storage.monitors.heartbeatTokenOf(b.id);
    let injected = false;
    // The heartbeat lands after the tick took its time and before the evaluation reads.
    const racing: Storage = {
      ...h.storage,
      heartbeats: {
        ...h.storage.heartbeats,
        latest: async (ids, before) => {
          if (!injected && token !== undefined && ids.length === 1) {
            injected = true;
            await h.storage.heartbeats.record(token, h.io.now() + 2, undefined);
          }
          return h.storage.heartbeats.latest(ids, before);
        },
      },
    };
    const s = createScheduler(racing, h.io, {
      installKey: key,
      onEvent: (event) => h.events.push(event),
    });
    await s.tick();
    h.advance(window);
    await s.tick();
    await s.idle();
    h.advance(1000);
    await s.tick();
    await s.idle();
    h.advance(window);
    await s.tick();
    await s.idle();
    const checks = await h.storage.checks.range(
      b.id,
      0,
      Number.MAX_SAFE_INTEGER
    );
    expect(checks.map((check) => check.result)).toEqual(["down", "up", "down"]);
  });

  test("a stored cron schedule that never fires reads as a monitor this version cannot read, logged by its id, not dropped in silence", async () => {
    const h = await harness();
    const never = await h.storage.monitors.create(
      input("Never", {
        schedule: { expression: "0 0 29 2 *", kind: "cron" },
        type: "heartbeat",
      })
    );
    // A row an older grammar let through: 30 February parses and never fires.
    await runSql(
      h.location,
      `UPDATE monitors SET config = '${JSON.stringify({ schedule: { expression: "0 0 30 2 *", kind: "cron" }, type: "heartbeat" })}' WHERE id = '${never.id}'`
    );
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const s = scheduler(h);
      await s.tick();
      await s.idle();
    } finally {
      spy.mockRestore();
    }
    expect(written.some((line) => line.includes(never.id))).toBe(true);
  });
});

describe("the nightly sealing job on the scheduler's loop", () => {
  const dayMs = 86_400_000;
  const hourMs = 3_600_000;
  /** A UTC day's start, ten days from the real clock, whatever the clock says. */
  const d = Math.floor(Date.now() / dayMs) * dayMs + 10 * dayMs;

  /** A paused monitor, so the ticks run no check of their own, with three checks of day `d` in the head. */
  async function yesterday(h: Harness) {
    const monitor = await h.storage.monitors.create(
      input("Site", http(h.port))
    );
    await h.storage.monitors.pause([monitor.id]);
    for (let index = 0; index < 3; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
      await h.storage.checks.record({
        capture: undefined,
        check: {
          attempts: 1,
          bytes: 10,
          monitorId: monitor.id,
          reason: reasons.ok,
          responseMs: 100,
          result: "up",
          startedAt: d + index * hourMs,
          statusCode: 200,
        },
        detail: undefined,
      });
    }
    return monitor;
  }

  test("seals yesterday once the day is safely closed, and not before", async () => {
    const h = await harness();
    const monitor = await yesterday(h);
    h.advance(d + dayMs + sealingDelayMs - 1000 - h.io.now());
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    expect(await h.storage.checks.unsealed(d + dayMs)).toHaveLength(1);
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(await h.storage.checks.unsealed(d + dayMs)).toEqual([]);
    const [daily] = await h.storage.checks.rollups(
      monitor.id,
      "day",
      d,
      d + dayMs
    );
    expect(daily?.checks).toBe(3);
    expect(await h.count(monitor.id)).toBe(3);
  });

  test("stopping waits for the day the nightly job is sealing, so it lands whole before the storage closes", async () => {
    const h = await harness();
    await yesterday(h);
    h.advance(d + dayMs + sealingDelayMs - h.io.now());
    const sealing = Promise.withResolvers<undefined>();
    let landed = false;
    const storage: Storage = {
      ...h.storage,
      checks: {
        ...h.storage.checks,
        seal: async (...args) => {
          sealing.resolve(undefined);
          await Bun.sleep(60);
          const sealed = await h.storage.checks.seal(...args);
          landed = true;
          return sealed;
        },
      },
    };
    const s = createScheduler(storage, h.io, { installKey: key });
    await s.tick();
    await sealing.promise;
    await s.stop();
    expect(landed).toBe(true);
    expect(await h.storage.checks.unsealed(d + dayMs)).toEqual([]);
  });
});

describe("retention and the reserve on the scheduler's loop", () => {
  const dayMs = 86_400_000;
  const hourMs = 3_600_000;
  /** A UTC day's start, ten days from the real clock, whatever the clock says. */
  const d = Math.floor(Date.now() / dayMs) * dayMs + 10 * dayMs;

  /** A paused monitor with one check on each of the ten days up to `d`, every closed day sealed as the nightly job would. */
  async function tenDays(h: Harness, overrides: Partial<MonitorInput> = {}) {
    const monitor = await h.storage.monitors.create(
      input("Site", http(h.port), overrides)
    );
    await h.storage.monitors.pause([monitor.id]);
    for (let index = 9; index >= 0; index -= 1) {
      const day = d - index * dayMs;
      // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
      await h.storage.checks.record({
        capture: undefined,
        check: {
          attempts: 1,
          bytes: 10,
          monitorId: monitor.id,
          reason: reasons.ok,
          responseMs: 100,
          result: "up",
          startedAt: day + hourMs,
          statusCode: 200,
        },
        detail: undefined,
      });
      await h.storage.checks.seal(monitor.id, day, 2 * dayMs, []);
    }
    return monitor;
  }

  const days = async (h: Harness, monitorId: string) =>
    (await h.storage.checks.range(monitorId, 0, d + dayMs)).map(
      (check) => (check.startedAt - hourMs - d) / dayMs
    );

  test("lowering the retention deletes past the new value at the next nightly job, each monitor by its own retention, and moves the change counter", async () => {
    const h = await harness();
    const site = await tenDays(h);
    const own = await tenDays(h, { name: "Own", retentionDays: 5 });
    // The morning after d, once the sealing job may run.
    h.advance(d + dayMs + sealingDelayMs - h.io.now());
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    expect(await days(h, site.id)).toHaveLength(10);
    expect(await days(h, own.id)).toEqual([-4, -3, -2, -1, 0]);
    await h.storage.settings.set(retentionDays, 3);
    const counter = await h.storage.changeCounter();
    h.advance(hourMs);
    await s.tick();
    await s.idle();
    // Lowering takes effect at the next job, not at once.
    expect(await days(h, site.id)).toHaveLength(10);
    h.advance(dayMs - hourMs);
    await s.tick();
    await s.idle();
    expect(await days(h, site.id)).toEqual([-1, 0]);
    expect(await days(h, own.id)).toEqual([-3, -2, -1, 0]);
    const hours = await h.storage.checks.rollups(site.id, "hour", 0, d + dayMs);
    expect(hours.every((row) => row.at >= d - dayMs)).toBe(true);
    const daily = await h.storage.checks.rollups(site.id, "day", 0, d + dayMs);
    expect(daily.map((row) => (row.at - d) / dayMs)).toEqual([-1, 0]);
    expect(await h.storage.changeCounter()).toBeGreaterThan(counter);
  });

  test("over the size budget, the oldest history goes before the check's row is written", async () => {
    const h = await harness();
    const old = await tenDays(h, { name: "Old" });
    const site = await h.storage.monitors.create(
      input("Site", http(h.port), { retries: 0 })
    );
    await h.storage.settings.set(sizeBudgetBytes, 64 * 1024 * 1024);
    h.advance(d + dayMs + sealingDelayMs - h.io.now());
    // The used size reads over the budget until one day has gone.
    const order: string[] = [];
    const storage: Storage = {
      ...h.storage,
      checks: {
        ...h.storage.checks,
        dropOldest: (before) => {
          order.push("delete");
          return h.storage.checks.dropOldest(before);
        },
        record: (outcome) => {
          order.push("record");
          return h.storage.checks.record(outcome);
        },
      },
      size: {
        ...h.storage.size,
        used: () =>
          Promise.resolve(order.includes("delete") ? 1 : 65 * 1024 * 1024),
      },
    };
    const s = createScheduler(storage, h.io, { installKey: key });
    await s.tick();
    await s.idle();
    expect(order).toEqual(["delete", "record"]);
    expect(await h.count(site.id)).toBe(1);
    expect(await days(h, old.id)).toHaveLength(9);
  });

  test("the reserve's refusal is logged at most once a minute", async () => {
    const h = await harness({ freeBytes: () => Promise.resolve(1024 * 1024) });
    if (h.location.backend !== "sqlite") {
      return;
    }
    await h.storage.monitors.create(
      input("Site", http(h.port), { retries: 0 })
    );
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    const refusals = () =>
      errors.mock.calls.filter((call) => String(call[0]).includes("reserve"))
        .length;
    try {
      const s = scheduler(h, { measurePeriodMs: 0 });
      for (const step of [0, 20_000, 20_000, 20_000]) {
        h.advance(step);
        // biome-ignore lint/performance/noAwaitInLoops: one tick at a time, each after the last settled
        await s.tick();
        await s.idle();
      }
      expect(
        await h.count((await h.storage.monitors.list())[0]?.id ?? "")
      ).toBe(0);
      expect(refusals()).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });

  test("a check the reserve refuses writes no row on SQLite, and its outage still opens; Postgres has no reserve", async () => {
    const h = await harness({ freeBytes: () => Promise.resolve(1024 * 1024) });
    const site = await h.storage.monitors.create(
      input("Site", http(h.port), { retries: 0 })
    );
    h.setMode("error");
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const s = scheduler(h);
      await s.tick();
      await s.idle();
      const sqlite = h.location.backend === "sqlite";
      expect(await h.count(site.id)).toBe(sqlite ? 0 : 1);
      expect(
        (await h.storage.outages.ongoing()).map((outage) => outage.monitorId)
      ).toEqual([site.id]);
      expect(h.events.map((event) => event.kind)).toEqual(["down"]);
      expect(
        errors.mock.calls.some((call) => String(call[0]).includes("reserve"))
      ).toBe(sqlite);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the scheduler drains the notification queue", () => {
  test("a pending notification is delivered on the tick, through the channel, and recorded as sent", async () => {
    const h = await harness();
    const channel = await h.storage.channels.create(
      {
        appliesToNew: false,
        config: {},
        locale: undefined,
        name: "ops",
        type: "webhook",
      },
      await encrypt(
        key,
        JSON.stringify({
          secret: newSigningSecret(),
          url: `http://127.0.0.1:${h.port}/hook`,
        })
      )
    );
    const [queued] = await h.storage.notifications.enqueue(
      [channel.id],
      "operator",
      {
        data: { channel: { id: channel.id, name: "ops" } },
        timestamp: "2026-09-25T10:00:00.000Z",
        type: "channel.test",
      },
      h.io.now()
    );
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    const [sent] = await h.storage.notifications.recent(channel.id, 1);
    expect(sent).toMatchObject({ attempts: 1, id: queued?.id, status: "sent" });
    expect(h.seen.map((headers) => headers.get("webhook-id"))).toContain(
      queued?.id ?? ""
    );
    await s.stop();
  });
});

describe("the notification queue beside a failing monitors read", () => {
  test("notifications still go out on a tick whose monitors read fails", async () => {
    const h = await harness();
    const channel = await h.storage.channels.create(
      {
        appliesToNew: false,
        config: {},
        locale: undefined,
        name: "ops",
        type: "webhook",
      },
      await encrypt(
        key,
        JSON.stringify({
          secret: newSigningSecret(),
          url: `http://127.0.0.1:${h.port}/hook`,
        })
      )
    );
    await h.storage.notifications.enqueue(
      [channel.id],
      "operator",
      {
        data: { channel: { id: channel.id, name: "ops" } },
        timestamp: "2026-09-25T10:00:00.000Z",
        type: "channel.test",
      },
      h.io.now()
    );
    const failing = () => Promise.reject(new Error("database gone"));
    const s = createScheduler(
      { ...h.storage, monitors: { ...h.storage.monitors, list: failing } },
      h.io,
      { installKey: key }
    );
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await s.tick();
      await s.idle();
    } finally {
      quiet.mockRestore();
    }
    const [sent] = await h.storage.notifications.recent(channel.id, 1);
    expect(sent?.status).toBe("sent");
    await s.stop();
  });
});

/** A webhook channel at the local target, for the notifications the scheduler queues. */
async function webhookChannel(h: Harness): Promise<string> {
  const channel = await h.storage.channels.create(
    {
      appliesToNew: false,
      config: {},
      locale: undefined,
      name: "ops",
      type: "webhook",
    },
    await encrypt(
      key,
      JSON.stringify({
        secret: newSigningSecret(),
        url: `http://127.0.0.1:${h.port}/hook`,
      })
    )
  );
  return channel.id;
}

/** What the scheduler queued for the channel, oldest first. */
async function queuedFor(h: Harness, channelId: string) {
  return (await h.storage.notifications.recent(channelId, 50)).toReversed();
}

describe("the scheduler hands monitor events to the operator notifications", () => {
  test("a flapping monitor queues one notification per state change, with the stored public address's links", async () => {
    const h = await harness();
    await h.storage.settings.set(publicAddress, "https://status.example.test");
    const channel = await webhookChannel(h);
    const { id } = await h.storage.monitors.create(
      input("Site", http(h.port), { channels: [channel], retries: 0 })
    );
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await s.tick();
      await s.idle();
      for (const mode of ["error", "ok", "error", "ok"] as const) {
        h.setMode(mode);
        h.advance(20_000);
        // biome-ignore lint/performance/noAwaitInLoops: each check follows the one before
        await s.tick();
        await s.idle();
      }
    } finally {
      quiet.mockRestore();
    }
    const queued = await queuedFor(h, channel);
    expect(queued.map((each) => each.payload.type)).toEqual([
      "monitor.down",
      "monitor.recovered",
      "monitor.down",
      "monitor.recovered",
    ]);
    expect(queued[0]?.payload).toMatchObject({
      data: {
        incidentUrl: `https://status.example.test/admin/incidents/new?monitor=${id}`,
        monitor: {
          adminUrl: `https://status.example.test/admin/monitors/${id}`,
          id,
          name: "Site",
        },
        reason: "unexpected_status",
      },
    });
    // The harness clock is real time plus an offset, so the outage spans one interval and the few milliseconds the check took.
    const first = (await h.storage.outages.list(id)).at(-1);
    const downtime = (first?.endedAt ?? 0) - (first?.startedAt ?? 0);
    expect(downtime).toBeGreaterThanOrEqual(20_000);
    expect(downtime).toBeLessThan(21_000);
    expect(queued[1]?.payload).toMatchObject({
      data: { downtimeMs: downtime },
    });
    await s.stop();
  });

  test("an event the monitor switched off queues nothing; the ones switched on still go", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    await h.storage.monitors.create(
      input("Site", http(h.port), {
        channels: [channel],
        events: ["recovered"],
        retries: 0,
      })
    );
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      h.setMode("error");
      await s.tick();
      await s.idle();
      h.setMode("ok");
      h.advance(20_000);
      await s.tick();
      await s.idle();
    } finally {
      quiet.mockRestore();
    }
    expect(
      (await queuedFor(h, channel)).map((each) => each.payload.type)
    ).toEqual(["monitor.recovered"]);
    await s.stop();
  });

  test('a reminder repeats "still down" at its interval while the monitor stays down', async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    await h.storage.monitors.create(
      input("Site", http(h.port), {
        channels: [channel],
        reminderMs: 5 * 60_000,
        retries: 0,
      })
    );
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      h.setMode("error");
      await s.tick();
      await s.idle();
      h.advance(5 * 60_000 - 1000);
      await s.tick();
      await s.idle();
      expect(
        (await queuedFor(h, channel)).map((each) => each.payload.type)
      ).toEqual(["monitor.down"]);
      h.advance(2000);
      await s.tick();
      await s.idle();
    } finally {
      quiet.mockRestore();
    }
    const queued = await queuedFor(h, channel);
    expect(queued.map((each) => each.payload.type)).toEqual([
      "monitor.down",
      "monitor.reminder",
    ]);
    expect(queued[1]?.payload).toMatchObject({
      data: { reason: "unexpected_status" },
    });
    await s.stop();
  });

  test("an outage acknowledged while the scheduler runs reminds no more, its checks go on, and its recovery is sent", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const { id } = await h.storage.monitors.create(
      input("Site", http(h.port), {
        channels: [channel],
        reminderMs: 5 * 60_000,
        retries: 0,
      })
    );
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      h.setMode("error");
      await s.tick();
      await s.idle();
      const [outage] = await h.storage.outages.ongoing();
      if (!outage) {
        throw new Error("the outage did not open");
      }
      const acknowledgedAt = h.io.now();
      await h.storage.outages.acknowledge(id, outage.startedAt, acknowledgedAt);
      s.acknowledge({ ...outage, acknowledgedAt });
      h.advance(11 * 60_000);
      await s.tick();
      await s.idle();
      h.setMode("ok");
      h.advance(60_000);
      await s.tick();
      await s.idle();
    } finally {
      quiet.mockRestore();
    }
    expect(
      (await queuedFor(h, channel)).map((each) => each.payload.type)
    ).toEqual(["monitor.down", "monitor.recovered"]);
    expect((await h.storage.checks.recent(id, 10)).length).toBeGreaterThan(2);
    await s.stop();
  });

  test("monitors that appear with their history while the scheduler runs, as an import writes them, keep their state and their open outage's reminders", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await s.tick();
      await s.idle();
      const slow = await h.storage.monitors.create(
        input("Slow", http(h.port), { degradedMs: 1, retries: 0 })
      );
      const down = await h.storage.monitors.create(
        input(
          "Down",
          { ...http(h.port), assertions: [{ codes: ["404"], kind: "status" }] },
          { channels: [channel], reminderMs: 5 * 60_000, retries: 0 }
        )
      );
      // Their latest checks and the open outage, written as an import writes them, then one move of the counter.
      const at = h.io.now() - 60_000;
      const check = {
        attempts: 1,
        bytes: 5,
        responseMs: 400,
        startedAt: at,
        statusCode: 200,
      };
      await h.storage.transfer.writeChecks([
        {
          ...check,
          monitorId: slow.id,
          reason: reasons.slow,
          result: "degraded",
        },
        {
          ...check,
          monitorId: down.id,
          reason: reasons.unexpected_status,
          result: "down",
        },
      ]);
      await h.storage.transfer.writeOutages([
        {
          endedAt: undefined,
          monitorId: down.id,
          reason: reasons.unexpected_status,
          startedAt: at - 60_000,
        },
      ]);
      await h.storage.bump();
      h.setMode("slow");
      for (const step of [0, spreadWindowMs, 5 * 60_000]) {
        h.advance(step);
        // biome-ignore lint/performance/noAwaitInLoops: each tick follows the one before
        await s.tick();
        await s.idle();
      }
      expect(
        h.events
          .filter((event) => event.monitorId === slow.id)
          .map((event) => event.kind)
      ).not.toContain("degraded_started");
      expect(
        (await queuedFor(h, channel)).map((each) => each.payload.type)
      ).toContain("monitor.reminder");
    } finally {
      quiet.mockRestore();
    }
    await s.stop();
  });

  test("a monitor that appears keeps the others as the scheduler knows them: their state and their reminders' rhythm", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const site = await h.storage.monitors.create(
      input("Site", http(h.port), {
        channels: [channel],
        reminderMs: 5 * 60_000,
        retries: 0,
      })
    );
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await s.tick();
      await s.idle();
      h.setMode("error");
      h.advance(20_000);
      await s.tick();
      await s.idle();
      // The size guard's refused row: the newest stored check is older than the one the scheduler knows.
      await runSql(
        h.location,
        "DELETE FROM checks WHERE monitor_id = ? AND result = 2",
        [site.id]
      );
      // It appears just as the reminder falls due, so reading the outages again must not move that reminder on.
      h.advance(5 * 60_000 + 1000);
      await h.storage.monitors.create(input("New", http(h.port)));
      await h.storage.bump();
      for (const step of [0, 20_000]) {
        h.advance(step);
        // biome-ignore lint/performance/noAwaitInLoops: each tick follows the one before
        await s.tick();
        await s.idle();
      }
    } finally {
      quiet.mockRestore();
    }
    expect(
      h.events.filter(
        (event) => event.monitorId === site.id && event.kind === "down"
      )
    ).toHaveLength(1);
    expect(
      (await queuedFor(h, channel)).map((each) => each.payload.type)
    ).toEqual(["monitor.down", "monitor.reminder"]);
    await s.stop();
  });

  test("an https monitor's certificate within its threshold queues one warning, and a restart does not queue it again", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const { id } = await h.storage.monitors.create(
      input(
        "Secure",
        { ...http(1), tlsExpiryDays: 14, url: "https://127.0.0.1:1/" },
        { channels: [channel], events: ["certificate_expiring"] }
      )
    );
    const now = h.io.now();
    await h.storage.certificates.replace({
      fingerprint: "61:53",
      issuer: "CN=Issuer",
      lastSeenAt: now,
      monitorId: id,
      names: ["127.0.0.1"],
      subject: "CN=127.0.0.1",
      validFrom: now - 80 * 86_400_000,
      // A minute past ten days, so the milliseconds the harness clock moves never round the days left down.
      validTo: now + 10 * 86_400_000 + 60_000,
    });
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (let boot = 0; boot < 2; boot += 1) {
        const s = scheduler(h);
        // biome-ignore lint/performance/noAwaitInLoops: two boots, one after the other
        await s.tick();
        await s.idle();
        await s.stop();
      }
    } finally {
      quiet.mockRestore();
    }
    const queued = await queuedFor(h, channel);
    expect(queued.map((each) => each.payload.type)).toEqual([
      "monitor.certificate_expiring",
    ]);
    expect(queued[0]?.payload).toMatchObject({
      data: { certificate: { daysLeft: 10 } },
    });
  });
});

describe("edges of the operator notifications on the scheduler", () => {
  test("a public address saved while running reaches the next notification's links", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const { id } = await h.storage.monitors.create(
      input("Site", http(h.port), { channels: [channel], retries: 0 })
    );
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await s.tick();
      await s.idle();
      // The general page saves the address and moves the counter, as the general page does.
      await h.storage.settings.set(
        publicAddress,
        "https://status.example.test"
      );
      await h.storage.bump();
      h.setMode("error");
      h.advance(20_000);
      await s.tick();
      await s.idle();
    } finally {
      quiet.mockRestore();
    }
    const [sent] = await queuedFor(h, channel);
    expect(sent?.payload).toMatchObject({
      data: {
        monitor: {
          adminUrl: `https://status.example.test/admin/monitors/${id}`,
        },
      },
    });
    await s.stop();
  });

  test("a degraded monitor with a threshold queues degraded started and ended; one going down queues down alone", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    await h.storage.monitors.create(
      input("Site", http(h.port), {
        channels: [channel],
        degradedMs: 100,
        retries: 0,
      })
    );
    const s = scheduler(h);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const mode of ["slow", "ok", "slow", "error"] as const) {
        // An answer well past the threshold, while a fast one stays well under it on a busy machine.
        h.setMode(mode, 150);
        // biome-ignore lint/performance/noAwaitInLoops: each check follows the one before
        await s.tick();
        await s.idle();
        h.advance(20_000);
      }
    } finally {
      quiet.mockRestore();
    }
    expect(
      (await queuedFor(h, channel)).map((each) => each.payload.type)
    ).toEqual([
      "monitor.degraded_started",
      "monitor.degraded_ended",
      "monitor.degraded_started",
      "monitor.down",
    ]);
    await s.stop();
  });
});

describe("a certificate warning whose notification cannot be queued", () => {
  test("is not remembered on the record, so the next pass raises it again", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const { id } = await h.storage.monitors.create(
      input(
        "Secure",
        { ...http(1), tlsExpiryDays: 14, url: "https://127.0.0.1:1/" },
        { channels: [channel], events: ["certificate_expiring"] }
      )
    );
    const now = h.io.now();
    await h.storage.certificates.replace({
      fingerprint: "61:53",
      issuer: "CN=Issuer",
      lastSeenAt: now,
      monitorId: id,
      names: ["127.0.0.1"],
      subject: "CN=127.0.0.1",
      validFrom: now - 80 * 86_400_000,
      validTo: now + 10 * 86_400_000,
    });
    const failing = () =>
      Promise.reject(new Error("the database did not answer"));
    const s = createScheduler(
      {
        ...h.storage,
        notifications: { ...h.storage.notifications, enqueue: failing },
      },
      h.io,
      { installKey: key }
    );
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await s.tick();
      await s.idle();
      await s.stop();
    } finally {
      quiet.mockRestore();
    }
    // The record must still be there, or a missing one would pass as unwarned.
    const record = await h.storage.certificates.find(id);
    expect(record?.fingerprint).toBe("61:53");
    expect(record?.warned).toBeUndefined();
  });
});

describe("a certificate warning with no channel selected", () => {
  test("is neither raised nor remembered, logs nothing pass after pass, and goes at the next pass once a channel is selected", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const secure = (channels: string[]) =>
      input(
        "Secure",
        { ...http(1), tlsExpiryDays: 14, url: "https://127.0.0.1:1/" },
        { channels, events: ["certificate_expiring"] }
      );
    const { id } = await h.storage.monitors.create(secure([]));
    const now = h.io.now();
    await h.storage.certificates.replace({
      fingerprint: "61:53",
      issuer: "CN=Issuer",
      lastSeenAt: now,
      monitorId: id,
      names: ["127.0.0.1"],
      subject: "CN=127.0.0.1",
      validFrom: now - 80 * 86_400_000,
      validTo: now + 10 * 86_400_000 + 60_000,
    });
    const s = scheduler(h, { certificatePeriodMs: 60_000 });
    const written: string[] = [];
    const quiet = spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one pass a minute, one after the other
        await s.tick();
        await s.idle();
        h.advance(60_000);
      }
      expect(
        h.events.filter((event) => event.kind === "certificate_expiring")
      ).toEqual([]);
      expect(written.filter((line) => line.includes("certificate"))).toEqual(
        []
      );
      expect((await h.storage.certificates.find(id))?.warned).toBeUndefined();
      await h.storage.monitors.update(id, secure([channel]));
      await h.storage.bump();
      await s.tick();
      await s.idle();
    } finally {
      quiet.mockRestore();
      await s.stop();
    }
    expect(
      (await queuedFor(h, channel)).map((each) => each.payload.type)
    ).toEqual(["monitor.certificate_expiring"]);
    expect((await h.storage.certificates.find(id))?.warned).toBe("threshold");
  });
});

describe("a monitor row unreadable at boot, then repaired", () => {
  test("a monitor row unreadable at boot, then repaired, gets its open outage's reminders back", async () => {
    const h = await harness();
    const channel = await webhookChannel(h);
    const { id } = await h.storage.monitors.create(
      input("Site", http(h.port), {
        channels: [channel],
        reminderMs: 5 * 60_000,
        retries: 0,
      })
    );
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      h.setMode("error");
      const first = scheduler(h);
      await first.tick();
      await first.idle();
      await first.stop();
      const [row] = await runSql(
        h.location,
        "SELECT config FROM monitors WHERE id = ?",
        [id]
      );
      await runSql(h.location, "UPDATE monitors SET config = ? WHERE id = ?", [
        '{"type":"ping"}',
        id,
      ]);
      const second = scheduler(h);
      await second.tick();
      await second.idle();
      // The operator repairs the row, which moves the counter.
      await runSql(h.location, "UPDATE monitors SET config = ? WHERE id = ?", [
        String(row?.config),
        id,
      ]);
      await h.storage.bump();
      h.advance(1000);
      await second.tick();
      await second.idle();
      h.advance(10 * 60_000);
      await second.tick();
      await second.idle();
      await second.stop();
    } finally {
      quiet.mockRestore();
    }
    expect(
      (await queuedFor(h, channel)).map((each) => each.payload.type)
    ).toContain("monitor.reminder");
  });
});

describe("maintenance windows on the scheduler", () => {
  /** A monitor at the local target, linked to a component, notifying a channel. */
  async function covered(h: Harness, overrides: Partial<MonitorInput> = {}) {
    await h.storage.settings.set(publicAddress, "https://status.example.test");
    const channel = await webhookChannel(h);
    const monitor = await h.storage.monitors.create(
      input("Site", http(h.port), {
        channels: [channel],
        retries: 0,
        ...overrides,
      })
    );
    const web = await h.storage.components.create({
      description: undefined,
      monitorIds: [monitor.id],
      name: { ar: "Web" },
      status: "operational",
    });
    return { channel, monitor, web };
  }

  /** Schedules a window on the component from `start` for `length`, as the operator would. */
  async function schedule(
    h: Harness,
    componentId: string,
    start: number,
    length: number
  ): Promise<MaintenanceWindow> {
    const created = await createWindow(
      h.storage,
      {
        componentIds: [componentId],
        endsAt: start + length,
        message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث." },
        startsAt: start,
        title: { ar: "ترقية قاعدة البيانات" },
      },
      h.io.now()
    );
    if (!created.ok) {
      throw new Error(created.reason);
    }
    return created.window;
  }

  test("scenario 3: under maintenance wins over the outage it overlaps, the window is not observed time, and the monitor still down at its end sends its down notification then", async () => {
    const h = await harness();
    const { channel, monitor, web } = await covered(h);
    const moved: MaintenanceWindow[] = [];
    const s = scheduler(h, { onMaintenance: (each) => moved.push(each) });
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await s.tick();
      await s.idle();
      const first = h.io.now();
      const start = first + 40_000;
      const window = await schedule(h, web.id, start, 2 * 60_000);
      // Every 20 seconds, the monitor's interval, down from the window's start on.
      for (let step = 1; step <= 8; step += 1) {
        h.setMode(step >= 2 ? "error" : "ok");
        h.advance(20_000);
        // biome-ignore lint/performance/noAwaitInLoops: each tick follows the one before
        await s.tick();
        await s.idle();
        if (step === 4) {
          const during = await readComponentStatuses(h.storage);
          expect(during.statuses.get(web.id)).toBe("under_maintenance");
          expect(await queuedFor(h, channel)).toEqual([]);
        }
      }
      expect(moved.map((each) => [each.id, each.stage])).toEqual([
        [window.id, "in_progress"],
        [window.id, "completed"],
      ]);
      const after = await readComponentStatuses(h.storage);
      expect(after.statuses.get(web.id)).toBe("major_outage");
      const queued = await queuedFor(h, channel);
      expect(queued.map((each) => each.payload.type)).toEqual(["monitor.down"]);
      expect(queued[0]?.payload).toMatchObject({
        data: {
          incidentUrl: `https://status.example.test/admin/incidents/new?monitor=${monitor.id}`,
          reason: "unexpected_status",
        },
      });
      const now = h.io.now();
      const detail = await readMonitorDetail(h.storage, monitor.id, {
        now,
        range: "24h",
        requestOrigin: "https://status.example.test",
      });
      if (!detail.ok) {
        throw new Error(detail.reason);
      }
      const [day] = detail.detail.uptime;
      // Only the 40 seconds before the window, and the moments since its end, are observed; the outage inside it is no downtime.
      expect(day?.observedMs).toBeLessThan(now - first - 115_000);
      expect(day?.observedMs).toBeGreaterThanOrEqual(40_000);
      expect(day?.downtimeMs).toBeLessThan(5000);
    } finally {
      stderr.mockRestore();
    }
  });

  test("a monitor that went down and recovered inside the window sends nothing, then or at its end", async () => {
    const h = await harness();
    const { channel, web } = await covered(h);
    const s = scheduler(h);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await s.tick();
      await s.idle();
      await schedule(h, web.id, h.io.now(), 2 * 60_000);
      for (const mode of [
        "error",
        "error",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ] as const) {
        h.setMode(mode);
        h.advance(20_000);
        // biome-ignore lint/performance/noAwaitInLoops: each tick follows the one before
        await s.tick();
        await s.idle();
      }
      expect(await queuedFor(h, channel)).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });

  test("a read of the windows that fails is tried again at the next tick, so the window still starts", async () => {
    const h = await harness();
    const { web } = await covered(h);
    let failures = 1;
    const flaky: Storage = {
      ...h.storage,
      maintenance: {
        ...h.storage.maintenance,
        unfinished: () => {
          failures -= 1;
          return failures >= 0
            ? Promise.reject(new Error("the database did not answer"))
            : h.storage.maintenance.unfinished();
        },
      },
    };
    const s = createScheduler(flaky, h.io, { installKey: key });
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const window = await schedule(h, web.id, h.io.now(), 60_000);
      await s.tick();
      await s.idle();
      await s.tick();
      await s.idle();
      expect((await h.storage.maintenance.find(window.id))?.stage).toBe(
        "in_progress"
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("a monitor this version cannot read does not stop the windows from starting", async () => {
    const h = await harness();
    const { web } = await covered(h);
    const broken = await h.storage.monitors.create(
      input("Broken", http(h.port))
    );
    await runSql(h.location, "UPDATE monitors SET config = ? WHERE id = ?", [
      "{}",
      broken.id,
    ]);
    const s = scheduler(h);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const window = await schedule(h, web.id, h.io.now(), 60_000);
      await s.tick();
      await s.idle();
      expect((await h.storage.maintenance.find(window.id))?.stage).toBe(
        "in_progress"
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("stop waits for a window's move under way, so its bump and notifications land before the storage closes", async () => {
    const h = await harness();
    const { web } = await covered(h);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let advancing = false;
    const gated: Storage = {
      ...h.storage,
      maintenance: {
        ...h.storage.maintenance,
        advance: async (now) => {
          advancing = true;
          await gate;
          return h.storage.maintenance.advance(now);
        },
      },
    };
    const s = createScheduler(gated, h.io, { installKey: key });
    await schedule(h, web.id, h.io.now(), 60_000);
    const ticking = s.tick();
    while (!advancing) {
      // biome-ignore lint/performance/noAwaitInLoops: waits for the tick to reach the move
      await Bun.sleep(1);
    }
    let stopped = false;
    const stopping = s.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    release();
    await ticking;
    await stopping;
    expect(stopped).toBe(true);
  });

  test("the change counter moves when a window starts and again when it completes", async () => {
    const h = await harness();
    const { web } = await covered(h);
    const s = scheduler(h);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await s.tick();
      await s.idle();
      await schedule(h, web.id, h.io.now() + 30_000, 60_000);
      await s.tick();
      await s.idle();
      const before = await h.storage.changeCounter();
      h.advance(30_000);
      await s.tick();
      await s.idle();
      const started = await h.storage.changeCounter();
      expect(started).toBeGreaterThan(before);
      h.advance(60_000);
      await s.tick();
      await s.idle();
      expect(await h.storage.changeCounter()).toBeGreaterThan(started);
    } finally {
      stderr.mockRestore();
    }
  });

  test("a covered monitor sends no reminder, and its reminders go on from the down notification its window's end sent", async () => {
    const h = await harness();
    const { channel, web } = await covered(h, { reminderMs: 60_000 });
    const s = scheduler(h);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await s.tick();
      await s.idle();
      await schedule(h, web.id, h.io.now(), 3 * 60_000);
      h.setMode("error");
      for (let step = 1; step <= 9; step += 1) {
        h.advance(20_000);
        // biome-ignore lint/performance/noAwaitInLoops: each tick follows the one before
        await s.tick();
        await s.idle();
      }
      // Three minutes down under the window: no reminder, then the down notification at its end.
      expect(
        (await queuedFor(h, channel)).map((each) => each.payload.type)
      ).toEqual(["monitor.down"]);
      for (let step = 1; step <= 3; step += 1) {
        h.advance(20_000);
        // biome-ignore lint/performance/noAwaitInLoops: each tick follows the one before
        await s.tick();
        await s.idle();
      }
      expect(
        (await queuedFor(h, channel)).map((each) => each.payload.type)
      ).toEqual(["monitor.down", "monitor.reminder"]);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("the five-minute refresh of the public figures", () => {
  test("with nothing else changing the counter moves once every five minutes, so today's cell reaches a memoised page", async () => {
    const h = await harness();
    const s = scheduler(h, { refreshPeriodMs: undefined });
    await s.tick();
    await s.idle();
    const c0 = await h.storage.changeCounter();
    h.advance(refreshPeriodMs - 1000);
    await s.tick();
    await s.idle();
    expect(await h.storage.changeCounter()).toBe(c0);
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(await h.storage.changeCounter()).toBe(c0 + 1);
    h.advance(1000);
    await s.tick();
    await s.idle();
    expect(await h.storage.changeCounter()).toBe(c0 + 1);
    h.advance(refreshPeriodMs);
    await s.tick();
    await s.idle();
    expect(await h.storage.changeCounter()).toBe(c0 + 2);
  });

  test("its own move never makes the scheduler read the monitors again", async () => {
    const h = await harness();
    await threeMonitors(h);
    let reads = 0;
    const counting = {
      ...h.storage,
      monitors: {
        ...h.storage.monitors,
        list: () => {
          reads += 1;
          return h.storage.monitors.list();
        },
      },
    };
    const s = createScheduler(counting, h.io, {
      installKey: key,
      refreshPeriodMs: 60_000,
    });
    await s.tick();
    await s.idle();
    const first = reads;
    for (let minute = 1; minute <= 3; minute += 1) {
      h.advance(60_000);
      // biome-ignore lint/performance/noAwaitInLoops: ticks run one after another, as the loop runs them
      await s.tick();
      await s.idle();
    }
    expect(reads).toBe(first);
    await s.stop();
  });
});

describe("subscriber notifications on the scheduler", () => {
  const author = "owner@example.com";
  const internet = () => Promise.resolve(["93.184.216.34"]);

  let mailServer: FakeSmtp | undefined;

  afterEach(() => {
    mailServer?.stop();
    mailServer = undefined;
  });

  /** The emails one address got over the channel's SMTP server. */
  const mailed = (address: string): string[] =>
    (mailServer?.messages ?? []).filter((each) =>
      parse(each).headers.to?.includes(address)
    );

  /** Everything the queue posts to a subscriber's webhook. */
  function receiver() {
    const requests: { body: string; url: string }[] = [];
    const fetcher = ((resource: string | URL | Request, init?: RequestInit) => {
      requests.push({ body: String(init?.body ?? ""), url: String(resource) });
      return Promise.resolve(new Response(""));
    }) as typeof fetch;
    return {
      fetch: fetcher,
      /** The events a webhook got, by the body's name for them. */
      hooked: (url: string) =>
        requests
          .filter((each) => each.url === url)
          .map((each) => {
            const body = JSON.parse(each.body);
            return body.type ?? body.meta.event;
          }),
      requests,
    };
  }

  /** A component on a page with a subscriber in every state on both channels, and the SMTP channel that sends sign-in mail. */
  async function subscribed(h: Harness) {
    await h.storage.settings.set(publicAddress, "https://status.example.test");
    mailServer = fakeSmtp();
    await h.storage.channels.create(
      {
        appliesToNew: false,
        config: {
          from: "status@example.test",
          host: "127.0.0.1",
          port: String(mailServer.port),
          security: "none",
          to: "ops@example.test",
        },
        locale: undefined,
        name: "mail",
        type: "email",
      },
      undefined
    );
    const web = await h.storage.components.create({
      description: undefined,
      monitorIds: [],
      name: { ar: "Web" },
      status: "operational",
    });
    const page = await h.storage.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: true,
      published: true,
      locale: "en",
      slug: "main",
      title: { ar: "Example status" },
    });
    await h.storage.pages.save(
      page.id,
      {
        customDomain: undefined,
        customization: defaultCustomization,
        isDefault: true,
        published: true,
        locale: "en",
        slug: "main",
        title: { ar: "Example status" },
      },
      [{ componentId: web.id, kind: "component" }]
    );
    const at = h.io.now();
    const signUp = async (
      channel: "email" | "webhook",
      name: string,
      state: "pending" | "confirmed" | "unsubscribed"
    ) => {
      const stored = await h.storage.subscriptions.request({
        address:
          channel === "email" ? `${name}@example.test` : `hash-of-${name}`,
        channel,
        credentials:
          channel === "webhook"
            ? await encrypt(key, `https://hooks.example.com/${name}`)
            : undefined,
        locale: "en",
        pageId: page.id,
        quietSince: at - 1,
        requestedAt: at,
      });
      if (!stored) {
        throw new Error("expected a subscription");
      }
      if (state !== "pending") {
        await h.storage.subscriptions.confirm(stored.token, at, at - 1);
      }
      if (state === "unsubscribed") {
        await h.storage.subscriptions.unsubscribe(stored.token);
      }
      return stored;
    };
    for (const [channel, name, state] of [
      ["webhook", "confirmed", "confirmed"],
      ["webhook", "pending", "pending"],
      ["webhook", "left", "unsubscribed"],
      ["email", "reader", "confirmed"],
      ["email", "waiting", "pending"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: the sign-ups go in order
      await signUp(channel, name, state);
    }
    return { web: web.id };
  }

  /** Ticks every 20 seconds for `ms`, settling each tick. */
  async function run(
    h: Harness,
    s: ReturnType<typeof createScheduler>,
    ms: number
  ) {
    for (let passed = 0; passed < ms; passed += 20_000) {
      h.advance(20_000);
      // biome-ignore lint/performance/noAwaitInLoops: one tick after the other, as the scheduler runs
      await s.tick();
      await s.idle();
    }
  }

  test("every subscriber event reaches a confirmed subscriber and none reaches a pending or unsubscribed one (the step's done-when)", async () => {
    const h = await harness();
    const { web } = await subscribed(h);
    const net = receiver();
    const io = { ...h.io, fetch: net.fetch, lookup: internet };
    const s = createScheduler(h.storage, io, {
      installKey: key,
      refreshPeriodMs: Number.POSITIVE_INFINITY,
    });
    const announce = (event: SubscriberEvent) =>
      s.subscribers.announce(event, io.now());
    await s.tick();
    await s.idle();
    const opened = await createIncident(
      h.storage,
      {
        impact: "major",
        message: { ar: "Checkout fails for some visitors." },
        stage: "investigating",
        statuses: [{ componentId: web, status: "major_outage" }],
        title: { ar: "Checkout failures" },
      },
      author,
      announce
    );
    if (!opened.ok) {
      throw new Error(opened.reason);
    }
    await run(h, s, 20_000);
    const identified = await postUpdate(
      h.storage,
      opened.incident.id,
      {
        message: { ar: "A bad deploy; rolling back." },
        stage: "identified",
        statuses: [{ componentId: web, status: "partial_outage" }],
      },
      author,
      announce
    );
    expect(identified.ok).toBe(true);
    await run(h, s, 20_000);
    const resolved = await postUpdate(
      h.storage,
      opened.incident.id,
      { keep: false, message: { ar: "Rolled back." }, stage: "resolved" },
      author,
      announce
    );
    expect(resolved.ok).toBe(true);
    const scheduled = await createWindow(
      h.storage,
      {
        componentIds: [web],
        endsAt: io.now() + 3 * 60_000,
        message: { ar: "Moving the database." },
        startsAt: io.now() + 60_000,
        title: { ar: "Database move" },
      },
      io.now(),
      announce
    );
    expect(scheduled.ok).toBe(true);
    await run(h, s, 5 * 60_000);
    const every = [
      "incident.published",
      "incident.updated",
      "incident.updated",
      "maintenance.scheduled",
      "maintenance.started",
      "maintenance.completed",
    ];
    expect(net.hooked("https://hooks.example.com/confirmed")).toEqual(every);
    expect(mailed("reader@example.test")).toHaveLength(every.length);
    expect(net.hooked("https://hooks.example.com/pending")).toEqual([]);
    expect(net.hooked("https://hooks.example.com/left")).toEqual([]);
    expect(mailed("waiting@example.test")).toEqual([]);
    await s.stop();
  });

  test("a window scheduled to start in the current minute reaches a subscriber once as started, by webhook and email alike", async () => {
    const h = await harness();
    const { web } = await subscribed(h);
    const net = receiver();
    const io = { ...h.io, fetch: net.fetch, lookup: internet };
    const s = createScheduler(h.storage, io, {
      installKey: key,
      refreshPeriodMs: Number.POSITIVE_INFINITY,
    });
    await s.tick();
    await s.idle();
    const now = io.now();
    const created = await createWindow(
      h.storage,
      {
        componentIds: [web],
        endsAt: now + 10 * 60_000,
        message: { ar: "Moving the database." },
        startsAt: now - (now % 60_000),
        title: { ar: "Database move" },
      },
      now,
      (event) => s.subscribers.announce(event, io.now())
    );
    expect(created.ok).toBe(true);
    await run(h, s, 60_000);
    expect(net.hooked("https://hooks.example.com/confirmed")).toEqual([
      "maintenance.started",
    ]);
    expect(mailed("reader@example.test")).toHaveLength(1);
    await s.stop();
  });

  test("a window whose start and end both passed between two ticks announces completed alone", async () => {
    const h = await harness();
    const { web } = await subscribed(h);
    const net = receiver();
    const io = { ...h.io, fetch: net.fetch, lookup: internet };
    const s = createScheduler(h.storage, io, {
      installKey: key,
      refreshPeriodMs: Number.POSITIVE_INFINITY,
    });
    await s.tick();
    await s.idle();
    await createWindow(
      h.storage,
      {
        componentIds: [web],
        endsAt: io.now() + 2 * 60_000,
        message: { ar: "Short." },
        startsAt: io.now() + 60_000,
        title: { ar: "Short window" },
      },
      io.now()
    );
    h.advance(3 * 60_000);
    await s.tick();
    await s.idle();
    await run(h, s, 60_000);
    expect(net.hooked("https://hooks.example.com/confirmed")).toEqual([
      "maintenance.completed",
    ]);
    await s.stop();
  });

  test("a confirmation asked through the scheduler goes out to the pending subscriber at the next tick", async () => {
    const h = await harness();
    await subscribed(h);
    const net = receiver();
    const io = { ...h.io, fetch: net.fetch, lookup: internet };
    const s = createScheduler(h.storage, io, {
      installKey: key,
      refreshPeriodMs: Number.POSITIVE_INFINITY,
    });
    const [pending] = (
      await h.storage.subscriptions.list(
        (await h.storage.pages.list())[0]?.id ?? ""
      )
    ).filter((each) => each.address === "hash-of-pending");
    if (!pending) {
      throw new Error("expected the pending subscription");
    }
    expect(await s.subscribers.confirm(pending.id, io.now())).toBe(true);
    await s.tick();
    await s.idle();
    expect(net.hooked("https://hooks.example.com/pending")).toEqual([
      "subscription.confirmation",
    ]);
    await s.stop();
  });

  test("the nightly job deletes the pending subscriptions whose link is 48 hours old, and nothing else", async () => {
    const dayMs = 86_400_000;
    const h = await harness();
    const d = Math.floor(Date.now() / dayMs) * dayMs + 10 * dayMs;
    await subscribed(h);
    const pageId = (await h.storage.pages.list())[0]?.id ?? "";
    await runSql(h.location, "UPDATE subscriptions SET requested_at = ?", [
      d + dayMs - 2 * dayMs - 1,
    ]);
    const recent = await h.storage.subscriptions.request({
      address: "recent@example.test",
      channel: "email",
      credentials: undefined,
      locale: "en",
      pageId,
      quietSince: 0,
      requestedAt: d + dayMs,
    });
    h.advance(d + dayMs + sealingDelayMs - h.io.now());
    const s = scheduler(h);
    await s.tick();
    await s.idle();
    const left = (await h.storage.subscriptions.list(pageId)).map(
      (each) => each.address
    );
    expect(left.toSorted(byText)).toEqual(
      [
        "hash-of-confirmed",
        "hash-of-left",
        "reader@example.test",
        recent?.address ?? "",
      ].toSorted(byText)
    );
  });
});

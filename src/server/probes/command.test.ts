/**
 * Two processes on one machine: the built install, `bun dist/server/server.js`,
 * and a real probe beside it, `bun dist/server/server.js probe`, over a SQLite
 * file the test seeds and reads. Needs `bun run build` first, as the gate
 * runs it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { sqliteFileName } from "@/server/storage/sqlite.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  type MonitorInput,
  mainLocation,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { makeProbe } from "./probes.ts";

const entry = `${import.meta.dir}/../../../dist/server/server.js`;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    // biome-ignore lint/performance/noAwaitInLoops: each process and file in turn
    await cleanup();
  }
});

/** A port no one listens on right now. */
function freePort(): number {
  const held = Bun.serve({ fetch: () => new Response(), port: 0 });
  const { port } = held;
  held.stop(true);
  if (port === undefined) {
    throw new Error("no port");
  }
  return port;
}

/** A process's output so far, from the file it writes to. */
const logOf = (path: string) => () =>
  Bun.file(path)
    .text()
    .catch(() => "");

async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  what: string,
  withinMs = 30_000
): Promise<T> {
  const ends = Date.now() + withinMs;
  while (Date.now() < ends) {
    // biome-ignore lint/performance/noAwaitInLoops: a poll, one look after another
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(200);
  }
  throw new Error(`waited ${withinMs} ms for ${what}`);
}

const monitor = (
  name: string,
  url: string,
  overrides: Partial<MonitorInput>
): MonitorInput => ({
  channels: [],
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url,
  },
  events: [...monitorEventKinds],
  intervalMs: 20_000,
  name,
  retries: 0,
  tags: [],
  timeoutMs: 2000,
  ...overrides,
});

describe("a probe process beside the install", () => {
  test("registers with its token, checks the monitors assigned to it, and its results open the outages they confirm", async () => {
    if (!(await Bun.file(entry).exists())) {
      throw new Error("this test serves the built app: run `bun run build`");
    }
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    cleanups.push(async () => {
      await Bun.$`rm -rf ${dir}`.quiet();
    });
    // The target fails every request but the second monitor's until the test says so, and counts which monitor asked by its path.
    const asked = new Map<string, number>();
    let bothFail = false;
    const target = Bun.serve({
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        asked.set(pathname, (asked.get(pathname) ?? 0) + 1);
        return pathname === "/both" && !bothFail
          ? new Response("up")
          : new Response("down", { status: 500 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    cleanups.push(() => target.stop(true));
    const at = (path: string) => `http://127.0.0.1:${target.port}${path}`;

    const opened = await openStorage({
      backend: "sqlite",
      file: `${dir}/${sqliteFileName}`,
    });
    if (!opened.ok) {
      throw new Error(opened.message);
    }
    const storage: Storage = opened.storage;
    cleanups.push(() => storage.close());
    const made = await makeProbe(storage, "Local");
    if (!made.ok) {
      throw new Error("no probe made");
    }
    const probeId = made.probe.id;
    const alone = await storage.monitors.create(
      monitor("Probe alone", at("/alone"), { locations: [probeId] })
    );
    const both = await storage.monitors.create(
      monitor("Both", at("/both"), {
        confirmations: 2,
        locations: [mainLocation, probeId],
      })
    );

    const port = freePort();
    const install = Bun.spawn(["bun", entry], {
      env: { ...process.env, RAAQEB_DATA_DIR: dir, RAAQEB_PORT: String(port) },
      stderr: Bun.file(`${dir}/install.err`),
      stdout: Bun.file(`${dir}/install.log`),
    });
    cleanups.push(async () => {
      install.kill();
      await install.exited;
    });
    const installLog = logOf(`${dir}/install.log`);
    await until(
      async () =>
        (await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined))
          ?.ok || undefined,
      "the install's health"
    );

    const probe = Bun.spawn(["bun", entry, "probe"], {
      env: {
        ...process.env,
        RAAQEB_PROBE_SERVER: `http://127.0.0.1:${port}`,
        RAAQEB_PROBE_TOKEN: made.token,
      },
      stderr: Bun.file(`${dir}/probe.err`),
      stdout: Bun.file(`${dir}/probe.log`),
    });
    cleanups.push(async () => {
      probe.kill();
      await probe.exited;
    });

    const seen = await until(async () => {
      const [held] = await storage.probes.list();
      return held?.lastSeenAt === undefined ? undefined : held;
    }, "the probe's first contact");
    expect(seen.version).toBeDefined();

    // Only the probe checks the first monitor, so its outage is the probe's results alone.
    const outage = await until(
      async () =>
        (await storage.outages.ongoing()).find(
          (each) => each.monitorId === alone.id
        ),
      "the outage the probe's results open"
    );
    expect(outage.monitorId).toBe(alone.id);
    // Once both locations see the second one fail, its outage opens and the install's log names them both.
    // Three checks of it means both locations saw it up once, so neither decides alone when it fails.
    await until(
      () => ((asked.get("/both") ?? 0) >= 3 ? true : undefined),
      "both locations checking the second monitor",
      60_000
    );
    bothFail = true;
    await until(
      async () =>
        (await installLog()).includes(
          `monitor ${both.id} is down (unexpected_status) from main, probe ${probeId}`
        ) || undefined,
      "the down event of the monitor both locations check",
      60_000
    );
    expect(asked.get("/alone")).toBeGreaterThan(0);

    // A new token stops the old one: the probe is refused and says so.
    await storage.probes.replaceToken(probeId, "0".repeat(64));
    const probeLog = logOf(`${dir}/probe.err`);
    await until(
      async () =>
        (await probeLog()).includes("RAAQEB_PROBE_TOKEN") || undefined,
      "the probe's refused token",
      45_000
    );
  }, 150_000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { runSql, scratchDatabase } from "./fixture.ts";
import { statfsFreeBytes } from "./size.ts";
import {
  type DatabaseLocation,
  type OpenStorageOptions,
  openStorage,
  type Storage,
} from "./storage.ts";

let open:
  | {
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
      storage: Storage;
    }
  | undefined;

async function storage(options: OpenStorageOptions = {}): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location, options);
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

function location(): DatabaseLocation {
  if (!open) {
    throw new Error("no database");
  }
  return open.location;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const t0 = 1_700_000_000_000;

/** Records `count` down checks, each keeping a capture of `bodyBytes` random bytes. */
async function captured(
  store: Storage,
  count: number,
  bodyBytes: number
): Promise<string> {
  const monitor = await store.monitors.create({
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "always",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: "https://example.test/",
    },
    intervalMs: 60_000,
    name: "Site",
    retries: 0,
    channels: [],
    events: [...monitorEventKinds],
    tags: [],
    timeoutMs: 10_000,
  });
  for (let index = 0; index < count; index += 1) {
    const startedAt = t0 + index * 60_000;
    // biome-ignore lint/performance/noAwaitInLoops: rows in order, as the scheduler writes them
    await store.checks.record({
      capture: {
        body: crypto.getRandomValues(new Uint8Array(bodyBytes)),
        headers: [],
        monitorId: monitor.id,
        startedAt,
      },
      check: {
        attempts: 1,
        bytes: bodyBytes,
        monitorId: monitor.id,
        reason: reasons.unexpected_status,
        responseMs: 50,
        result: "down",
        startedAt,
        statusCode: 500,
      },
      detail: undefined,
    });
  }
  return monitor.id;
}

const everything = { daily: t0 + 1e10, hourly: t0 + 1e10, raw: t0 + 1e10 };

describe("the used size", () => {
  test("grows with the history, and after the history is deleted and the space given back it is lower", async () => {
    const store = await storage();
    const empty = await store.size.used();
    const id = await captured(store, 40, 32 * 1024);
    const full = await store.size.used();
    expect(full - empty).toBeGreaterThan(40 * 32 * 1024);
    await store.checks.purge(id, everything);
    await store.size.reclaim();
    expect(await store.size.used()).toBeLessThan(full - 30 * 32 * 1024);
  });

  test("on SQLite it is the pages in use, so a delete lowers it at once, before any vacuum", async () => {
    const store = await storage();
    if (location().backend !== "sqlite") {
      return;
    }
    const id = await captured(store, 40, 32 * 1024);
    const full = await store.size.used();
    await store.checks.purge(id, everything);
    expect(await store.size.used()).toBeLessThan(full - 30 * 32 * 1024);
  });

  test("on Postgres it counts Raaqeb's own tables, not another application's in the same database", async () => {
    const store = await storage();
    if (location().backend !== "postgres") {
      return;
    }
    const before = await store.size.used();
    await runSql(location(), "CREATE TABLE other_application (payload text)");
    await runSql(
      location(),
      "INSERT INTO other_application SELECT repeat('x', 1000) FROM generate_series(1, 2000)"
    );
    expect(await store.size.used()).toBe(before);
  });
});

describe("giving space back", () => {
  test("on SQLite the file itself shrinks once the history is deleted", async () => {
    const store = await storage();
    const where = location();
    if (where.backend !== "sqlite") {
      return;
    }
    const id = await captured(store, 40, 32 * 1024);
    await store.size.reclaim();
    const full = Bun.file(where.file).size;
    await store.checks.purge(id, everything);
    await store.size.reclaim();
    expect(Bun.file(where.file).size).toBeLessThan(full - 30 * 32 * 1024);
    expect(Bun.file(`${where.file}-wal`).size).toBe(0);
  });

  test("leaves the history that stays readable", async () => {
    const store = await storage();
    const id = await captured(store, 3, 1024);
    await store.size.reclaim();
    expect(
      await store.checks.range(id, 0, Number.MAX_SAFE_INTEGER)
    ).toHaveLength(3);
  });
});

describe("giving space back beside a check's write", () => {
  test("waits for a row being recorded rather than landing inside its transaction", async () => {
    const store = await storage();
    const id = await captured(store, 1, 1024);
    const outcomes: string[] = [];
    // A check settles at any point of the reclaim: try every few microtask hops.
    for (let hops = 0; hops < 8; hops += 1) {
      const startedAt = t0 + (hops + 10) * 60_000;
      const writing = store.checks.record({
        capture: undefined,
        check: {
          attempts: 1,
          bytes: 0,
          monitorId: id,
          reason: reasons.ok,
          responseMs: 20,
          result: "up",
          startedAt,
          statusCode: 200,
        },
        detail: undefined,
      });
      for (let hop = 0; hop < hops; hop += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each hop lets the write's transaction move one step
        await Promise.resolve();
      }
      outcomes.push(
        await store.size.reclaim().then(
          () => "given back",
          (error: unknown) =>
            error instanceof Error ? error.message : "not an Error"
        )
      );
      await writing;
    }
    expect(outcomes).toEqual(Array.from({ length: 8 }, () => "given back"));
    expect(
      await store.checks.range(id, 0, Number.MAX_SAFE_INTEGER)
    ).toHaveLength(9);
  });
});

describe("the free disk", () => {
  test("on SQLite is the reader's answer for the data directory; on Postgres there is none", async () => {
    const asked: string[] = [];
    const store = await storage({
      freeBytes: (directory) => {
        asked.push(directory);
        return Promise.resolve(12_345);
      },
    });
    const where = location();
    if (where.backend === "sqlite") {
      expect(await store.size.free()).toBe(12_345);
      expect(asked).toEqual([where.file.slice(0, where.file.lastIndexOf("/"))]);
    } else {
      expect(await store.size.free()).toBeUndefined();
      expect(asked).toEqual([]);
    }
  });

  test("the default reader answers the bytes an unprivileged process may use", async () => {
    const free = await statfsFreeBytes(process.cwd());
    expect(free).toBeGreaterThan(0);
    expect(Number.isSafeInteger(free)).toBe(true);
  });
});

describe("a size read that fails", () => {
  test("answers a rejected promise, never a throw, on either backend", async () => {
    const store = await storage();
    // Closed here, so afterEach has nothing left to close.
    const cleanup = open?.cleanup;
    open = undefined;
    await store.close();
    const outcomes = await Promise.all(
      [store.size.used, store.size.reclaim].map((read) => {
        try {
          return read().then(
            () => "resolved",
            () => "rejected"
          );
        } catch {
          return Promise.resolve("thrown");
        }
      })
    );
    expect(outcomes).toEqual(["rejected", "rejected"]);
    await cleanup?.();
  });
});

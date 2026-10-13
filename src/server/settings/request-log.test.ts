import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import type { Setting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { heldRequestLog, requestLogEnabled } from "./request-log.ts";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** The storage's settings with every read counted. */
function counted(store: Storage) {
  let reads = 0;
  function get<T>(setting: Setting<T>): Promise<T | undefined> {
    reads += 1;
    return store.settings.get(setting);
  }
  return {
    reads: () => reads,
    storage: { settings: { ...store.settings, get } },
  };
}

describe("the request log switch the entry holds", () => {
  test("is off before onboarding opens a database, and on a fresh install", async () => {
    expect(await heldRequestLog()(undefined, undefined)).toBe(false);
    expect(await heldRequestLog()(await storage(), 0)).toBe(false);
  });

  test("a saved switch is in force once the change counter moves, and not before, so no restart is needed", async () => {
    const store = await storage();
    const held = heldRequestLog();
    expect(await held(store, 0)).toBe(false);
    await store.settings.set(requestLogEnabled, true);
    expect(await held(store, 0)).toBe(false);
    expect(await held(store, undefined)).toBe(false);
    expect(await held(store, 1)).toBe(true);
    await store.settings.set(requestLogEnabled, false);
    expect(await held(store, 2)).toBe(false);
  });

  test("the setting is read once per move of the counter, never per request", async () => {
    const store = await storage();
    await store.settings.set(requestLogEnabled, true);
    const watched = counted(store);
    const held = heldRequestLog();
    for (const counter of [3, 3, undefined, 3, 4, 4, undefined]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request after another, as the entry serves them
      expect(await held(watched.storage, counter)).toBe(true);
    }
    expect(watched.reads()).toBe(2);
  });

  test("the first request over an open database reads the switch even with no counter, as a POST reads none", async () => {
    const store = await storage();
    await store.settings.set(requestLogEnabled, true);
    expect(await heldRequestLog()(store, undefined)).toBe(true);
  });

  test("a switch that cannot be read is off, and is read again when the counter moves", async () => {
    const store = await storage();
    const held = heldRequestLog();
    const broken = {
      settings: {
        ...store.settings,
        get: () => Promise.reject(new Error("gone")),
      },
    };
    expect(await held(broken, 1)).toBe(false);
    await store.settings.set(requestLogEnabled, true);
    expect(await held(store, 2)).toBe(true);
  });
});

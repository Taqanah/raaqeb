import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { type Setting, SettingShapeError } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { heldTrustedProxies, trustedProxies } from "./proxies.ts";

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

describe("the trusted proxies the entry holds", () => {
  test("are none before onboarding opens a database, unless the variable is set", async () => {
    expect(await heldTrustedProxies([])(undefined, undefined)).toEqual([]);
    expect(
      await heldTrustedProxies(["10.0.0.1"])(undefined, undefined)
    ).toEqual(["10.0.0.1"]);
  });

  test("a saved value is in force once the change counter moves, and not before", async () => {
    const store = await storage();
    const held = heldTrustedProxies([]);
    expect(await held(store, 0)).toEqual([]);
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    expect(await held(store, 0)).toEqual([]);
    expect(await held(store, undefined)).toEqual([]);
    expect(await held(store, 1)).toEqual(["10.0.0.1"]);
  });

  test("the setting is read once per move of the counter, never per request", async () => {
    const store = await storage();
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    const watched = counted(store);
    const held = heldTrustedProxies([]);
    for (const counter of [3, 3, undefined, 3, 4, 4, undefined]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request after another, as the entry serves them
      expect(await held(watched.storage, counter)).toEqual(["10.0.0.1"]);
    }
    expect(watched.reads()).toBe(2);
  });

  test("the first request over an open database reads the setting even with no counter, as a POST reads none", async () => {
    const store = await storage();
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    expect(await heldTrustedProxies([])(store, undefined)).toEqual([
      "10.0.0.1",
    ]);
  });

  test("the variable wins: the setting is never read while RAAQEB_TRUSTED_PROXIES is set", async () => {
    const store = await storage();
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    const watched = counted(store);
    const held = heldTrustedProxies(["172.31.253.2"]);
    expect(await held(watched.storage, 0)).toEqual(["172.31.253.2"]);
    expect(await held(watched.storage, 1)).toEqual(["172.31.253.2"]);
    expect(watched.reads()).toBe(0);
  });

  test("a setting that cannot be read keeps the entries held, and the next request tries again", async () => {
    const store = await storage();
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    const held = heldTrustedProxies([]);
    expect(await held(store, 0)).toEqual(["10.0.0.1"]);
    const broken = {
      settings: {
        ...store.settings,
        get: () => Promise.reject(new Error("gone")),
      },
    };
    expect(await held(broken, 1)).toEqual(["10.0.0.1"]);
    await store.settings.set(trustedProxies, ["10.0.0.2"]);
    expect(await held(store, 1)).toEqual(["10.0.0.2"]);
  });

  test("a stored list outside the rule is never in force, and is read again only when the counter moves", async () => {
    const store = await storage();
    await store.settings.set(trustedProxies, ["10.0.0.1"]);
    const held = heldTrustedProxies([]);
    expect(await held(store, 0)).toEqual(["10.0.0.1"]);
    let reads = 0;
    const shapeless = {
      settings: {
        ...store.settings,
        get: () => {
          reads += 1;
          return Promise.reject(new SettingShapeError(trustedProxies.key));
        },
      },
    };
    expect(await held(shapeless, 1)).toEqual([]);
    expect(await held(shapeless, 1)).toEqual([]);
    expect(await held(shapeless, undefined)).toEqual([]);
    expect(reads).toBe(1);
  });
});

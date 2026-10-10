import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { retentionDays, sizeBudgetBytes } from "./retention.ts";
import { readStorageSettings, saveStorageSettings } from "./storage.ts";

let open:
  | {
      backend: Storage["backend"];
      cleanup: () => Promise<void>;
      storage: Storage;
    }
  | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location, {
    freeBytes: () => Promise.resolve(7 * 1024 * 1024 * 1024),
  });
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    backend: opened.storage.backend,
    cleanup: scratch.cleanup,
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

const mb = 1024 * 1024;

describe("the storage page's read", () => {
  test("shows the install retention, no budget, the used size, and the free disk on SQLite only", async () => {
    const store = await storage();
    const settings = await readStorageSettings(store);
    const sqlite = store.backend === "sqlite";
    expect(settings).toMatchObject({
      backend: store.backend,
      freeBytes: sqlite ? 7 * 1024 * mb : undefined,
      retentionDays: 90,
      sizeBudgetBytes: undefined,
    });
    expect(settings.usedBytes).toBeGreaterThan(0);
  });

  test("shows what is stored", async () => {
    const store = await storage();
    await store.settings.set(retentionDays, 30);
    await store.settings.set(sizeBudgetBytes, 2048 * mb);
    expect(await readStorageSettings(store)).toMatchObject({
      retentionDays: 30,
      sizeBudgetBytes: 2048 * mb,
    });
  });

  test("a size that cannot be read leaves the page readable, without it", async () => {
    const store = await storage();
    const settings = await readStorageSettings({
      ...store,
      size: {
        ...store.size,
        free: () => Promise.reject(new Error("statfs failed")),
        used: () => Promise.reject(new Error("the database did not answer")),
      },
    });
    expect(settings).toMatchObject({
      freeBytes: undefined,
      retentionDays: 90,
      usedBytes: undefined,
    });
  });
});

describe("the storage page's save", () => {
  test("stores the retention and the size budget, and moves no change counter", async () => {
    const store = await storage();
    const counter = await store.changeCounter();
    expect(
      await saveStorageSettings(store, {
        retentionDays: 14,
        sizeBudgetBytes: 256 * mb,
      })
    ).toEqual({ ok: true });
    expect(await store.settings.get(retentionDays)).toBe(14);
    expect(await store.settings.get(sizeBudgetBytes)).toBe(256 * mb);
    expect(await store.changeCounter()).toBe(counter);
  });

  test("an absent budget removes the row, so the install is unlimited again", async () => {
    const store = await storage();
    await store.settings.set(sizeBudgetBytes, 256 * mb);
    expect(await saveStorageSettings(store, { retentionDays: 90 })).toEqual({
      ok: true,
    });
    expect(await store.settings.get(sizeBudgetBytes)).toBeUndefined();
  });

  test("a database that fails refuses the save as unavailable", async () => {
    const store = await storage();
    expect(
      await saveStorageSettings(
        {
          settings: {
            ...store.settings,
            set: () => Promise.reject(new Error("the disk is busy")),
          },
        },
        { retentionDays: 90 }
      )
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

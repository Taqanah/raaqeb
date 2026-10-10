import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  dismissGettingStarted,
  gettingStartedClosed,
} from "./getting-started.ts";

let open: { cleanup: () => Promise<void>; storage: Storage } | undefined;

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

describe("dismissing the getting-started checklist", () => {
  test("is stored as the install's dismissal, which a fresh install lacks", async () => {
    const store = await storage();
    expect(await store.settings.get(gettingStartedClosed)).toBeUndefined();
    expect(await dismissGettingStarted(store)).toEqual({ ok: true });
    expect(await store.settings.get(gettingStartedClosed)).toBe(true);
  });

  test("answers unavailable when the database fails, never throwing", async () => {
    const store = await storage();
    const failing = {
      settings: {
        ...store.settings,
        set: () => Promise.reject(new Error("database gone")),
      },
    };
    expect(await dismissGettingStarted(failing)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

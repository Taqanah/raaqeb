import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  endNotificationHold,
  notificationHold,
  readNotificationHold,
} from "./hold.ts";

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

describe("the notification hold", () => {
  test("a fresh install is under none; a held one reads since when", async () => {
    const store = await storage();
    expect(await readNotificationHold(store)).toBeUndefined();
    await store.settings.set(notificationHold, 1_760_000_000_000);
    expect(await readNotificationHold(store)).toBe(1_760_000_000_000);
  });

  test("ending it leaves the install under none, and ending none is no error", async () => {
    const store = await storage();
    await store.settings.set(notificationHold, 1_760_000_000_000);
    expect(await endNotificationHold(store)).toEqual({ ok: true });
    expect(await readNotificationHold(store)).toBeUndefined();
    expect(await endNotificationHold(store)).toEqual({ ok: true });
  });

  test("ending it answers unavailable when the database fails, never throwing", async () => {
    const failing = {
      settings: {
        get: () => Promise.reject(new Error("down")),
        remove: () => Promise.reject(new Error("down")),
        set: () => Promise.reject(new Error("down")),
      },
    };
    expect(await endNotificationHold(failing)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

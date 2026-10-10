import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { publicAddress, readPublicAddress } from "./address.ts";

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

describe("the public address", () => {
  test("is a setting keyed public_address holding one origin", () => {
    expect(publicAddress.key).toBe("public_address");
    expect(
      publicAddress.schema.safeParse("https://status.example.test").success
    ).toBe(true);
    expect(
      publicAddress.schema.safeParse("https://status.example.test/").success
    ).toBe(false);
    expect(publicAddress.schema.safeParse("status.example.test").success).toBe(
      false
    );
  });

  test("is nothing before onboarding stores it, and nothing with no database", async () => {
    expect(await readPublicAddress(undefined)).toBeUndefined();
    expect(await readPublicAddress(await storage())).toBeUndefined();
  });

  test("answers the stored origin", async () => {
    const store = await storage();
    await store.settings.set(publicAddress, "https://status.example.test");
    expect(await readPublicAddress(store)).toBe("https://status.example.test");
  });

  test("a stored value that is not an origin is answered as nothing, so auth falls back to the request", async () => {
    const store = await storage();
    const anything = defineSetting<string>(publicAddress.key, {
      safeParse: (value: unknown) => ({ data: String(value), success: true }),
    } as never);
    await store.settings.set(anything, "not an origin");
    expect(await readPublicAddress(store)).toBeUndefined();
  });
});

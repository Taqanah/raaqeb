import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { publicAddress } from "./address.ts";
import { setAddressCommand } from "./command.ts";

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

/** A terminal that keeps what the command printed, standard output and standard error apart. */
function recording() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    out,
    terminal: {
      err: (line: string) => err.push(line),
      out: (line: string) => out.push(line),
    },
  };
}

describe("raaqeb set-address", () => {
  test("stores the address, exits 0 and names where to sign in, with no restart asked for", async () => {
    const store = await storage();
    await store.settings.set(publicAddress, "http://status.example.test");
    const { err, out, terminal } = recording();
    expect(
      await setAddressCommand(store, "https://status.example.test", terminal)
    ).toBe(0);
    expect(await store.settings.get(publicAddress)).toBe(
      "https://status.example.test"
    );
    expect(err).toEqual([]);
    const printed = out.join("\n");
    expect(printed).toContain("https://status.example.test/sign-in");
    expect(printed).not.toContain("restart");
  });

  test("a host a status page serves as its custom domain exits 1, says why, and stores nothing", async () => {
    const store = await storage();
    await store.pages.create({
      customDomain: "status.example.test",
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "status",
      title: { ar: "حالة" },
    });
    const { err, out, terminal } = recording();
    expect(
      await setAddressCommand(store, "https://status.example.test", terminal)
    ).toBe(1);
    expect(err.join("\n")).toContain("custom domain");
    expect(out).toEqual([]);
    expect(await store.settings.get(publicAddress)).toBeUndefined();
  });

  test("a database that does not answer exits 1 and says so", async () => {
    const store = await storage();
    await store.close();
    const { err, terminal } = recording();
    expect(
      await setAddressCommand(store, "https://status.example.test", terminal)
    ).toBe(1);
    expect(err.join("\n")).toContain("database did not answer");
  });
});

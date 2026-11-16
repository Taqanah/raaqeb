import { afterEach, describe, expect, test } from "bun:test";
import type { ApiKey } from "@/shared/schemas/api-key.ts";
import type { ApiKeyRow } from "./api-keys.ts";
import { runSql, scratchDatabase } from "./fixture.ts";
import { type DatabaseLocation, openStorage, type Storage } from "./storage.ts";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

async function storage(): Promise<{
  store: Storage;
  location: DatabaseLocation;
}> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return { location: scratch.location, store: opened.storage };
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** An account row as Better Auth writes it, with Raaqeb's role beside it. */
function account(location: DatabaseLocation, id: string, role: string) {
  return runSql(
    location,
    "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, role, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, 1000, 1000)",
    [id, `name ${id}`, `${id}@example.com`, role]
  );
}

function key(over: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    accountId: "a",
    createdAt: 1000,
    expiresAt: null,
    id: "k1",
    name: "deploy",
    role: "editor",
    tokenHash: "hash-1",
    ...over,
  };
}

const shown: ApiKey = {
  account: { email: "a@example.com", id: "a", name: "name a", role: "admin" },
  createdAt: 1000,
  expiresAt: null,
  id: "k1",
  lastUsedAddress: null,
  lastUsedAt: null,
  name: "deploy",
  role: "editor",
};

describe("the API keys", () => {
  test("one is written and read back with its account, never its secret's hash, the newest first", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await account(location, "b", "viewer");
    await store.apiKeys.create(key());
    await store.apiKeys.create(
      key({
        accountId: "b",
        createdAt: 2000,
        expiresAt: 9000,
        id: "k2",
        role: "viewer",
        tokenHash: "hash-2",
      })
    );
    expect(await store.apiKeys.find("k1")).toEqual(shown);
    expect(await store.apiKeys.find("nobody")).toBeUndefined();
    expect((await store.apiKeys.list()).map((one) => one.id)).toEqual([
      "k2",
      "k1",
    ]);
    expect(await store.apiKeys.ofAccount("a")).toEqual([shown]);
    expect(await store.apiKeys.ofAccount("c")).toEqual([]);
  });

  test("is found by its secret's hash while it has not expired", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key({ expiresAt: 5000 }));
    expect((await store.apiKeys.open("hash-1", 4999))?.id).toBe("k1");
    expect(await store.apiKeys.open("hash-1", 5000)).toBeUndefined();
    expect(await store.apiKeys.open("other", 1500)).toBeUndefined();
  });

  test("one that never expires is found at any time", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key());
    expect((await store.apiKeys.open("hash-1", 9e12))?.id).toBe("k1");
  });

  test("of a deactivated account is not found by its hash", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key());
    await runSql(
      location,
      "UPDATE auth_user SET deactivated_at = 2000 WHERE id = 'a'"
    );
    expect(await store.apiKeys.open("hash-1", 3000)).toBeUndefined();
  });

  test("a revoked one is gone, and revoking it again says so", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key());
    expect(await store.apiKeys.revoke("k1")).toBe(true);
    expect(await store.apiKeys.revoke("k1")).toBe(false);
    expect(await store.apiKeys.open("hash-1", 1500)).toBeUndefined();
    expect(await store.apiKeys.list()).toEqual([]);
  });

  test("a call records when it came and from which address", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key());
    await store.apiKeys.used("k1", 4000, "203.0.113.9");
    expect(await store.apiKeys.find("k1")).toMatchObject({
      lastUsedAddress: "203.0.113.9",
      lastUsedAt: 4000,
    });
    await store.apiKeys.used("k1", 5000, null);
    expect(await store.apiKeys.find("k1")).toMatchObject({
      lastUsedAddress: null,
      lastUsedAt: 5000,
    });
  });

  test("a stored role the code no longer names reads as the least one", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key());
    await runSql(location, "UPDATE api_keys SET role = 'root' WHERE id = 'k1'");
    expect((await store.apiKeys.find("k1"))?.role).toBe("viewer");
  });
});

describe("an account's keys", () => {
  test("go with the account when it is removed", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key());
    expect(await store.operatorAccounts.remove("a")).toBe(true);
    expect(await store.apiKeys.list()).toEqual([]);
  });

  test("are revoked when it is deactivated, and stay revoked once it is reactivated", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await account(location, "b", "admin");
    await store.apiKeys.create(key());
    await store.apiKeys.create(
      key({ accountId: "b", id: "k2", tokenHash: "hash-2" })
    );
    expect(await store.operatorAccounts.deactivate("a", 2000)).toBe(true);
    await store.operatorAccounts.reactivate("a");
    expect((await store.apiKeys.list()).map((one) => one.id)).toEqual(["k2"]);
  });

  test("drop to the account's new role when it is lowered below theirs, and keep a lower one", async () => {
    const { location, store } = await storage();
    await account(location, "a", "admin");
    await store.apiKeys.create(key({ role: "admin" }));
    await store.apiKeys.create(
      key({ id: "k2", role: "viewer", tokenHash: "hash-2" })
    );
    await store.apiKeys.create(
      key({ id: "k3", role: "owner", tokenHash: "hash-3" })
    );
    await store.operatorAccounts.setRole("a", "responder");
    expect((await store.apiKeys.find("k1"))?.role).toBe("responder");
    expect((await store.apiKeys.find("k3"))?.role).toBe("responder");
    expect((await store.apiKeys.find("k2"))?.role).toBe("viewer");
    // Raising the account again leaves the keys where they dropped to, to the widest role too, which no key is wider than.
    await store.operatorAccounts.setRole("a", "admin");
    expect(await store.operatorAccounts.setRole("a", "owner")).toBe(true);
    expect((await store.apiKeys.find("k1"))?.role).toBe("responder");
  });
});

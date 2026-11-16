import { afterEach, describe, expect, test } from "bun:test";
import { runSql, scratchDatabase } from "./fixture.ts";
import { type DatabaseLocation, openStorage, type Storage } from "./storage.ts";

let open:
  | {
      storage: Storage;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

async function storage(): Promise<{
  store: Storage;
  location: DatabaseLocation;
}> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    cleanup: scratch.cleanup,
    location: scratch.location,
    storage: opened.storage,
  };
  return { location: scratch.location, store: opened.storage };
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

interface Row {
  readonly createdAt?: number;
  readonly deactivatedAt?: number;
  readonly email?: string;
  readonly id: string;
  readonly role?: string;
  readonly secondStep?: boolean;
}

/** An account row as Better Auth writes it, with Raaqeb's role beside it. */
function account(location: DatabaseLocation, row: Row) {
  const at = row.createdAt ?? 1000;
  return runSql(
    location,
    "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, role, deactivated_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)",
    [
      row.id,
      `name ${row.id}`,
      row.email ?? `${row.id}@example.com`,
      row.secondStep ? 1 : 0,
      row.role ?? "viewer",
      // runSql takes strings and numbers only; a deactivation is set below.
      row.deactivatedAt ?? 0,
      at,
      at,
    ]
  ).then(() =>
    row.deactivatedAt === undefined
      ? runSql(
          location,
          "UPDATE auth_user SET deactivated_at = NULL WHERE id = ?",
          [row.id]
        )
      : []
  );
}

function session(
  location: DatabaseLocation,
  id: string,
  userId: string,
  createdAt: number,
  expiresAt = 10_000_000
) {
  return runSql(
    location,
    "INSERT INTO auth_session (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      userId,
      `token-${id}`,
      expiresAt,
      "203.0.113.9",
      "Firefox",
      createdAt,
      createdAt + 1,
    ]
  );
}

function app(location: DatabaseLocation, userId: string, verified: 0 | 1) {
  return runSql(
    location,
    "INSERT INTO auth_two_factor (id, user_id, secret, backup_codes, verified) VALUES (?, ?, ?, ?, ?)",
    [`tf-${userId}`, userId, "sealed", "sealed", verified]
  );
}

describe("the operator accounts", () => {
  test("do not exist on a fresh database, and exist once Better Auth wrote the first", async () => {
    const { location, store } = await storage();
    expect(await store.operatorAccounts.exists()).toBe(false);
    expect(await store.operatorAccounts.list()).toEqual([]);
    await account(location, { id: "a" });
    expect(await store.operatorAccounts.exists()).toBe(true);
  });

  test("are listed oldest first with their role, name, deactivation, second step and preferences", async () => {
    const { location, store } = await storage();
    await account(location, { createdAt: 2000, id: "b", role: "editor" });
    await account(location, {
      createdAt: 1000,
      id: "a",
      role: "owner",
      secondStep: true,
    });
    await account(location, {
      createdAt: 3000,
      deactivatedAt: 5000,
      id: "c",
    });
    await app(location, "a", 1);
    await runSql(
      location,
      "UPDATE auth_user SET language = 'en', time_zone = 'Asia/Riyadh', clock = '24h', calendar = 'hijri', last_sign_in_at = 4000 WHERE id = 'a'"
    );
    const list = await store.operatorAccounts.list();
    expect(list.map((one) => one.id)).toEqual(["a", "b", "c"]);
    expect(list[0]).toEqual({
      app: true,
      createdAt: 1000,
      deactivatedAt: null,
      email: "a@example.com",
      id: "a",
      lastSignInAt: 4000,
      name: "name a",
      preferences: {
        calendar: "hijri",
        clock: "24h",
        operatorLanguage: "en",
        timeZone: "Asia/Riyadh",
      },
      role: "owner",
      secondStep: true,
    });
    expect(list[1]).toMatchObject({
      app: false,
      preferences: {},
      role: "editor",
      secondStep: false,
    });
    expect(list[2]?.deactivatedAt).toBe(5000);
  });

  test("an authenticator app counts once its first code was entered, not before", async () => {
    const { location, store } = await storage();
    await account(location, { id: "a" });
    await app(location, "a", 0);
    expect((await store.operatorAccounts.find("a"))?.app).toBe(false);
    await runSql(location, "UPDATE auth_two_factor SET verified = 1");
    expect((await store.operatorAccounts.find("a"))?.app).toBe(true);
  });

  test("a preference stored that the install no longer knows reads as following the install", async () => {
    const { location, store } = await storage();
    await account(location, { id: "a" });
    await runSql(
      location,
      "UPDATE auth_user SET language = 'xx', clock = 'sundial', time_zone = 'Mars/Olympus'"
    );
    expect((await store.operatorAccounts.find("a"))?.preferences).toEqual({});
  });

  test("are found by id and by address whatever its case; nothing for one that is not there", async () => {
    const { location, store } = await storage();
    await account(location, { email: "ops@example.com", id: "a" });
    expect((await store.operatorAccounts.find("a"))?.email).toBe(
      "ops@example.com"
    );
    expect(
      (await store.operatorAccounts.findByEmail("OPS@Example.com"))?.id
    ).toBe("a");
    expect(await store.operatorAccounts.find("nobody")).toBeUndefined();
    expect(
      await store.operatorAccounts.findByEmail("nobody@example.com")
    ).toBeUndefined();
  });

  test("a role, a name and preferences are changed on the one account", async () => {
    const { location, store } = await storage();
    await account(location, { id: "a" });
    await account(location, { id: "b" });
    expect(await store.operatorAccounts.setRole("a", "admin")).toBe(true);
    expect(await store.operatorAccounts.rename("a", "Huda")).toBe(true);
    expect(
      await store.operatorAccounts.setPreferences("a", {
        clock: "24h",
        operatorLanguage: "en",
      })
    ).toBe(true);
    expect(await store.operatorAccounts.find("a")).toMatchObject({
      name: "Huda",
      preferences: { clock: "24h", operatorLanguage: "en" },
      role: "admin",
    });
    expect(
      await store.operatorAccounts.setPreferences("a", { clock: "12h" })
    ).toBe(true);
    expect((await store.operatorAccounts.find("a"))?.preferences).toEqual({
      clock: "12h",
    });
    expect(await store.operatorAccounts.find("b")).toMatchObject({
      name: "name b",
      preferences: {},
      role: "viewer",
    });
    expect(await store.operatorAccounts.setRole("nobody", "admin")).toBe(false);
  });

  test("deactivating keeps the account and ends every session of it, and of it alone; reactivating clears it", async () => {
    const { location, store } = await storage();
    await account(location, { id: "a" });
    await account(location, { id: "b" });
    await session(location, "s1", "a", 10);
    await session(location, "s2", "a", 20);
    await session(location, "s3", "b", 30);
    expect(await store.operatorAccounts.deactivate("a", 7000)).toBe(true);
    expect((await store.operatorAccounts.find("a"))?.deactivatedAt).toBe(7000);
    expect(await runSql(location, "SELECT id FROM auth_session")).toEqual([
      { id: "s3" },
    ]);
    expect(await store.operatorAccounts.reactivate("a")).toBe(true);
    expect((await store.operatorAccounts.find("a"))?.deactivatedAt).toBeNull();
    expect(await store.operatorAccounts.deactivate("nobody", 1)).toBe(false);
    expect(await store.operatorAccounts.reactivate("nobody")).toBe(false);
  });

  test("list an account's live sessions newest first, marking the current one, and end one or all of them", async () => {
    const { location, store } = await storage();
    await account(location, { id: "a" });
    await account(location, { id: "b" });
    await session(location, "s1", "a", 10);
    await session(location, "s2", "a", 20);
    await session(location, "old", "a", 5, 50);
    // A session whose expiry is this very moment is over.
    await session(location, "edge", "a", 6, 100);
    await session(location, "s3", "b", 30);
    const sessions = await store.operatorAccounts.sessions("a", 100, "s1");
    expect(sessions).toEqual([
      {
        createdAt: 20,
        current: false,
        expiresAt: 10_000_000,
        id: "s2",
        ipAddress: "203.0.113.9",
        updatedAt: 21,
        userAgent: "Firefox",
      },
      {
        createdAt: 10,
        current: true,
        expiresAt: 10_000_000,
        id: "s1",
        ipAddress: "203.0.113.9",
        updatedAt: 11,
        userAgent: "Firefox",
      },
    ]);
    expect(await store.operatorAccounts.endSession("a", "s3")).toBe(false);
    expect(await store.operatorAccounts.endSession("a", "s2")).toBe(true);
    expect(
      (await store.operatorAccounts.sessions("a", 100)).map((one) => one.id)
    ).toEqual(["s1"]);
    await store.operatorAccounts.endSessions("a");
    expect(await store.operatorAccounts.sessions("a", 100)).toEqual([]);
    expect(
      (await store.operatorAccounts.sessions("b", 100)).map((one) => one.id)
    ).toEqual(["s3"]);
  });

  test("removing one deletes it with its sessions, credentials, second step and settings of its own, and no other's", async () => {
    const { location, store } = await storage();
    await account(location, { id: "a" });
    await account(location, { id: "b" });
    await session(location, "s1", "a", 10);
    await app(location, "a", 1);
    await runSql(
      location,
      "INSERT INTO auth_account (id, user_id, account_id, provider_id, password, created_at, updated_at) VALUES ('c1', 'a', 'a', 'credential', 'hash', 0, 0)"
    );
    await runSql(
      location,
      "INSERT INTO settings (key, value, updated_at) VALUES ('auth_email_tested:a', '{}', 0), ('auth_email_tested:b', '{}', 0)"
    );
    expect(await store.operatorAccounts.remove("a")).toBe(true);
    expect(await store.operatorAccounts.find("a")).toBeUndefined();
    expect(await runSql(location, "SELECT id FROM auth_session")).toEqual([]);
    expect(await runSql(location, "SELECT id FROM auth_account")).toEqual([]);
    expect(await runSql(location, "SELECT id FROM auth_two_factor")).toEqual(
      []
    );
    expect(await runSql(location, "SELECT key FROM settings")).toEqual([
      { key: "auth_email_tested:b" },
    ]);
    expect(await store.operatorAccounts.remove("a")).toBe(false);
  });

  test("the second step goes off with the app, or the app alone, for the one account", async () => {
    const { location, store } = await storage();
    await account(location, { id: "a", secondStep: true });
    await account(location, { id: "b", secondStep: true });
    await app(location, "a", 1);
    await app(location, "b", 1);
    await store.operatorAccounts.appOff("a");
    expect(await store.operatorAccounts.find("a")).toMatchObject({
      app: false,
      secondStep: true,
    });
    await store.operatorAccounts.secondStepOff("b");
    expect(await store.operatorAccounts.find("b")).toMatchObject({
      app: false,
      secondStep: false,
    });
    expect((await store.operatorAccounts.find("a"))?.secondStep).toBe(true);
  });

  test("a database that cannot answer throws, so the caller decides", async () => {
    const { store } = await storage();
    await store.close();
    await expect(store.operatorAccounts.exists()).rejects.toBeDefined();
  });
});

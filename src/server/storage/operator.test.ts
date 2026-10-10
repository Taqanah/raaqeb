import { afterEach, describe, expect, test } from "bun:test";
import { runSql, scratchDatabase } from "./fixture.ts";
import { openStorage, type Storage } from "./storage.ts";

let open:
  | {
      storage: Storage;
      cleanup: () => Promise<void>;
      location: Parameters<typeof runSql>[0];
    }
  | undefined;

async function storage(): Promise<Storage> {
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
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

describe("the operator account", () => {
  test("does not exist on a fresh database, and exists once Better Auth wrote its row", async () => {
    const store = await storage();
    expect(await store.operatorAccount.exists()).toBe(false);
    const now = Date.now();
    await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["0192", "operator", "operator@example.com", 0, now, now]
    );
    expect(await store.operatorAccount.exists()).toBe(true);
  });

  test("is read as its id, email and whether the second step is on; nothing before it exists", async () => {
    const store = await storage();
    expect(await store.operatorAccount.read()).toBeUndefined();
    const now = Date.now();
    await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["0192", "operator", "operator@example.com", 0, 1, now, now]
    );
    expect(await store.operatorAccount.read()).toEqual({
      app: false,
      email: "operator@example.com",
      id: "0192",
      secondStep: true,
    });
  });

  test("the authenticator app counts as set up once its first code was entered, not before", async () => {
    const store = await storage();
    const location = open?.location ?? { backend: "sqlite", file: "" };
    const now = Date.now();
    await runSql(
      location,
      "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["0192", "operator", "operator@example.com", 0, 0, now, now]
    );
    await runSql(
      location,
      "INSERT INTO auth_two_factor (id, user_id, secret, backup_codes, verified) VALUES (?, ?, ?, ?, ?)",
      ["tf1", "0192", "sealed", "sealed", 0]
    );
    expect((await store.operatorAccount.read())?.app).toBe(false);
    await runSql(location, "UPDATE auth_two_factor SET verified = 1");
    expect((await store.operatorAccount.read())?.app).toBe(true);
  });

  test("the reset command switches the second step off and removes the authenticator app; nothing to do before the account exists", async () => {
    const store = await storage();
    await store.operatorAccount.secondStepOff();
    const location = open?.location ?? { backend: "sqlite", file: "" };
    const now = Date.now();
    await runSql(
      location,
      "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["0192", "operator", "operator@example.com", 0, 1, now, now]
    );
    await runSql(
      location,
      "INSERT INTO auth_two_factor (id, user_id, secret, backup_codes, verified) VALUES (?, ?, ?, ?, ?)",
      ["tf1", "0192", "sealed", "sealed", 1]
    );
    await store.operatorAccount.secondStepOff();
    expect(await store.operatorAccount.read()).toMatchObject({
      app: false,
      secondStep: false,
    });
    expect(await runSql(location, "SELECT id FROM auth_two_factor")).toEqual(
      []
    );
  });

  test("removing the authenticator app leaves the second step as it is", async () => {
    const store = await storage();
    const location = open?.location ?? { backend: "sqlite", file: "" };
    const now = Date.now();
    await runSql(
      location,
      "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["0192", "operator", "operator@example.com", 0, 1, now, now]
    );
    await runSql(
      location,
      "INSERT INTO auth_two_factor (id, user_id, secret, backup_codes, verified) VALUES (?, ?, ?, ?, ?)",
      ["tf1", "0192", "sealed", "sealed", 1]
    );
    await store.operatorAccount.appOff();
    expect(await store.operatorAccount.read()).toMatchObject({
      app: false,
      secondStep: true,
    });
    expect(await runSql(location, "SELECT id FROM auth_two_factor")).toEqual(
      []
    );
  });

  test("a database that cannot answer throws, so the caller decides", async () => {
    const store = await storage();
    await store.close();
    await expect(store.operatorAccount.exists()).rejects.toBeDefined();
    open = undefined;
  });
});

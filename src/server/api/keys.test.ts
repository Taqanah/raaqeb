import { afterEach, describe, expect, test } from "bun:test";
import { secondStepRequired } from "@/server/auth/second-step.ts";
import type { Operator } from "@/server/auth/session.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { Role } from "@/shared/domain/roles.ts";
import {
  createApiKey,
  hashApiKey,
  newApiKeySecret,
  readApiKeys,
  revokeApiKey,
} from "./keys.ts";

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

/** An account row as Better Auth writes it, and the operator its session would name. */
async function operator(
  location: DatabaseLocation,
  id: string,
  role: Role
): Promise<Operator> {
  await runSql(
    location,
    "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, role, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, 1000, 1000)",
    [id, `name ${id}`, `${id}@example.com`, role]
  );
  return {
    email: `${id}@example.com`,
    id,
    name: `name ${id}`,
    preferences: {},
    role,
    secondStep: false,
    sessionId: `session-${id}`,
    signedInWith: "password",
  };
}

const day = 86_400_000;
const secretShape = /^rqk_[A-Za-z0-9_-]{43}$/;
const hexDigest = /^[0-9a-f]{64}$/;

describe("a new API key", () => {
  test("is a fresh secret each time, behind a prefix a secret scanner can name", () => {
    const first = newApiKeySecret();
    expect(first).toMatch(secretShape);
    expect(newApiKeySecret()).not.toBe(first);
  });

  test("is shown once, and storage keeps only its secret's SHA-256", async () => {
    const { location, store } = await storage();
    const owner = await operator(location, "a", "owner");
    const made = await createApiKey(
      store,
      owner,
      { expiresInDays: 30, name: "deploy", role: "editor" },
      1000
    );
    if (!made.ok) {
      throw new Error(made.reason);
    }
    expect(made.secret).toMatch(secretShape);
    expect(made.key).toMatchObject({
      account: { id: "a", role: "owner" },
      createdAt: 1000,
      expiresAt: 1000 + 30 * day,
      name: "deploy",
      role: "editor",
    });
    const [row] = await runSql(location, "SELECT token_hash FROM api_keys");
    expect(row?.token_hash).toBe(hashApiKey(made.secret));
    expect(hashApiKey(made.secret)).toMatch(hexDigest);
  });

  test("with no lifetime never expires", async () => {
    const { location, store } = await storage();
    const owner = await operator(location, "a", "owner");
    const made = await createApiKey(
      store,
      owner,
      { expiresInDays: null, name: "ci", role: "viewer" },
      1000
    );
    expect(made.ok && made.key.expiresAt).toBeNull();
  });

  test("may carry the account's role or one below it, never one above", async () => {
    const { location, store } = await storage();
    const editor = await operator(location, "e", "editor");
    const input = { expiresInDays: null, name: "ci" } as const;
    expect(
      (await createApiKey(store, editor, { ...input, role: "editor" }, 1000)).ok
    ).toBe(true);
    expect(
      await createApiKey(store, editor, { ...input, role: "admin" }, 1000)
    ).toEqual({ ok: false, reason: "role" });
    expect(
      await createApiKey(store, editor, { ...input, role: "owner" }, 1000)
    ).toEqual({ ok: false, reason: "role" });
    expect(await store.apiKeys.list()).toHaveLength(1);
  });
});

describe("the keys page", () => {
  test("shows an operator their own keys and the roles a new one may carry, and no one else's to a role that does not manage the team", async () => {
    const { location, store } = await storage();
    const admin = await operator(location, "a", "admin");
    const editor = await operator(location, "e", "editor");
    const input = { expiresInDays: null, name: "ci" } as const;
    await createApiKey(store, admin, { ...input, role: "admin" }, 1000);
    await createApiKey(store, editor, { ...input, role: "viewer" }, 2000);
    const seen = await readApiKeys(store, editor);
    if (!seen.ok) {
      throw new Error(seen.reason);
    }
    expect(seen.own.map((one) => one.account.id)).toEqual(["e"]);
    expect(seen.all).toBeUndefined();
    expect(seen.revocable).toEqual([]);
    expect(seen.roles).toEqual(["editor", "responder", "viewer"]);
  });

  test("shows an operator who manages the team every key, those of accounts they manage revocable", async () => {
    const { location, store } = await storage();
    const owner = await operator(location, "o", "owner");
    const admin = await operator(location, "a", "admin");
    const editor = await operator(location, "e", "editor");
    const input = { expiresInDays: null, name: "ci" } as const;
    const ownerKey = await createApiKey(
      store,
      owner,
      { ...input, role: "owner" },
      1000
    );
    const editorKey = await createApiKey(
      store,
      editor,
      { ...input, role: "editor" },
      2000
    );
    const adminKey = await createApiKey(
      store,
      admin,
      { ...input, role: "viewer" },
      3000
    );
    const seen = await readApiKeys(store, admin);
    if (!(seen.ok && ownerKey.ok && editorKey.ok && adminKey.ok)) {
      throw new Error("not made");
    }
    expect(seen.all?.map((one) => one.id)).toEqual([
      adminKey.key.id,
      editorKey.key.id,
      ownerKey.key.id,
    ]);
    expect(seen.revocable.toSorted()).toEqual(
      [adminKey.key.id, editorKey.key.id].toSorted()
    );
    const byOwner = await readApiKeys(store, owner);
    expect(byOwner.ok && byOwner.revocable).toHaveLength(3);
  });

  test("shows no one else's keys to an admin who owes the second step an owner requires", async () => {
    const { location, store } = await storage();
    const admin = await operator(location, "a", "admin");
    await store.settings.set(secondStepRequired, true);
    const seen = await readApiKeys(store, admin);
    expect(seen.ok && seen.all).toBeUndefined();
  });
});

describe("revoking a key", () => {
  test("an admin who owes the second step an owner requires revokes their own key and no one else's", async () => {
    const { location, store } = await storage();
    const admin = await operator(location, "a", "admin");
    const editor = await operator(location, "e", "editor");
    const input = { expiresInDays: null, name: "ci", role: "viewer" } as const;
    const own = await createApiKey(store, admin, input, 1000);
    const other = await createApiKey(store, editor, input, 1000);
    if (!(own.ok && other.ok)) {
      throw new Error("not made");
    }
    await store.settings.set(secondStepRequired, true);
    expect(await revokeApiKey(store, admin, other.key.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await revokeApiKey(store, admin, own.key.id)).toEqual({ ok: true });
  });

  test("an operator revokes their own; it stops at once", async () => {
    const { location, store } = await storage();
    const viewer = await operator(location, "v", "viewer");
    const made = await createApiKey(
      store,
      viewer,
      { expiresInDays: null, name: "ci", role: "viewer" },
      1000
    );
    if (!made.ok) {
      throw new Error(made.reason);
    }
    expect(await revokeApiKey(store, viewer, made.key.id)).toEqual({
      ok: true,
    });
    expect(await store.apiKeys.open(hashApiKey(made.secret), 2000)).toBe(
      undefined
    );
    expect(await revokeApiKey(store, viewer, made.key.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("an admin revokes a key of an account they manage, never an owner's; a role that does not manage the team, no one else's", async () => {
    const { location, store } = await storage();
    const owner = await operator(location, "o", "owner");
    const admin = await operator(location, "a", "admin");
    const editor = await operator(location, "e", "editor");
    const other = await operator(location, "f", "editor");
    const input = { expiresInDays: null, name: "ci" } as const;
    const ownerKey = await createApiKey(
      store,
      owner,
      { ...input, role: "viewer" },
      1000
    );
    const editorKey = await createApiKey(
      store,
      editor,
      { ...input, role: "viewer" },
      1000
    );
    if (!(ownerKey.ok && editorKey.ok)) {
      throw new Error("not made");
    }
    const refused = { ok: false, reason: "not_found" } as const;
    expect(await revokeApiKey(store, other, editorKey.key.id)).toEqual(refused);
    expect(await revokeApiKey(store, admin, ownerKey.key.id)).toEqual(refused);
    expect(await revokeApiKey(store, admin, editorKey.key.id)).toEqual({
      ok: true,
    });
    expect(await revokeApiKey(store, owner, ownerKey.key.id)).toEqual({
      ok: true,
    });
    expect(await store.apiKeys.list()).toEqual([]);
  });
});

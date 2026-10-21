import { afterEach, describe, expect, test } from "bun:test";
import { runSql, scratchDatabase } from "./fixture.ts";
import type { InvitationRow } from "./invitations.ts";
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

function invitation(over: Partial<InvitationRow> = {}): InvitationRow {
  return {
    createdAt: 1000,
    email: "new@example.com",
    expiresAt: 5000,
    id: "i1",
    invitedBy: null,
    role: "editor",
    tokenHash: "hash-1",
    ...over,
  };
}

const { tokenHash: _hash, ...shown } = invitation();

describe("the invitations", () => {
  test("one is written and listed without its token's hash, the newest first", async () => {
    const { store } = await storage();
    await store.invitations.put(invitation());
    await store.invitations.put(
      invitation({
        createdAt: 2000,
        email: "later@example.com",
        id: "i2",
        tokenHash: "hash-2",
      })
    );
    const list = await store.invitations.list();
    expect(list.map((one) => one.id)).toEqual(["i2", "i1"]);
    expect(list[1]).toEqual(shown);
    expect(await store.invitations.find("i1")).toEqual(shown);
    expect(await store.invitations.find("nobody")).toBeUndefined();
  });

  test("a second to the same address replaces the first, so its old link stops working", async () => {
    const { store } = await storage();
    await store.invitations.put(invitation());
    await store.invitations.put(
      invitation({ id: "i2", role: "viewer", tokenHash: "hash-2" })
    );
    expect(await store.invitations.list()).toEqual([
      { ...shown, id: "i2", role: "viewer" },
    ]);
    expect(await store.invitations.open("hash-1", 1500)).toBeUndefined();
    expect((await store.invitations.open("hash-2", 1500))?.id).toBe("i2");
  });

  test("is open by its token's hash until it expires", async () => {
    const { store } = await storage();
    await store.invitations.put(invitation());
    expect(await store.invitations.open("hash-1", 4999)).toEqual(shown);
    expect(await store.invitations.open("hash-1", 5000)).toBeUndefined();
    expect(await store.invitations.open("other", 1500)).toBeUndefined();
  });

  test("taking one deletes it, so its link signs up once; an expired one is not taken", async () => {
    const { store } = await storage();
    await store.invitations.put(invitation());
    expect(await store.invitations.take("hash-1", 1500)).toEqual(shown);
    expect(await store.invitations.take("hash-1", 1500)).toBeUndefined();
    expect(await store.invitations.list()).toEqual([]);
    await store.invitations.put(invitation());
    expect(await store.invitations.take("hash-1", 6000)).toBeUndefined();
    expect(await store.invitations.list()).toHaveLength(1);
  });

  test("two takes of one link at once answer it to one of them", async () => {
    const { store } = await storage();
    await store.invitations.put(invitation());
    const taken = await Promise.all([
      store.invitations.take("hash-1", 1500),
      store.invitations.take("hash-1", 1500),
    ]);
    expect(taken.filter((one) => one !== undefined)).toHaveLength(1);
  });

  test("renewing gives it a new token and lifetime, and the old link stops working", async () => {
    const { store } = await storage();
    await store.invitations.put(invitation());
    expect(await store.invitations.renew("i1", "hash-new", 3000, 9000)).toBe(
      true
    );
    expect(await store.invitations.open("hash-1", 3500)).toBeUndefined();
    expect(await store.invitations.open("hash-new", 8000)).toEqual({
      ...shown,
      createdAt: 3000,
      expiresAt: 9000,
    });
    expect(await store.invitations.renew("nobody", "x", 1, 2)).toBe(false);
  });

  test("revoking deletes it once", async () => {
    const { store } = await storage();
    await store.invitations.put(invitation());
    expect(await store.invitations.revoke("i1")).toBe(true);
    expect(await store.invitations.revoke("i1")).toBe(false);
  });

  test("keeps the inviting account while it exists, and none once it is removed", async () => {
    const { location, store } = await storage();
    await runSql(
      location,
      "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES ('a', '', 'a@example.com', 0, 0, 0)"
    );
    await store.invitations.put(invitation({ invitedBy: "a" }));
    expect((await store.invitations.find("i1"))?.invitedBy).toBe("a");
    await runSql(location, "DELETE FROM auth_user");
    expect((await store.invitations.find("i1"))?.invitedBy).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  invitationLinkOf,
  invitationTokenHash,
} from "@/server/auth/invitation.ts";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { createChannel } from "@/server/notify/channels.ts";
import { fakeSmtp } from "@/server/notify/fixture.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { Role } from "@/shared/domain/roles.ts";
import {
  type Actor,
  changeRole,
  deactivate,
  invitationDays,
  invitationsPerHour,
  invite,
  inviteAgain,
  reactivate,
  readTeam,
  remove,
  revokeInvitation,
  transferOwnership,
} from "./team.ts";

// The team: who may invite, change, deactivate and remove whom, an owner's
// password for anything that gives or takes the owner role, an operator's
// own account kept out of their reach, and the sessions a change ends. Over
// a scratch database, on both backends.

const key = await scratchInstallKey();
const io = { fetch, now: Date.now };
const now = 1_800_000_000_000;
const day = 24 * 60 * 60 * 1000;
const tokenInLink = /[?&]token=([^&]+)/;

let open:
  | {
      storage: Storage;
      location: DatabaseLocation;
      cleanup: () => Promise<void>;
    }
  | undefined;
afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** A team of five, one per role, `owner` the oldest, each with one session, and the public address stored. */
async function team(): Promise<{
  storage: Storage;
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
  const roles: Role[] = ["owner", "admin", "editor", "responder", "viewer"];
  for (const [index, role] of roles.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: the accounts' order is their age
    await runSql(
      scratch.location,
      "INSERT INTO auth_user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
      [
        role,
        role === "owner" ? "" : `The ${role}`,
        `${role}@example.com`,
        role,
        index,
        index,
      ]
    );
    await runSql(
      scratch.location,
      "INSERT INTO auth_session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
      [`s-${role}`, role, `t-${role}`, now + day]
    );
  }
  await opened.storage.settings.set(
    publicAddress,
    "https://status.example.com"
  );
  return { location: scratch.location, storage: opened.storage };
}

const as = (role: Role): Actor => ({ id: role, role });
const rightPassword = (password: string) =>
  Promise.resolve(
    password === "the password" ? ("right" as const) : ("wrong" as const)
  );
const sessionsOf = async (storage: Storage, id: string) =>
  (await storage.operatorAccounts.sessions(id, now)).map((one) => one.id);

describe("the team page's read", () => {
  test("lists every account oldest first, with what an owner may do to each: anything but their own", async () => {
    const { storage } = await team();
    const view = await readTeam(storage, as("owner"));
    expect(view?.members.map((one) => one.account.id)).toEqual([
      "owner",
      "admin",
      "editor",
      "responder",
      "viewer",
    ]);
    expect(view?.members[0]).toMatchObject({
      assignable: [],
      manageable: false,
      self: true,
    });
    expect(view?.members[1]).toMatchObject({
      assignable: ["owner", "admin", "editor", "responder", "viewer"],
      manageable: true,
      self: false,
    });
    expect(view?.invitable).toEqual([
      "owner",
      "admin",
      "editor",
      "responder",
      "viewer",
    ]);
    expect(view?.ownership).toBe(true);
    expect(view?.mail).toBe(false);
    expect(view?.members[1]?.account).not.toHaveProperty("preferences");
  });

  test("an admin may do nothing to an owner, and gives any role but the owner's", async () => {
    const { storage } = await team();
    const view = await readTeam(storage, as("admin"));
    expect(view?.members[0]).toMatchObject({
      assignable: [],
      manageable: false,
    });
    expect(view?.members[2]).toMatchObject({
      assignable: ["admin", "editor", "responder", "viewer"],
      manageable: true,
    });
    expect(view?.invitable).toEqual(["admin", "editor", "responder", "viewer"]);
    expect(view?.ownership).toBe(false);
  });

  test("is nothing for a role that does not manage the team", async () => {
    const { storage } = await team();
    expect(await readTeam(storage, as("editor"))).toBeUndefined();
    expect(await readTeam(storage, as("viewer"))).toBeUndefined();
  });

  test("names who sent each invitation, by name or else by email", async () => {
    const { storage } = await team();
    await invite(
      storage,
      key,
      io,
      as("admin"),
      { email: "a@example.com", role: "viewer" },
      now
    );
    await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "b@example.com", role: "editor" },
      now + 1
    );
    const view = await readTeam(storage, as("owner"));
    expect(
      view?.invitations.map((one) => [one.email, one.invitedByName])
    ).toEqual([
      ["b@example.com", "owner@example.com"],
      ["a@example.com", "The admin"],
    ]);
  });
});

describe("an invitation", () => {
  test("is stored by its token's hash with the role, the sender and seven days, and its link comes back to copy", async () => {
    const { storage } = await team();
    const sent = await invite(
      storage,
      key,
      io,
      as("admin"),
      { email: "New@Example.com", role: "editor" },
      now
    );
    if (!sent.ok) {
      throw new Error(sent.reason);
    }
    expect(sent.emailed).toBe(false);
    const token = sent.link.match(tokenInLink)?.[1] ?? "";
    expect(sent.link).toBe(
      invitationLinkOf("https://status.example.com", token)
    );
    expect(
      await storage.invitations.open(invitationTokenHash(token), now)
    ).toMatchObject({
      email: "new@example.com",
      expiresAt: now + invitationDays * day,
      invitedBy: "admin",
      role: "editor",
    });
  });

  test("goes by email too when an email channel exists, in the install language", async () => {
    const { storage } = await team();
    const smtp = fakeSmtp();
    try {
      const created = await createChannel(storage, key, {
        appliesToNew: false,
        name: "Mail",
        type: "email",
        values: {
          from: "راقب <raaqeb@example.com>",
          host: "127.0.0.1",
          port: String(smtp.port),
          security: "none",
          to: "team@example.com",
        },
      });
      expect(created.ok).toBe(true);
      const sent = await invite(
        storage,
        key,
        io,
        as("owner"),
        { email: "new@example.com", role: "viewer" },
        now
      );
      expect(sent).toMatchObject({ emailed: true, ok: true });
      expect(smtp.commands.join("\n")).toContain("RCPT TO:<new@example.com>");
      expect((await readTeam(storage, as("owner")))?.mail).toBe(true);
    } finally {
      smtp.stop();
    }
  });

  test("whose email fails is still made, its link shown and not emailed", async () => {
    const { storage } = await team();
    const created = await createChannel(storage, key, {
      appliesToNew: false,
      name: "Mail",
      type: "email",
      values: {
        from: "raaqeb@example.com",
        host: "127.0.0.1",
        port: "1",
        security: "none",
        to: "team@example.com",
      },
    });
    expect(created.ok).toBe(true);
    const sent = await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "new@example.com", role: "viewer" },
      now
    );
    expect(sent).toMatchObject({ emailed: false, ok: true });
    expect(await storage.invitations.list()).toHaveLength(1);
  });

  test("to an address with an account is refused, whatever its case", async () => {
    const { storage } = await team();
    expect(
      await invite(
        storage,
        key,
        io,
        as("owner"),
        { email: "Editor@Example.com", role: "viewer" },
        now
      )
    ).toEqual({ ok: false, reason: "already_member" });
  });

  test("with a role the sender may not give is refused, as is one from a role that does not manage the team", async () => {
    const { storage } = await team();
    expect(
      await invite(
        storage,
        key,
        io,
        as("admin"),
        { email: "new@example.com", role: "owner" },
        now
      )
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect(
      await invite(
        storage,
        key,
        io,
        as("editor"),
        { email: "new@example.com", role: "viewer" },
        now
      )
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect(await storage.invitations.list()).toEqual([]);
  });

  test("to an address that is not one is invalid, and nothing is stored", async () => {
    const { storage } = await team();
    expect(
      await invite(
        storage,
        key,
        io,
        as("owner"),
        { email: "not an address", role: "viewer" },
        now
      )
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await storage.invitations.list()).toEqual([]);
  });

  test("needs a public address for its link", async () => {
    const { storage } = await team();
    await storage.settings.remove(publicAddress);
    expect(
      await invite(
        storage,
        key,
        io,
        as("owner"),
        { email: "new@example.com", role: "viewer" },
        now
      )
    ).toEqual({ ok: false, reason: "no_address" });
  });

  test("to the same address again replaces the first, so its link stops working", async () => {
    const { storage } = await team();
    const first = await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "new@example.com", role: "viewer" },
      now
    );
    const second = await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "new@example.com", role: "editor" },
      now + 1
    );
    if (!(first.ok && second.ok)) {
      throw new Error("not sent");
    }
    const hashOf = (link: string) =>
      invitationTokenHash(link.match(tokenInLink)?.[1] ?? "");
    expect(
      await storage.invitations.open(hashOf(first.link), now + 2)
    ).toBeUndefined();
    expect(
      (await storage.invitations.open(hashOf(second.link), now + 2))?.role
    ).toBe("editor");
  });

  test("to an address with an open invitation of a role the sender may not give leaves that invitation alone", async () => {
    const { storage } = await team();
    await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "co@example.com", role: "owner" },
      now
    );
    expect(
      await invite(
        storage,
        key,
        io,
        as("admin"),
        { email: "co@example.com", role: "viewer" },
        now + 1
      )
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect((await storage.invitations.list()).map((one) => one.role)).toEqual([
      "owner",
    ]);
  });

  test("goes out at most so many times an hour, sending again included, and again once the hour has passed", async () => {
    const { storage } = await team();
    for (let index = 0; index < invitationsPerHour; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each counts toward the hour in order
      const sent = await invite(
        storage,
        key,
        io,
        as("owner"),
        { email: `n${index}@example.com`, role: "viewer" },
        now + index
      );
      expect(sent.ok).toBe(true);
    }
    expect(
      await invite(
        storage,
        key,
        io,
        as("owner"),
        { email: "late@example.com", role: "viewer" },
        now + 100
      )
    ).toEqual({ ok: false, reason: "too_many" });
    const [one] = await storage.invitations.list();
    expect(
      await inviteAgain(storage, key, io, as("owner"), one?.id ?? "", now + 100)
    ).toEqual({ ok: false, reason: "too_many" });
    const late = (at: number) =>
      invite(
        storage,
        key,
        io,
        as("owner"),
        { email: "late@example.com", role: "viewer" },
        at
      );
    expect(await late(now + 60 * 60 * 1000 - 1)).toEqual({
      ok: false,
      reason: "too_many",
    });
    // The first send is an hour old: it no longer counts.
    expect((await late(now + 60 * 60 * 1000)).ok).toBe(true);
  });

  test("sent again gets a new link and seven more days; the old link stops working", async () => {
    const { storage } = await team();
    const first = await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "new@example.com", role: "viewer" },
      now
    );
    const [invitation] = await storage.invitations.list();
    const again = await inviteAgain(
      storage,
      key,
      io,
      as("admin"),
      invitation?.id ?? "",
      now + day
    );
    if (!(first.ok && again.ok)) {
      throw new Error("not sent");
    }
    expect(again.link).not.toBe(first.link);
    const hashOf = (link: string) =>
      invitationTokenHash(link.match(tokenInLink)?.[1] ?? "");
    expect(
      await storage.invitations.open(hashOf(first.link), now + day)
    ).toBeUndefined();
    expect(
      (await storage.invitations.open(hashOf(again.link), now + day))?.expiresAt
    ).toBe(now + day + invitationDays * day);
    expect(
      await inviteAgain(storage, key, io, as("owner"), "gone", now)
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("of an owner is sent again or revoked by an owner alone", async () => {
    const { storage } = await team();
    await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "new@example.com", role: "owner" },
      now
    );
    const [invitation] = await storage.invitations.list();
    const id = invitation?.id ?? "";
    expect(await inviteAgain(storage, key, io, as("admin"), id, now)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await revokeInvitation(storage, as("admin"), id)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await revokeInvitation(storage, as("owner"), id)).toEqual({
      ok: true,
    });
    expect(await revokeInvitation(storage, as("owner"), id)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("a change of role", () => {
  test("to a lower one ends the account's sessions; to a higher one or the same keeps them", async () => {
    const { storage } = await team();
    expect(
      await changeRole(
        storage,
        as("admin"),
        { id: "editor", role: "viewer" },
        rightPassword
      )
    ).toEqual({ ok: true });
    expect((await storage.operatorAccounts.find("editor"))?.role).toBe(
      "viewer"
    );
    expect(await sessionsOf(storage, "editor")).toEqual([]);
    expect(
      await changeRole(
        storage,
        as("admin"),
        { id: "responder", role: "editor" },
        rightPassword
      )
    ).toEqual({ ok: true });
    expect(await sessionsOf(storage, "responder")).toEqual(["s-responder"]);
    expect(
      await changeRole(
        storage,
        as("admin"),
        { id: "responder", role: "editor" },
        rightPassword
      )
    ).toEqual({ ok: true });
    expect(await sessionsOf(storage, "responder")).toEqual(["s-responder"]);
  });

  test("to a lower one revokes the invitations the account could no longer send", async () => {
    const { storage } = await team();
    await storage.operatorAccounts.setRole("admin", "owner");
    const second = { id: "admin", role: "owner" } as const;
    await invite(
      storage,
      key,
      io,
      second,
      { email: "co@example.com", role: "owner" },
      now
    );
    await invite(
      storage,
      key,
      io,
      second,
      { email: "ed@example.com", role: "editor" },
      now
    );
    await changeRole(
      storage,
      as("owner"),
      { id: "admin", password: "the password", role: "admin" },
      rightPassword
    );
    expect((await storage.invitations.list()).map((one) => one.email)).toEqual([
      "ed@example.com",
    ]);
    await changeRole(
      storage,
      as("owner"),
      { id: "admin", role: "editor" },
      rightPassword
    );
    expect(await storage.invitations.list()).toEqual([]);
  });

  test("an admin neither gives the owner role nor changes an owner", async () => {
    const { storage } = await team();
    expect(
      await changeRole(
        storage,
        as("admin"),
        { id: "editor", password: "the password", role: "owner" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect(
      await changeRole(
        storage,
        as("admin"),
        { id: "owner", role: "viewer" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect((await storage.operatorAccounts.find("owner"))?.role).toBe("owner");
  });

  test("giving or taking the owner role asks for the owner's password", async () => {
    const { storage } = await team();
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "admin", role: "owner" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "admin", password: "a guess", role: "owner" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect((await storage.operatorAccounts.find("admin"))?.role).toBe("admin");
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "admin", password: "the password", role: "owner" },
        rightPassword
      )
    ).toEqual({ ok: true });
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "admin", password: "the password", role: "editor" },
        rightPassword
      )
    ).toEqual({ ok: true });
    expect((await storage.operatorAccounts.find("admin"))?.role).toBe("editor");
  });

  test("of one's own account is refused, so the last owner cannot step down", async () => {
    const { storage } = await team();
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "owner", password: "the password", role: "admin" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "self" });
    expect(
      await changeRole(
        storage,
        as("admin"),
        { id: "admin", role: "viewer" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "self" });
  });

  test("is judged by the role the operator has now, not the one they signed in with", async () => {
    const { storage } = await team();
    await storage.operatorAccounts.setRole("admin", "viewer");
    expect(
      await changeRole(
        storage,
        as("admin"),
        { id: "editor", role: "viewer" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "not_allowed" });
    await storage.operatorAccounts.deactivate("owner", now);
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "editor", role: "viewer" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "not_allowed" });
  });

  test("of two owners demoting each other at once, one wins and the install keeps an owner", async () => {
    const { storage } = await team();
    await storage.operatorAccounts.setRole("admin", "owner");
    const both = await Promise.all([
      changeRole(
        storage,
        as("owner"),
        { id: "admin", password: "the password", role: "editor" },
        rightPassword
      ),
      changeRole(
        storage,
        { id: "admin", role: "owner" },
        { id: "owner", password: "the password", role: "editor" },
        rightPassword
      ),
    ]);
    expect(both.filter((one) => one.ok)).toHaveLength(1);
    expect(
      (await storage.operatorAccounts.list()).filter(
        (one) => one.role === "owner" && one.deactivatedAt === null
      ).length
    ).toBe(1);
  });

  test("that needs a password the owner's wrong ones hold back is refused as such, and changes nothing", async () => {
    const { storage } = await team();
    const heldBack = () => Promise.resolve("too_many_attempts" as const);
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "admin", password: "the password", role: "owner" },
        heldBack
      )
    ).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(
      await transferOwnership(
        storage,
        as("owner"),
        { id: "admin", password: "the password" },
        heldBack
      )
    ).toEqual({ ok: false, reason: "too_many_attempts" });
    expect((await storage.operatorAccounts.find("admin"))?.role).toBe("admin");
  });

  test("of an account that is gone is not found", async () => {
    const { storage } = await team();
    expect(
      await changeRole(
        storage,
        as("owner"),
        { id: "gone", role: "viewer" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("deactivating, reactivating and removing", () => {
  test("deactivating keeps the account and ends its sessions; reactivating lets it sign in again", async () => {
    const { storage } = await team();
    expect(
      await deactivate(
        storage,
        as("admin"),
        { id: "editor" },
        now,
        rightPassword
      )
    ).toEqual({
      ok: true,
    });
    expect((await storage.operatorAccounts.find("editor"))?.deactivatedAt).toBe(
      now
    );
    expect(await sessionsOf(storage, "editor")).toEqual([]);
    expect(await reactivate(storage, as("admin"), "editor")).toEqual({
      ok: true,
    });
    expect(
      (await storage.operatorAccounts.find("editor"))?.deactivatedAt
    ).toBeNull();
  });

  test("an admin may not touch an owner, and nobody their own account", async () => {
    const { storage } = await team();
    expect(
      await deactivate(
        storage,
        as("admin"),
        { id: "owner" },
        now,
        rightPassword
      )
    ).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await remove(storage, as("admin"), { id: "owner" }, rightPassword)
    ).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await deactivate(
        storage,
        as("owner"),
        { id: "owner" },
        now,
        rightPassword
      )
    ).toEqual({
      ok: false,
      reason: "self",
    });
    expect(
      await remove(storage, as("owner"), { id: "owner" }, rightPassword)
    ).toEqual({
      ok: false,
      reason: "self",
    });
    expect(
      await deactivate(
        storage,
        as("editor"),
        { id: "viewer" },
        now,
        rightPassword
      )
    ).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      (await storage.operatorAccounts.list()).filter(
        (one) => one.role === "owner" && one.deactivatedAt === null
      ).length
    ).toBe(1);
  });

  test("removing deletes the account for good and revokes the invitations it sent", async () => {
    const { storage } = await team();
    await invite(
      storage,
      key,
      io,
      as("admin"),
      { email: "new@example.com", role: "viewer" },
      now
    );
    await invite(
      storage,
      key,
      io,
      as("owner"),
      { email: "kept@example.com", role: "viewer" },
      now
    );
    expect(
      await remove(storage, as("owner"), { id: "admin" }, rightPassword)
    ).toEqual({ ok: true });
    expect(await storage.operatorAccounts.find("admin")).toBeUndefined();
    expect((await storage.invitations.list()).map((one) => one.email)).toEqual([
      "kept@example.com",
    ]);
    expect(
      await remove(storage, as("owner"), { id: "admin" }, rightPassword)
    ).toEqual({ ok: false, reason: "not_found" });
  });

  test("deactivating revokes the invitations the account sent", async () => {
    const { storage } = await team();
    await invite(
      storage,
      key,
      io,
      as("admin"),
      { email: "new@example.com", role: "admin" },
      now
    );
    expect(
      await deactivate(
        storage,
        as("owner"),
        { id: "admin" },
        now,
        rightPassword
      )
    ).toEqual({ ok: true });
    expect(await storage.invitations.list()).toEqual([]);
  });

  test("an owner removes or deactivates another owner after their own password, as taking the owner role asks", async () => {
    const { storage } = await team();
    await storage.operatorAccounts.setRole("admin", "owner");
    expect(
      await deactivate(
        storage,
        as("owner"),
        { id: "admin" },
        now,
        rightPassword
      )
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect(
      await remove(
        storage,
        as("owner"),
        { id: "admin", password: "a guess" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect((await storage.operatorAccounts.find("admin"))?.deactivatedAt).toBe(
      null
    );
    expect(
      await deactivate(
        storage,
        as("owner"),
        { id: "admin", password: "the password" },
        now,
        rightPassword
      )
    ).toEqual({ ok: true });
    expect(
      await remove(
        storage,
        as("owner"),
        { id: "admin", password: "the password" },
        rightPassword
      )
    ).toEqual({ ok: true });
  });

  test("an account that is not an owner's is deactivated and removed with no password", async () => {
    const { storage } = await team();
    const never = () => Promise.resolve("wrong" as const);
    expect(
      await deactivate(storage, as("owner"), { id: "editor" }, now, never)
    ).toEqual({ ok: true });
    expect(await remove(storage, as("owner"), { id: "editor" }, never)).toEqual(
      { ok: true }
    );
  });
});

describe("handing ownership on", () => {
  test("makes the account an owner and the owner an admin, after the owner's password, keeping the owner signed in", async () => {
    const { storage } = await team();
    expect(
      await transferOwnership(
        storage,
        as("owner"),
        { id: "editor", password: "a guess" },
        rightPassword
      )
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect(
      await transferOwnership(
        storage,
        as("owner"),
        { id: "editor", password: "the password" },
        rightPassword
      )
    ).toEqual({ ok: true });
    expect((await storage.operatorAccounts.find("editor"))?.role).toBe("owner");
    expect((await storage.operatorAccounts.find("owner"))?.role).toBe("admin");
    expect(await sessionsOf(storage, "owner")).toEqual(["s-owner"]);
  });

  test("is for an owner alone, to an account that is neither theirs, an owner's nor deactivated", async () => {
    const { storage } = await team();
    const to = (actor: Actor, id: string) =>
      transferOwnership(
        storage,
        actor,
        { id, password: "the password" },
        rightPassword
      );
    expect(await to(as("admin"), "editor")).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await to(as("owner"), "owner")).toEqual({
      ok: false,
      reason: "self",
    });
    await storage.operatorAccounts.deactivate("viewer", now);
    expect(await to(as("owner"), "viewer")).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    await storage.operatorAccounts.setRole("admin", "owner");
    expect(await to(as("owner"), "admin")).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await to(as("owner"), "gone")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("a database that cannot answer", () => {
  test("is unavailable, never a thrown error", async () => {
    const { storage } = await team();
    await storage.close();
    expect(
      await deactivate(
        storage,
        as("owner"),
        { id: "editor" },
        now,
        rightPassword
      )
    ).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(
      await invite(
        storage,
        key,
        io,
        as("owner"),
        { email: "new@example.com", role: "viewer" },
        now
      )
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await inviteAgain(storage, key, io, as("owner"), "an-invitation", now)
    ).toEqual({ ok: false, reason: "unavailable" });
    open = undefined;
  });
});

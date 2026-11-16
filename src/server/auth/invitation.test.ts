import { afterEach, describe, expect, test } from "bun:test";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { runSql } from "@/server/storage/fixture.ts";
import { type Auth, createAuth } from "./auth.ts";
import {
  call,
  cookiesOf,
  nextAddress,
  type Scratch,
  scratchStorage,
  setsSession,
  silentMail,
  testOrigin,
  testSecrets,
} from "./fixture.ts";
import {
  invitationGate,
  invitationLinkOf,
  invitationTokenHash,
  newInvitationToken,
  readInvitation,
} from "./invitation.ts";
import { readOperator } from "./session.ts";

// Accepting an invitation: the page's read of its link, and the endpoint
// that takes the invitation, creates the account and signs it in, over
// Better Auth's own handler on both backends.

let open: Scratch | undefined;
afterEach(async () => {
  await open?.cleanup();
  open = undefined;
});

const tokenShape = /^rqi_[A-Za-z0-9_-]{43}$/;
const hexHash = /^[0-9a-f]{64}$/;
const password = "a good long password";

/** A storage with its owner, an instance over it, and an invitation to new@example.com as an editor whose link is answered. */
async function invited(
  over: { expiresAt?: number; email?: string } = {}
): Promise<{ auth: Auth; scratch: Scratch; token: string }> {
  const scratch = await scratchStorage();
  open = scratch;
  const auth = createAuth({
    baseURL: testOrigin,
    database: scratch.storage.authDatabase,
    invitations: invitationGate(scratch.storage),
    log: () => undefined,
    mail: silentMail,
    secrets: testSecrets,
  });
  await auth.api.signUpEmail({
    body: { email: "owner@example.com", name: "", password },
  });
  const token = newInvitationToken();
  // The owner sent it: an invitation is open while its sender may still give its role.
  const sender =
    await scratch.storage.operatorAccounts.findByEmail("owner@example.com");
  await scratch.storage.invitations.put({
    createdAt: Date.now(),
    email: over.email ?? "new@example.com",
    expiresAt: over.expiresAt ?? Date.now() + 60_000,
    id: "i1",
    invitedBy: sender?.id ?? null,
    role: "editor",
    tokenHash: invitationTokenHash(token),
  });
  return { auth, scratch, token };
}

function accept(
  auth: Auth,
  body: unknown,
  options: { address?: string } = {}
): Promise<Response> {
  return call(auth, "/invitation/accept", {
    address: options.address ?? nextAddress(),
    body,
  });
}

describe("an invitation's link", () => {
  test("is the public address, the invitation page and a fresh token a secret scanner can name", () => {
    const token = newInvitationToken();
    expect(token).toMatch(tokenShape);
    expect(newInvitationToken()).not.toBe(token);
    expect(invitationLinkOf("https://status.example.com", token)).toBe(
      `https://status.example.com/invitation?token=${token}`
    );
  });

  test("is kept as the SHA-256 of its token alone", () => {
    expect(invitationTokenHash("rqi_x")).toMatch(hexHash);
    expect(invitationTokenHash("rqi_x")).toBe(invitationTokenHash("rqi_x"));
    expect(invitationTokenHash("rqi_y")).not.toBe(invitationTokenHash("rqi_x"));
  });
});

describe("the invitation page's read", () => {
  test("shows the address and role an open link offers, and closed for every other", async () => {
    const { scratch, token } = await invited();
    expect(await readInvitation(scratch.storage, token, Date.now())).toEqual({
      email: "new@example.com",
      ok: true,
      role: "editor",
    });
    expect(
      await readInvitation(scratch.storage, `${token}x`, Date.now())
    ).toEqual({ ok: false, reason: "closed" });
    expect(
      await readInvitation(scratch.storage, token, Date.now() + 120_000)
    ).toEqual({ ok: false, reason: "closed" });
    expect(await readInvitation(undefined, token, Date.now())).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  test("a database that cannot answer reads as closed, never a thrown error", async () => {
    const { scratch, token } = await invited();
    await scratch.storage.close();
    expect(await readInvitation(scratch.storage, token, Date.now())).toEqual({
      ok: false,
      reason: "closed",
    });
  });
});

describe("accepting an invitation", () => {
  test("creates the account with the invitation's address and role and the name given, and signs it in", async () => {
    const { auth, scratch, token } = await invited();
    const answer = await accept(auth, { name: "Huda", password, token });
    expect(answer.status).toBe(200);
    expect(setsSession(answer)).toBe(true);
    const account =
      await scratch.storage.operatorAccounts.findByEmail("new@example.com");
    expect(account).toMatchObject({ name: "Huda", role: "editor" });
    expect(await scratch.storage.invitations.list()).toEqual([]);
    const session = await readOperator(
      auth,
      new Headers({ cookie: cookiesOf(answer) })
    );
    expect(session?.operator).toMatchObject({
      email: "new@example.com",
      role: "editor",
    });
    const signedIn = await call(auth, "/sign-in/email", {
      body: { email: "new@example.com", password },
    });
    expect(signedIn.status).toBe(200);
  });

  test("works once: the second time the link is closed", async () => {
    const { auth, token } = await invited();
    expect((await accept(auth, { name: "Huda", password, token })).status).toBe(
      200
    );
    const again = await accept(auth, { name: "Other", password, token });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "INVITATION_CLOSED" });
  });

  test("an expired link, or one that never was, is closed and creates nothing", async () => {
    const { auth, scratch, token } = await invited({
      expiresAt: Date.now() - 1,
    });
    const expired = await accept(auth, { name: "Huda", password, token });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ code: "INVITATION_CLOSED" });
    const made = await accept(auth, {
      name: "Huda",
      password,
      token: newInvitationToken(),
    });
    expect(await made.json()).toMatchObject({ code: "INVITATION_CLOSED" });
    expect(await scratch.storage.operatorAccounts.list()).toHaveLength(1);
  });

  test("to an address that has an account by now refuses, and keeps the invitation", async () => {
    const { auth, scratch, token } = await invited({
      email: "OWNER@example.com",
    });
    const refused = await accept(auth, { name: "Huda", password, token });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "ALREADY_MEMBER" });
    expect(await scratch.storage.invitations.list()).toHaveLength(1);
  });

  test("whose sender is deactivated, gone or can no longer give its role is closed, on the page, at the endpoint and to single sign-on, and creates nothing", async () => {
    for (const change of [
      "UPDATE auth_user SET deactivated_at = 1 WHERE email = 'owner@example.com'",
      "UPDATE auth_user SET role = 'editor' WHERE email = 'owner@example.com'",
      "DELETE FROM auth_user WHERE email = 'owner@example.com'",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one install per way the sender stops vouching
      const { auth, scratch, token } = await invited();
      await runSql(scratch.location, change);
      expect(await readInvitation(scratch.storage, token, Date.now())).toEqual({
        ok: false,
        reason: "closed",
      });
      const refused = await accept(auth, { name: "Huda", password, token });
      expect(`${change}: ${(await refused.json()).code}`).toBe(
        `${change}: INVITATION_CLOSED`
      );
      expect(
        await scratch.storage.operatorAccounts.findByEmail("new@example.com")
      ).toBeUndefined();
      // Single sign-on finds an invitation by its address; the endpoint takes one again after its first check.
      const gate = invitationGate(scratch.storage);
      expect(
        `${change}: ${await gate.forEmail("new@example.com", Date.now())}`
      ).toBe(`${change}: undefined`);
      expect(`${change}: ${await gate.take(token, Date.now())}`).toBe(
        `${change}: undefined`
      );
      await scratch.cleanup();
      open = undefined;
    }
  });

  test("that loses a race with another account made for its address is told the address is a member by now", async () => {
    const { scratch, token } = await invited();
    const gate = invitationGate(scratch.storage);
    // The other account lands between the check and the take.
    const racing = createAuth({
      baseURL: testOrigin,
      database: scratch.storage.authDatabase,
      invitations: {
        ...gate,
        take: async (taken, now) => {
          const invitation = await gate.take(taken, now);
          await runSql(
            scratch.location,
            "INSERT INTO auth_user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('other', '', 'new@example.com', 0, 'viewer', 1, 1)"
          );
          return invitation;
        },
      },
      log: () => undefined,
      mail: silentMail,
      secrets: testSecrets,
    });
    const lost = await accept(racing, { name: "Huda", password, token });
    expect(lost.status).toBe(400);
    expect(await lost.json()).toMatchObject({ code: "ALREADY_MEMBER" });
    expect(setsSession(lost)).toBe(false);
  });

  test("a name left blank or a password outside the rule is refused before the link is spent", async () => {
    const { auth, scratch, token } = await invited();
    expect((await accept(auth, { name: " ", password, token })).status).toBe(
      400
    );
    expect(
      (await accept(auth, { name: "Huda", password: "short", token })).status
    ).toBe(400);
    expect(await scratch.storage.invitations.list()).toHaveLength(1);
  });

  test("is held to the sign-in's rate limit: the fourth attempt from one address in ten seconds is a 429", async () => {
    const { auth } = await invited();
    const address = nextAddress();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the limit counts attempts in order
      const answer = await accept(
        auth,
        { name: "Huda", password, token: newInvitationToken() },
        { address }
      );
      statuses.push(answer.status);
    }
    expect(statuses).toEqual([400, 400, 400, 429]);
  });

  test("from another origin is refused by the origin check and spends nothing", async () => {
    const { auth, scratch, token } = await invited();
    const answer = await auth.handler(
      new Request(`${testOrigin}/api/auth/invitation/accept`, {
        body: JSON.stringify({ name: "Huda", password, token }),
        headers: {
          "content-type": "application/json",
          origin: "https://elsewhere.example",
          [clientAddressHeader]: nextAddress(),
        },
        method: "POST",
      })
    );
    expect(answer.status).toBe(403);
    expect(await scratch.storage.invitations.list()).toHaveLength(1);
    expect(
      await runSql(scratch.location, "SELECT id FROM auth_user")
    ).toHaveLength(1);
  });
});

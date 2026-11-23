/**
 * The team page's module (CONTEXT.md "Operator account", "Role",
 * "Invitation", "Deactivated"): the accounts and invitations, inviting,
 * sending an invitation again and revoking it, changing a role,
 * deactivating, reactivating and removing an account, and making another
 * account an owner in one's place. The role rules are shared/domain/roles.ts;
 * this adds what needs the database: the signed-in operator acts with the
 * role their account has now, never touches their own account here (so the
 * last owner cannot leave the install without one; an owner hands ownership
 * on first), and gives or takes the owner role, or an owner's account, only
 * after their password. An account that loses a role, or is deactivated or
 * removed, takes with it the open invitations it could no longer send.
 * Changes run one at a time per storage, so two at once are judged one
 * after the other. Every function answers a result and never throws.
 */
import {
  invitationLinkOf,
  invitationTokenHash,
  newInvitationToken,
} from "@/server/auth/invitation.ts";
import { authEmailChannelOf, sendAuthMail } from "@/server/auth/mail.ts";
import { ssoRequired } from "@/server/auth/sso.ts";
import type { InstallKey } from "@/server/boot/installkey.ts";
import type { DeliverIo } from "@/server/notify/channel.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  assignableRoles,
  can,
  manages,
  type Role,
  roles,
} from "@/shared/domain/roles.ts";
import {
  type AccountActionInput,
  type Invitation,
  type InviteInput,
  type InviteResult,
  inviteSchema,
  type OperatorAccount,
  type OwnershipTransferInput,
  ownershipTransferSchema,
  type RoleChangeInput,
  roleChangeSchema,
  type TeamRefusal,
  type TeamResult,
  type TeamView,
} from "@/shared/schemas/team.ts";

export type TeamStorage = Pick<
  Storage,
  "channels" | "invitations" | "operatorAccounts" | "settings"
>;

/** The signed-in operator a change is made by. */
export interface Actor {
  readonly id: string;
  readonly role: Role;
}

/** Checks the signed-in operator's password, Better Auth's `verifyPassword` with the request's headers: right, wrong, or held back by too many wrong ones lately. */
export type PasswordCheck = (
  password: string
) => Promise<"right" | "wrong" | "too_many_attempts">;

/** How long an invitation's link works. */
export const invitationDays = 7;

/** At most this many invitations are sent, or sent again, in an hour. */
export const invitationsPerHour = 20;

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

// One change at a time per storage, keyed on its accounts repository.
const queues = new WeakMap<object, Promise<unknown>>();

function oneAtATime<T>(
  storage: TeamStorage,
  work: () => Promise<T>
): Promise<T> {
  const queued = (queues.get(storage.operatorAccounts) ?? Promise.resolve())
    .catch(() => undefined)
    .then(work);
  queues.set(storage.operatorAccounts, queued);
  return queued;
}

// When each invitation of the last hour went out, per storage.
const sends = new WeakMap<object, number[]>();

/** Counts a send toward the hour, or answers false when the hour is full. */
function spendSend(storage: TeamStorage, now: number): boolean {
  const recent = (sends.get(storage.invitations) ?? []).filter(
    (at) => at > now - hourMs
  );
  if (recent.length >= invitationsPerHour) {
    sends.set(storage.invitations, recent);
    return false;
  }
  sends.set(storage.invitations, [...recent, now]);
  return true;
}

/** The actor as their account is now: nothing when it is gone or deactivated. */
async function current(
  storage: TeamStorage,
  actor: Actor
): Promise<Actor | undefined> {
  const account = await storage.operatorAccounts.find(actor.id);
  return account && account.deactivatedAt === null
    ? { id: account.id, role: account.role }
    : undefined;
}

/** Lower roles come later in `roles`: a change to a later one takes power away. */
function lowers(from: Role, to: Role): boolean {
  return roles.indexOf(to) > roles.indexOf(from);
}

const refused = (reason: TeamRefusal): TeamResult => ({ ok: false, reason });

export async function readTeam(
  storage: TeamStorage,
  actor: Actor
): Promise<TeamView | undefined> {
  const now = await current(storage, actor);
  if (!(now && can(now.role, "team"))) {
    return;
  }
  const [accounts, invitations, channel] = await Promise.all([
    storage.operatorAccounts.list(),
    storage.invitations.list(),
    authEmailChannelOf(storage),
  ]);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return {
    invitable: assignableRoles(now.role),
    invitations: invitations.map((invitation) => {
      const sender = invitation.invitedBy
        ? byId.get(invitation.invitedBy)
        : undefined;
      return {
        ...invitation,
        invitedByName: sender && (sender.name || sender.email),
      };
    }),
    mail: channel !== undefined,
    members: accounts.map(({ preferences: _preferences, ...account }) => {
      const self = account.id === now.id;
      const manageable = !self && manages(now.role, account.role);
      return {
        account,
        assignable: manageable ? assignableRoles(now.role) : [],
        manageable,
        self,
      };
    }),
    ownership: can(now.role, "owners"),
  };
}

/** Makes the link, emails it when an email channel exists, and answers it either way. */
async function send(
  storage: TeamStorage,
  key: InstallKey,
  io: DeliverIo,
  email: string,
  token: string
): Promise<InviteResult> {
  const address = await readPublicAddress(storage);
  if (!address) {
    return { ok: false, reason: "no_address" };
  }
  const link = invitationLinkOf(address, token);
  const mailed = await sendAuthMail(storage, key, io, {
    kind: "invitation",
    to: email,
    value: link,
  });
  return { emailed: mailed.ok, link, ok: true };
}

/** Invites the address with the role, replacing an invitation it had; the link comes back to copy, and goes by email when an email channel exists. */
export function invite(
  storage: TeamStorage,
  key: InstallKey,
  io: DeliverIo,
  actor: Actor,
  input: InviteInput,
  now: number
): Promise<InviteResult> {
  return oneAtATime(storage, async () => {
    const parsed = inviteSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, reason: "invalid" };
    }
    const { role } = parsed.data;
    const email = parsed.data.email.toLowerCase();
    try {
      const by = await current(storage, actor);
      if (!(by && assignableRoles(by.role).includes(role))) {
        return { ok: false, reason: "not_allowed" };
      }
      if (await storage.operatorAccounts.findByEmail(email)) {
        return { ok: false, reason: "already_member" };
      }
      // Replacing an open invitation revokes it, so it takes what revoking it takes.
      const open = (await storage.invitations.list()).find(
        (invitation) => invitation.email === email
      );
      if (open && !assignableRoles(by.role).includes(open.role)) {
        return { ok: false, reason: "not_allowed" };
      }
      if (!(await readPublicAddress(storage))) {
        return { ok: false, reason: "no_address" };
      }
      if (!spendSend(storage, now)) {
        return { ok: false, reason: "too_many" };
      }
      const token = newInvitationToken();
      await storage.invitations.put({
        createdAt: now,
        email,
        expiresAt: now + invitationDays * dayMs,
        id: Bun.randomUUIDv7(),
        invitedBy: by.id,
        role,
        tokenHash: invitationTokenHash(token),
      });
      return await send(storage, key, io, email, token);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  });
}

/** The invitation, when the actor may give its role: an owner's is an owner's alone to touch. */
async function ownInvitation(
  storage: TeamStorage,
  actor: Actor,
  id: string
): Promise<
  | { readonly ok: true; readonly invitation: Invitation }
  | { readonly ok: false; readonly reason: "not_allowed" | "not_found" }
> {
  const by = await current(storage, actor);
  if (!(by && can(by.role, "team"))) {
    return { ok: false, reason: "not_allowed" };
  }
  const invitation = await storage.invitations.find(id);
  if (!invitation) {
    return { ok: false, reason: "not_found" };
  }
  return assignableRoles(by.role).includes(invitation.role)
    ? { invitation, ok: true }
    : { ok: false, reason: "not_allowed" };
}

/** A new link for the invitation, so the old one stops working, sent as `invite` sends one. */
export function inviteAgain(
  storage: TeamStorage,
  key: InstallKey,
  io: DeliverIo,
  actor: Actor,
  id: string,
  now: number
): Promise<InviteResult> {
  return oneAtATime(storage, async () => {
    try {
      const found = await ownInvitation(storage, actor, id);
      if (!found.ok) {
        return found;
      }
      if (!(await readPublicAddress(storage))) {
        return { ok: false, reason: "no_address" };
      }
      if (!spendSend(storage, now)) {
        return { ok: false, reason: "too_many" };
      }
      const token = newInvitationToken();
      const renewed = await storage.invitations.renew(
        id,
        invitationTokenHash(token),
        now,
        now + invitationDays * dayMs
      );
      if (!renewed) {
        return { ok: false, reason: "not_found" };
      }
      return await send(storage, key, io, found.invitation.email, token);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  });
}

export function revokeInvitation(
  storage: TeamStorage,
  actor: Actor,
  id: string
): Promise<TeamResult> {
  return oneAtATime(storage, async () => {
    try {
      const found = await ownInvitation(storage, actor, id);
      if (!found.ok) {
        return found;
      }
      return (await storage.invitations.revoke(id))
        ? { ok: true }
        : refused("not_found");
    } catch {
      return refused("unavailable");
    }
  });
}

/** The account the actor may change, as it is now, or why not. */
async function managed(
  storage: TeamStorage,
  actor: Actor,
  id: string
): Promise<
  | { readonly ok: true; readonly by: Actor; readonly account: OperatorAccount }
  | { readonly ok: false; readonly reason: TeamRefusal }
> {
  const by = await current(storage, actor);
  if (!(by && can(by.role, "team"))) {
    return { ok: false, reason: "not_allowed" };
  }
  const account = await storage.operatorAccounts.find(id);
  if (!account) {
    return { ok: false, reason: "not_found" };
  }
  if (account.id === by.id) {
    return { ok: false, reason: "self" };
  }
  return manages(by.role, account.role)
    ? { account, by, ok: true }
    : { ok: false, reason: "not_allowed" };
}

/** Runs a change of one managed account, one at a time, never throwing. */
function change(
  storage: TeamStorage,
  actor: Actor,
  id: string,
  work: (found: {
    readonly by: Actor;
    readonly account: OperatorAccount;
  }) => Promise<TeamResult>
): Promise<TeamResult> {
  return oneAtATime(storage, async () => {
    try {
      const found = await managed(storage, actor, id);
      return found.ok ? await work(found) : found;
    } catch {
      return refused("unavailable");
    }
  });
}

/** Why the password given does not prove the actor, or nothing when it does; none given is a wrong one. */
async function disproven(
  password: string | undefined,
  check: PasswordCheck
): Promise<"wrong_password" | "too_many_attempts" | undefined> {
  if (password === undefined || password === "") {
    return "wrong_password";
  }
  const verdict = await check(password);
  if (verdict === "right") {
    return;
  }
  return verdict === "wrong" ? "wrong_password" : "too_many_attempts";
}

/** Gives the account a role; a lower one ends its sessions, so it signs in again under it. */
export function changeRole(
  storage: TeamStorage,
  actor: Actor,
  input: RoleChangeInput,
  checkPassword: PasswordCheck
): Promise<TeamResult> {
  const parsed = roleChangeSchema.safeParse(input);
  if (!parsed.success) {
    return Promise.resolve(refused("not_allowed"));
  }
  const { id, password, role } = parsed.data;
  return change(storage, actor, id, async ({ account, by }) => {
    if (!assignableRoles(by.role).includes(role)) {
      return refused("not_allowed");
    }
    const ownership = role === "owner" || account.role === "owner";
    const unproven = ownership
      ? await disproven(password, checkPassword)
      : undefined;
    if (unproven) {
      return refused(unproven);
    }
    await storage.operatorAccounts.setRole(account.id, role);
    if (lowers(account.role, role)) {
      await storage.operatorAccounts.endSessions(account.id);
      await revokeSentBeyond(storage, account.id, role);
    }
    return { ok: true };
  });
}

/** Revokes the open invitations the account sent that its role, now `role` or none, could no longer send. */
async function revokeSentBeyond(
  storage: TeamStorage,
  sender: string,
  role: Role | undefined
): Promise<void> {
  const allowed = role ? assignableRoles(role) : [];
  const beyond = (await storage.invitations.list()).filter(
    (invitation) =>
      invitation.invitedBy === sender && !allowed.includes(invitation.role)
  );
  for (const invitation of beyond) {
    // biome-ignore lint/performance/noAwaitInLoops: a sender's few invitations, one at a time
    await storage.invitations.revoke(invitation.id);
  }
}

/** Takes the account away, after the password when it is an owner's, and revokes the invitations it sent. */
function takeAway(
  storage: TeamStorage,
  actor: Actor,
  input: AccountActionInput,
  checkPassword: PasswordCheck,
  work: (id: string) => Promise<boolean>
): Promise<TeamResult> {
  return change(storage, actor, input.id, async ({ account }) => {
    const unproven =
      account.role === "owner"
        ? await disproven(input.password, checkPassword)
        : undefined;
    if (unproven) {
      return refused(unproven);
    }
    // Revoked first: a removed sender's invitations would lose the sender that names them.
    await revokeSentBeyond(storage, account.id, undefined);
    return (await work(account.id)) ? { ok: true } : refused("not_found");
  });
}

/** Deactivates the account, after the password when it is an owner's, and revokes the invitations it sent. */
export function deactivate(
  storage: TeamStorage,
  actor: Actor,
  input: AccountActionInput,
  now: number,
  checkPassword: PasswordCheck
): Promise<TeamResult> {
  return takeAway(storage, actor, input, checkPassword, (id) =>
    storage.operatorAccounts.deactivate(id, now)
  );
}

export function reactivate(
  storage: TeamStorage,
  actor: Actor,
  id: string
): Promise<TeamResult> {
  return change(storage, actor, id, async ({ account }) =>
    (await storage.operatorAccounts.reactivate(account.id))
      ? { ok: true }
      : refused("not_found")
  );
}

/** Removes the account for good, after the password when it is an owner's, and revokes the invitations it sent. */
export function remove(
  storage: TeamStorage,
  actor: Actor,
  input: AccountActionInput,
  checkPassword: PasswordCheck
): Promise<TeamResult> {
  return takeAway(storage, actor, input, checkPassword, (id) =>
    storage.operatorAccounts.remove(id)
  );
}

/** Makes the account an owner and the signed-in owner an admin, after their password; the owner stays signed in, unless single sign-on is required and they signed in with a password. */
export function transferOwnership(
  storage: TeamStorage,
  actor: Actor,
  input: OwnershipTransferInput,
  checkPassword: PasswordCheck
): Promise<TeamResult> {
  const parsed = ownershipTransferSchema.safeParse(input);
  if (!parsed.success) {
    return Promise.resolve(refused("wrong_password"));
  }
  const { id, password } = parsed.data;
  return oneAtATime(storage, async () => {
    try {
      const by = await current(storage, actor);
      if (!(by && can(by.role, "owners"))) {
        return refused("not_allowed");
      }
      const account = await storage.operatorAccounts.find(id);
      if (!account) {
        return refused("not_found");
      }
      if (account.id === by.id) {
        return refused("self");
      }
      if (account.role === "owner" || account.deactivatedAt !== null) {
        return refused("not_allowed");
      }
      const unproven = await disproven(password, checkPassword);
      if (unproven) {
        return refused(unproven);
      }
      const required = await ssoRequired(storage);
      // The new owner first, so the install never has none.
      await storage.operatorAccounts.setRole(account.id, "owner");
      await storage.operatorAccounts.setRole(by.id, "admin");
      await revokeSentBeyond(storage, by.id, "admin");
      if (required) {
        // Now an admin, under a rule that leaves no non-owner a password session.
        await storage.operatorAccounts.endPasswordSessions();
      }
      return { ok: true };
    } catch {
      return refused("unavailable");
    }
  });
}

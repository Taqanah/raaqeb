/**
 * The team page's shapes (CONTEXT.md "Operator account", "Role",
 * "Invitation", "Deactivated"): the accounts and invitations it lists, what
 * it posts, and the refusals it words through the catalog (ADR-0004).
 */
import { z } from "zod";
import { type Role, roles } from "@/shared/domain/roles.ts";
import { passwordMaxLength, passwordMinLength } from "./auth.ts";
import type { AccountSettingsInput } from "./settings.ts";

export const roleSchema = z.enum(roles);

/** An operator account's name: optional for the first one, which onboarding makes without one. */
export const accountNameSchema = z.string().trim().max(100);

/** One operator account as storage holds it, without its credentials. */
export interface OperatorAccount {
  /** An authenticator app is in force: its first code was entered. */
  readonly app: boolean;
  readonly createdAt: number;
  readonly deactivatedAt: number | null;
  readonly email: string;
  readonly id: string;
  readonly lastSignInAt: number | null;
  /** Empty when the operator gave none; the email stands for it. */
  readonly name: string;
  readonly preferences: AccountSettingsInput;
  readonly role: Role;
  /** The second step is on for this account. */
  readonly secondStep: boolean;
}

/** One invitation, without its link: only the token's hash is kept. */
export interface Invitation {
  readonly createdAt: number;
  readonly email: string;
  readonly expiresAt: number;
  readonly id: string;
  /** The account that sent it, while it exists. */
  readonly invitedBy: string | null;
  readonly role: Role;
}

/** One signed-in browser of an account. */
export interface AccountSession {
  readonly createdAt: number;
  /** The request that is reading this list came from it. */
  readonly current: boolean;
  readonly expiresAt: number;
  readonly id: string;
  readonly ipAddress: string | null;
  /** Its last refresh, at most a day behind its use. */
  readonly updatedAt: number;
  readonly userAgent: string | null;
}

/** One row of the team page: an account, with what the signed-in operator may do to it. */
export interface TeamMember {
  readonly account: Omit<OperatorAccount, "preferences">;
  /** The roles the signed-in operator may give it; empty when they may not change it. */
  readonly assignable: readonly Role[];
  /** The signed-in operator may deactivate, reactivate and remove it. */
  readonly manageable: boolean;
  /** It is the signed-in operator's own. */
  readonly self: boolean;
}

/** What the team page shows. */
export interface TeamView {
  /** The roles the signed-in operator may invite as. */
  readonly invitable: readonly Role[];
  readonly invitations: readonly (Invitation & {
    /** The inviting account's name, else its email; nothing once it is removed. */
    readonly invitedByName: string | undefined;
  })[];
  /** An email channel exists, so an invitation is emailed as well as shown. */
  readonly mail: boolean;
  readonly members: readonly TeamMember[];
  /** The signed-in operator may make another account an owner, in place of themselves or beside them. */
  readonly ownership: boolean;
}

export const inviteSchema = z.object({
  email: z.email().max(254),
  role: roleSchema,
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const invitationIdSchema = z.object({ id: z.string().min(1) });
export const accountIdSchema = z.object({ id: z.string().min(1) });

/** Deactivating or removing an account; one that is an owner's asks for the signed-in operator's password, as taking the owner role does. */
export const accountActionSchema = z.object({
  id: z.string().min(1),
  password: z.string().max(passwordMaxLength).optional(),
});
export type AccountActionInput = z.infer<typeof accountActionSchema>;

/** A change of an account's role; giving or taking the owner role asks for the signed-in operator's password. */
export const roleChangeSchema = z.object({
  id: z.string().min(1),
  password: z.string().max(passwordMaxLength).optional(),
  role: roleSchema,
});
export type RoleChangeInput = z.infer<typeof roleChangeSchema>;

/** Making another account the owner in place of the signed-in one, after the signed-in operator's password. */
export const ownershipTransferSchema = z.object({
  id: z.string().min(1),
  password: z.string().min(1).max(passwordMaxLength),
});
export type OwnershipTransferInput = z.infer<typeof ownershipTransferSchema>;

/** An invitation sent or sent again: its link, shown once for copying, and whether it was emailed too. */
export type InviteResult =
  | {
      readonly ok: true;
      readonly emailed: boolean;
      readonly link: string;
    }
  | {
      readonly ok: false;
      readonly reason: InviteRefusal;
    };

/**
 * Why an invitation was not sent: the input did not parse; the address has an account already; the
 * role is not one the signed-in operator may give; too many invitations went
 * out lately; no public address is stored for the link; it was revoked or
 * accepted meanwhile; or the server did not answer.
 */
export type InviteRefusal =
  | "invalid"
  | "already_member"
  | "not_allowed"
  | "too_many"
  | "no_address"
  | "not_found"
  | "unavailable";

/**
 * Why a change to an account was refused: the signed-in operator may not
 * make it; it is their own account, which keeps an owner from leaving the
 * install without one (an owner hands ownership on first); the password was
 * wrong; the account is gone; or the server did not answer.
 */
export type TeamRefusal =
  | "not_allowed"
  | "self"
  | "wrong_password"
  | "too_many_attempts"
  | "not_found"
  | "unavailable";

export type TeamResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TeamRefusal };

/** What the invitation page shows for its link: the address and role it offers, or that it is closed (used, revoked, expired or never one). */
export type InvitationView =
  | { readonly ok: true; readonly email: string; readonly role: Role }
  | { readonly ok: false; readonly reason: "closed" };

/** What the invitation page posts to accept: the token, the name and the new password. */
export const invitationAcceptSchema = z.object({
  name: accountNameSchema.pipe(z.string().min(1)),
  password: z.string().min(passwordMinLength).max(passwordMaxLength),
  token: z.string().min(1).max(200),
});
export type InvitationAcceptInput = z.infer<typeof invitationAcceptSchema>;

/** Why accepting did not sign in: the link is closed, the address has an account already, too many calls, or the server did not answer. */
export type InvitationAcceptFailure =
  | "closed"
  | "already_member"
  | "rate_limited"
  | "unavailable";

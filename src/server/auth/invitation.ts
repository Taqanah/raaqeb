/**
 * Accepting an invitation (CONTEXT.md "Invitation"): the invitation page
 * reads what its link offers, and the browser posts the name and the new
 * password to `/api/auth/invitation/accept`, an endpoint of Raaqeb's own
 * inside Better Auth's router, so its rate limit and origin check apply as
 * they do to sign-in. The endpoint takes the invitation, which deletes it,
 * creates the account with the invitation's role and signs it in.
 */
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  formCsrfMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Storage } from "@/server/storage/storage.ts";
import { assignableRoles, type Role } from "@/shared/domain/roles.ts";
import {
  type Invitation,
  type InvitationView,
  invitationAcceptSchema,
} from "@/shared/schemas/team.ts";
import { ssoRequiredCode } from "./sso.ts";

/** The invitations a Better Auth instance reads, by the link's token in clear. */
export interface InvitationGate {
  /** The address's invitation while it is open. */
  readonly forEmail: (
    email: string,
    now: number
  ) => Promise<Invitation | undefined>;
  /** Forgets the address's invitation, for an account made another way for it. */
  readonly forget: (email: string) => Promise<void>;
  /** What the link offers while it is open. */
  readonly open: (
    token: string,
    now: number
  ) => Promise<Invitation | undefined>;
  /** Takes the open invitation, so the link works once. */
  readonly take: (
    token: string,
    now: number
  ) => Promise<Invitation | undefined>;
}

/** No invitation is open: the gate of an instance that serves none. */
export const closedGate: InvitationGate = {
  forEmail: () => Promise.resolve(undefined),
  forget: () => Promise.resolve(),
  open: () => Promise.resolve(undefined),
  take: () => Promise.resolve(undefined),
};

/** The invitation page; its link carries the token. */
export const invitationPagePath = "/invitation";

/** The link an invitation is sent as: the public address, the page and the token. */
export function invitationLinkOf(publicAddress: string, token: string): string {
  return `${publicAddress}${invitationPagePath}?token=${encodeURIComponent(token)}`;
}

/** A fresh token: 32 random bytes in base64url behind a prefix a secret scanner can name. */
export function newInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `rqi_${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

/** The SHA-256 of a token, in hex: all the invitations table keeps of it. A token of 256 random bits needs no slow hash. */
export function invitationTokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** Whether the invitation's sender still vouches for it: their account is there, active, and may still give its role. */
async function vouched(
  storage: Pick<Storage, "operatorAccounts">,
  invitation: Invitation
): Promise<boolean> {
  const sender =
    invitation.invitedBy === null
      ? undefined
      : await storage.operatorAccounts.find(invitation.invitedBy);
  return (
    sender !== undefined &&
    sender.deactivatedAt === null &&
    assignableRoles(sender.role).includes(invitation.role)
  );
}

/** The gate over the storage's invitations; one its sender no longer vouches for is closed. */
export function invitationGate(
  storage: Pick<Storage, "invitations" | "operatorAccounts">
): InvitationGate {
  return {
    forEmail: async (email, now) => {
      const offered = await storage.invitations.openFor(email, now);
      return offered && (await vouched(storage, offered)) ? offered : undefined;
    },
    forget: (email) => storage.invitations.forget(email),
    open: async (token, now) => {
      const offered = await storage.invitations.open(
        invitationTokenHash(token),
        now
      );
      return offered && (await vouched(storage, offered)) ? offered : undefined;
    },
    take: async (token, now) => {
      const offered = await storage.invitations.open(
        invitationTokenHash(token),
        now
      );
      if (!(offered && (await vouched(storage, offered)))) {
        return;
      }
      return await storage.invitations.take(invitationTokenHash(token), now);
    },
  };
}

/** What the invitation page shows for a token: the address and role, or that the link is closed. Never throws; a database that cannot answer reads as closed. */
export async function readInvitation(
  storage: Pick<Storage, "invitations" | "operatorAccounts"> | undefined,
  token: string,
  now: number
): Promise<InvitationView> {
  const closed: InvitationView = { ok: false, reason: "closed" };
  if (!storage || token === "") {
    return closed;
  }
  try {
    const offered = await invitationGate(storage).open(token, now);
    return offered
      ? { email: offered.email, ok: true, role: offered.role }
      : closed;
  } catch {
    return closed;
  }
}

function closedLink(): APIError {
  return new APIError("BAD_REQUEST", {
    code: "INVITATION_CLOSED",
    message: "the invitation is used, revoked, expired or never was one",
  });
}

function alreadyMember(): APIError {
  return new APIError("BAD_REQUEST", {
    code: "ALREADY_MEMBER",
    message: "the invitation's address has an account already",
  });
}

/** The endpoint that accepts an invitation, as a Better Auth plugin; `passwordRefused` names the roles single sign-on keeps from setting a password. */
export function invitationAccept(
  gate: InvitationGate,
  passwordRefused: (role: Role) => boolean = () => false
) {
  return {
    endpoints: {
      acceptInvitation: createAuthEndpoint(
        "/invitation/accept",
        {
          body: invitationAcceptSchema,
          method: "POST",
          // Sign-in's own check: an Origin or a fetch from another site is refused before anything is read.
          use: [formCsrfMiddleware],
        },
        async (ctx) => {
          const { name, password, token } = ctx.body;
          const offered = await gate.open(token, Date.now());
          if (!offered) {
            throw closedLink();
          }
          // Refused before the link is spent, so the invitation stays open for the provider.
          if (passwordRefused(offered.role)) {
            throw new APIError("FORBIDDEN", {
              code: ssoRequiredCode,
              message: "the invitation is accepted through single sign-on",
            });
          }
          // Checked before the link is spent, so an address that has an account by now keeps its invitation for the team page to revoke.
          if (
            await ctx.context.internalAdapter.findUserByEmail(offered.email)
          ) {
            throw alreadyMember();
          }
          // The hash before the take, so a failing hash spends nothing.
          const hash = await ctx.context.password.hash(password);
          const taken = await gate.take(token, Date.now());
          if (!taken) {
            throw closedLink();
          }
          // Another account made for the address since the check wins; the address's unique index settles two at once.
          const exists = () =>
            ctx.context.internalAdapter.findUserByEmail(taken.email);
          if (await exists()) {
            throw alreadyMember();
          }
          const user = await ctx.context.internalAdapter
            .createUser(
              {
                email: taken.email,
                emailVerified: false,
                name,
                role: taken.role,
              },
              { method: "email-password" }
            )
            .catch(async (error: unknown) => {
              throw (await exists()) ? alreadyMember() : error;
            });
          await ctx.context.internalAdapter.linkAccount({
            accountId: user.id,
            password: hash,
            providerId: "credential",
            userId: user.id,
          });
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            false
          );
          // It also makes the session the request's new one, so the after hooks record the sign-in.
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true });
        }
      ),
    },
    id: "raaqeb-invitation",
  } satisfies BetterAuthPlugin;
}

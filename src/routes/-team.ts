/**
 * The team page's server functions: the accounts and invitations, inviting
 * and sending again, revoking, changing a role, deactivating, reactivating,
 * removing, and handing ownership on, each behind its permission. A change
 * that gives or takes the owner role checks the signed-in operator's
 * password through Better Auth with the request's headers. Not a route file
 * (the leading dash).
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { isAPIError } from "better-auth/api";
import { type Auth, tooManyPasswordsCode } from "@/server/auth/auth.ts";
import { smtpTimeoutMs } from "@/server/notify/channel.ts";
import {
  changeRole,
  deactivate,
  invite,
  inviteAgain,
  type PasswordCheck,
  reactivate,
  readTeam,
  remove,
  revokeInvitation,
  transferOwnership,
} from "@/server/team/team.ts";
import {
  accountActionSchema,
  accountIdSchema,
  type InviteResult,
  invitationIdSchema,
  inviteSchema,
  ownershipTransferSchema,
  roleChangeSchema,
  type TeamResult,
  type TeamView,
} from "@/shared/schemas/team.ts";
import { permitted } from "./-admin.ts";

/** The signed-in operator's password, checked as the account page checks it; one Better Auth refuses to read is a wrong one. */
function passwordOf(auth: Auth): PasswordCheck {
  const headers = new Headers(getRequestHeaders());
  return (password) =>
    auth.api.verifyPassword({ body: { password }, headers }).then(
      () => "right" as const,
      (error: unknown) =>
        isAPIError(error) && error.body?.code === tooManyPasswordsCode
          ? ("too_many_attempts" as const)
          : ("wrong" as const)
    );
}

const mailIo = { fetch, now: Date.now };

/** A send waits on the network for up to an SMTP attempt, past Bun's ten idle seconds. */
const sendHoldSeconds = smtpTimeoutMs / 1000 + 10;

export const readTeamFn = createServerFn({ method: "GET" })
  .middleware([permitted("team")])
  .handler(
    async ({ context }): Promise<TeamView | undefined> =>
      await readTeam(context.storage, context.operator).catch(() => undefined)
  );

export const inviteFn = createServerFn({ method: "POST" })
  .middleware([permitted("team")])
  .validator(inviteSchema)
  .handler(({ context, data }): Promise<InviteResult> => {
    context.holdOpen(sendHoldSeconds);
    return invite(
      context.storage,
      context.boot.installKey,
      mailIo,
      context.operator,
      data,
      Date.now()
    );
  });

export const inviteAgainFn = createServerFn({ method: "POST" })
  .middleware([permitted("team")])
  .validator(invitationIdSchema)
  .handler(({ context, data }): Promise<InviteResult> => {
    context.holdOpen(sendHoldSeconds);
    return inviteAgain(
      context.storage,
      context.boot.installKey,
      mailIo,
      context.operator,
      data.id,
      Date.now()
    );
  });

export const revokeInvitationFn = createServerFn({ method: "POST" })
  .middleware([permitted("team")])
  .validator(invitationIdSchema)
  .handler(
    ({ context, data }): Promise<TeamResult> =>
      revokeInvitation(context.storage, context.operator, data.id)
  );

export const changeRoleFn = createServerFn({ method: "POST" })
  .middleware([permitted("team")])
  .validator(roleChangeSchema)
  .handler(
    ({ context, data }): Promise<TeamResult> =>
      changeRole(
        context.storage,
        context.operator,
        data,
        passwordOf(context.auth)
      )
  );

export const deactivateFn = createServerFn({ method: "POST" })
  .middleware([permitted("team")])
  .validator(accountActionSchema)
  .handler(
    ({ context, data }): Promise<TeamResult> =>
      deactivate(
        context.storage,
        context.operator,
        data,
        Date.now(),
        passwordOf(context.auth)
      )
  );

export const reactivateFn = createServerFn({ method: "POST" })
  .middleware([permitted("team")])
  .validator(accountIdSchema)
  .handler(
    ({ context, data }): Promise<TeamResult> =>
      reactivate(context.storage, context.operator, data.id)
  );

export const removeFn = createServerFn({ method: "POST" })
  .middleware([permitted("team")])
  .validator(accountActionSchema)
  .handler(
    ({ context, data }): Promise<TeamResult> =>
      remove(context.storage, context.operator, data, passwordOf(context.auth))
  );

export const transferOwnershipFn = createServerFn({ method: "POST" })
  .middleware([permitted("owners")])
  .validator(ownershipTransferSchema)
  .handler(
    ({ context, data }): Promise<TeamResult> =>
      transferOwnership(
        context.storage,
        context.operator,
        data,
        passwordOf(context.auth)
      )
  );

/**
 * The operator account's own changes: the email and the password, each
 * after the current password, so a session alone cannot move the account,
 * through Better Auth on the server with the request's headers, never over
 * its HTTP routes, which stay disabled. Both answer the cookies Better Auth
 * re-issues, which the route sets on the response, and the page reloads to
 * adopt them. Every function answers a result and never throws.
 */
import { isAPIError } from "better-auth/api";
import type { Storage } from "@/server/storage/storage.ts";
import {
  type EmailChangeInput,
  type EmailChangeRefusal,
  type NameChangeInput,
  nameChangeSchema,
  type PasswordChangeInput,
  type PasswordChangeRefusal,
  type SaveResult,
  type SessionEndInput,
  type SessionsResult,
  sessionEndSchema,
} from "@/shared/schemas/settings.ts";
import { type Auth, tooManyPasswordsCode } from "./auth.ts";
import type { Operator } from "./session.ts";

export type EmailChangeResult =
  | { readonly ok: true; readonly setCookies: readonly string[] }
  | { readonly ok: false; readonly reason: EmailChangeRefusal };

export type PasswordChangeResult =
  | { readonly ok: true; readonly setCookies: readonly string[] }
  | { readonly ok: false; readonly reason: PasswordChangeRefusal };

/** Tells the address the account had that it changed, and to which; never throws, a failed send is the notice's to log. */
export type EmailChangeNotice = (
  previous: string,
  next: string
) => Promise<void>;

/** Changes the signed-in operator's email after verifying the current password, and tells the old address; the new address is unverified until its next one-time code. */
export async function changeOperatorEmail(
  auth: Auth,
  headers: Headers,
  input: EmailChangeInput,
  notice: EmailChangeNotice
): Promise<EmailChangeResult> {
  const { currentPassword, email } = input;
  try {
    await auth.api.verifyPassword({
      body: { password: currentPassword },
      headers,
    });
    const session = await auth.api.getSession({ headers });
    const context = await auth.$context;
    const next = email.toLowerCase();
    // An address another account has changes nothing and tells nobody, and answers as a change does, as Better Auth's own endpoint answers (update-user.mjs).
    if (
      session &&
      next !== session.user.email &&
      (await context.internalAdapter.findUserByEmail(next))
    ) {
      return { ok: true, setCookies: [] };
    }
    // Better Auth changes a verified address only through a verification
    // email Raaqeb does not send; a new address is unverified anyway, until
    // its next one-time code.
    if (session?.user.emailVerified && next !== session.user.email) {
      await context.internalAdapter.updateUser(session.user.id, {
        emailVerified: false,
      });
    }
    const changed = await auth.api.changeEmail({
      body: { newEmail: email },
      headers,
      returnHeaders: true,
    });
    if (session) {
      await notice(session.user.email, email.toLowerCase());
    }
    return { ok: true, setCookies: changed.headers.getSetCookie() };
  } catch (error) {
    if (isAPIError(error) && error.body?.code === "INVALID_PASSWORD") {
      return { ok: false, reason: "wrong_password" };
    }
    if (isAPIError(error) && error.body?.code === tooManyPasswordsCode) {
      return { ok: false, reason: "too_many_attempts" };
    }
    // Better Auth words the same-address refusal only in its message (update-user.mjs).
    if (isAPIError(error) && error.message === "Email is the same") {
      return { ok: false, reason: "same_email" };
    }
    return { ok: false, reason: "unavailable" };
  }
}

/** The signed-in operator's own name; empty lets the email stand for it. */
export async function renameOperator(
  storage: Pick<Storage, "operatorAccounts">,
  accountId: string,
  input: NameChangeInput
): Promise<SaveResult> {
  const parsed = nameChangeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  try {
    return (await storage.operatorAccounts.rename(accountId, parsed.data.name))
      ? { ok: true }
      : { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** The signed-in operator's live sessions, the one reading them marked. */
export async function readOwnSessions(
  storage: Pick<Storage, "operatorAccounts">,
  operator: Pick<Operator, "id" | "sessionId">,
  now: number
): Promise<SessionsResult> {
  try {
    return {
      ok: true,
      sessions: await storage.operatorAccounts.sessions(
        operator.id,
        now,
        operator.sessionId
      ),
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Ends one of the signed-in operator's sessions, or every one but the one asking when no id is given; never the one asking, which signing out ends. */
export async function endOwnSessions(
  storage: Pick<Storage, "operatorAccounts">,
  operator: Pick<Operator, "id" | "sessionId">,
  input: SessionEndInput
): Promise<SaveResult> {
  const parsed = sessionEndSchema.safeParse(input);
  if (!parsed.success || parsed.data.id === operator.sessionId) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const { id } = parsed.data;
    if (id !== undefined) {
      // Another account's session id ends nothing: the repository matches it to this account.
      return (await storage.operatorAccounts.endSession(operator.id, id))
        ? { ok: true }
        : { ok: false, reason: "invalid" };
    }
    const sessions = await storage.operatorAccounts.sessions(
      operator.id,
      0,
      operator.sessionId
    );
    for (const session of sessions.filter((one) => !one.current)) {
      // biome-ignore lint/performance/noAwaitInLoops: an account has a handful of sessions
      await storage.operatorAccounts.endSession(operator.id, session.id);
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Changes the password after verifying the current one; every other session ends. */
export async function changeOperatorPassword(
  auth: Auth,
  headers: Headers,
  input: PasswordChangeInput
): Promise<PasswordChangeResult> {
  try {
    // The instance's before hook forces revokeOtherSessions on this path (server/auth/auth.ts), so the caller cannot opt out.
    const changed = await auth.api.changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      },
      headers,
      returnHeaders: true,
    });
    return { ok: true, setCookies: changed.headers.getSetCookie() };
  } catch (error) {
    if (isAPIError(error) && error.body?.code === "INVALID_PASSWORD") {
      return { ok: false, reason: "wrong_password" };
    }
    if (isAPIError(error) && error.body?.code === tooManyPasswordsCode) {
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason: "unavailable" };
  }
}

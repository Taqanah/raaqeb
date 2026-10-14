/**
 * The operator account's own changes: the email and the password, each
 * after the current password, so a session alone cannot move the account,
 * through Better Auth on the server with the request's headers, never over
 * its HTTP routes, which stay disabled. Both answer the cookies Better Auth
 * re-issues, which the route sets on the response, and the page reloads to
 * adopt them. Every function answers a result and never throws.
 */
import { isAPIError } from "better-auth/api";
import type {
  EmailChangeInput,
  EmailChangeRefusal,
  PasswordChangeInput,
  PasswordChangeRefusal,
} from "@/shared/schemas/settings.ts";
import type { Auth } from "./auth.ts";

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
    // Better Auth changes a verified address only through a verification
    // email Raaqeb does not send; a new address is unverified anyway, until
    // its next one-time code.
    if (
      session?.user.emailVerified &&
      email.toLowerCase() !== session.user.email
    ) {
      const context = await auth.$context;
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
    // Better Auth words the same-address refusal only in its message (update-user.mjs).
    if (isAPIError(error) && error.message === "Email is the same") {
      return { ok: false, reason: "same_email" };
    }
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
    return { ok: false, reason: "unavailable" };
  }
}

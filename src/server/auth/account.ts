/**
 * The operator account's own changes: the email and the password,
 * through Better Auth on the server with the request's headers, never over
 * its HTTP routes, which stay disabled. Both answer the cookies Better Auth
 * re-issues, which the route sets on the response, and the page reloads to
 * adopt them. Every function answers a result and never throws.
 */
import { isAPIError } from "better-auth/api";
import type {
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

/** Changes the signed-in operator's email; the new address is unverified, so no email is sent. */
export async function changeOperatorEmail(
  auth: Auth,
  headers: Headers,
  email: string
): Promise<EmailChangeResult> {
  try {
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
    return { ok: true, setCookies: changed.headers.getSetCookie() };
  } catch (error) {
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

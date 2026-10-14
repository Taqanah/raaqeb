/**
 * The sign-in form's shape and the ways it fails (ADR-0004): the
 * failure is a code the page renders through the catalog, never Better
 * Auth's English text.
 */
import { z } from "zod";
import { normalizeDigits } from "@/shared/i18n/format.ts";

/** Better Auth's default minimum, no complexity rules. */
export const passwordMinLength = 8;
export const passwordMaxLength = 128;

export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(passwordMinLength).max(passwordMaxLength),
});

export type SignInInput = z.infer<typeof signInSchema>;

/** Why a sign-in did not sign in: wrong email or password (one code, so nothing is learned about the address), the page not opened at the public address, too many attempts, or the server did not answer. */
export type SignInFailure =
  | "invalid_credentials"
  | "origin_refused"
  | "rate_limited"
  | "unavailable";

/** The sign-in answered: signed in, or the second step is due before a session exists, asking for the authenticator app's code when one is set up. */
export interface SignInOutcome {
  readonly app: boolean;
  readonly secondStep: boolean;
}

/** How the second step's code was got: the authenticator app, a backup code, or email. */
export type CodeMethod = "app" | "backup" | "email";

/** The one-time code as typed: six digits, Arabic digits accepted. */
export const codeSchema = z.object({
  code: z
    .string()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^\d{6}$/)),
  trust: z.boolean(),
});
export type CodeInput = z.infer<typeof codeSchema>;

/**
 * A backup code as typed: ten letters and digits in two groups of five,
 * matched without regard to case, spaces or the dash, Arabic digits accepted.
 */
export const backupCodeSchema = z.object({
  code: z
    .string()
    .transform(normalizeBackupCode)
    .pipe(z.string().regex(/^[a-z0-9]{5}-[a-z0-9]{5}$/)),
  trust: z.boolean(),
});
export type BackupCodeInput = z.input<typeof backupCodeSchema>;

const spacesAndDashes = /[\s-]/g;

/** A backup code in the form it was shown: lower case, `xxxxx-xxxxx`. */
function normalizeBackupCode(typed: string): string {
  const bare = normalizeDigits(typed)
    .replace(spacesAndDashes, "")
    .toLowerCase();
  return `${bare.slice(0, 5)}-${bare.slice(5)}`;
}

/**
 * Why a code did not sign in: wrong; no attempts left or expired (both want
 * a new emailed code); the pending sign-in spent or gone, so it starts over
 * from the password; too many wrong codes, which lock the second step for 15
 * minutes; too many calls; or the server did not answer.
 */
export type CodeFailure =
  | "wrong_code"
  | "no_attempts_left"
  | "expired"
  | "start_over"
  | "locked"
  | "rate_limited"
  | "unavailable";

export const resetRequestSchema = z.object({ email: z.email() });
export type ResetRequestInput = z.infer<typeof resetRequestSchema>;

/** Why the request was refused: too many calls, or the server did not answer. A link that did not go is no refusal. */
export type ResetRequestFailure = "rate_limited" | "unavailable";

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(passwordMinLength).max(passwordMaxLength),
  token: z.string().min(1),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** Why the password did not change: the link is used, expired or not one, too many calls, or the server did not answer. */
export type ResetFailure = "invalid_link" | "rate_limited" | "unavailable";

/** Why a sign-out did not end the session: the origin check refused the page's address, or the server did not answer. */
export type SignOutFailure = "origin_refused" | "unavailable";

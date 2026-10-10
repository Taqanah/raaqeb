/**
 * The endpoints Better Auth mounts under /api/auth and which of them Raaqeb
 * answers. The list is explicit and
 * subtractive: every path Better Auth mounts is either allowed here, disabled
 * here, or unblockable, and paths.test.ts fails on any path in none of the
 * three, so an upgrade that mounts a new endpoint is triaged, never live by
 * accident. `disabledPaths` matches the exact request path, so a route with a
 * parameter cannot be listed; those are the unblockable ones.
 */

/** The endpoints the browser calls over HTTP: sign-in and sign-out, the reset request and reset, the emailed code's send and verify, and the authenticator app's and backup codes' verify. */
export const allowedPaths: readonly string[] = [
  "/request-password-reset",
  "/reset-password",
  "/sign-in/email",
  "/sign-out",
  "/two-factor/send-otp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/two-factor/verify-totp",
];

/**
 * Every other endpoint Better Auth 1.7.6 mounts with the email-and-password
 * authenticator and the two-factor plugin, answered 404 "Not Found". The
 * account and auth settings pages call some of these through `auth.api` on
 * the server, which this list does not gate (better-auth/dist/api/index.mjs,
 * `onRequest`): enabling and disabling the second step, the app's URI and
 * new backup codes.
 */
export const disabledPaths: readonly string[] = [
  "/account-info",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/error",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/refresh-token",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/sign-in/social",
  "/sign-up/email",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
];

/**
 * Routes with a parameter, which `disabledPaths` cannot name. The callback
 * has no social provider to redirect to, and the reset redirect is never
 * used: the reset link points straight at Raaqeb's page.
 */
export const unblockablePaths: readonly string[] = [
  "/callback/:id",
  "/reset-password/:token",
];

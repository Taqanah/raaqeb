/**
 * The browser's calls to Better Auth's allowed endpoints under /api/auth
 *: plain JSON fetches, no Better Auth
 * client. The browser sets Origin, which Better Auth checks against the
 * public address. Each answer is a result with a code the page words.
 */
import type {
  BackupCodeInput,
  CodeFailure,
  CodeInput,
  CodeMethod,
  ResetFailure,
  ResetPasswordInput,
  ResetRequestFailure,
  ResetRequestInput,
  SignInFailure,
  SignInInput,
  SignInOutcome,
} from "@/shared/schemas/auth.ts";
import {
  backupCodeSchema,
  codeSchema,
  resetPasswordSchema,
  resetRequestSchema,
  signInSchema,
} from "@/shared/schemas/auth.ts";

export const authBasePath = "/api/auth";

export type SignInResult =
  | ({ readonly ok: true } & SignInOutcome)
  | { readonly ok: false; readonly failure: SignInFailure };

export type CodeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: CodeFailure };

export type ResetRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ResetRequestFailure };

export type ResetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ResetFailure };

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${authBasePath}${path}`, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

/** Posts the credentials; on success the session cookie is set by the response. */
export async function signIn(input: SignInInput): Promise<SignInResult> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return { failure: "invalid_credentials", ok: false };
  }
  let response: Response;
  try {
    response = await post("/sign-in/email", parsed.data);
  } catch {
    return { failure: "unavailable", ok: false };
  }
  if (response.ok) {
    const body = await bodyOf(response);
    return {
      app:
        Array.isArray(body.twoFactorMethods) &&
        body.twoFactorMethods.includes("totp"),
      ok: true,
      secondStep: body.twoFactorRedirect === true,
    };
  }
  // 401 is the credentials; 400 is input Better Auth refused. Both tell the same nothing about the address.
  if (response.status === 400 || response.status === 401) {
    return { failure: "invalid_credentials", ok: false };
  }
  // 403 is its origin check, decided before the credentials are read, so naming it leaks nothing.
  if (response.status === 403) {
    return { failure: "origin_refused", ok: false };
  }
  if (response.status === 429) {
    return { failure: "rate_limited", ok: false };
  }
  return { failure: "unavailable", ok: false };
}

/** Ends the session; true when the server confirmed it. */
export async function signOut(): Promise<boolean> {
  try {
    return (await post("/sign-out", {})).ok;
  } catch {
    return false;
  }
}

/** A JSON answer's fields, or none when the body is not a JSON object. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? { ...body } : {};
  } catch {
    return {};
  }
}

/** Better Auth's error codes for a code, as the page words them. */
const codeFailures: Readonly<Record<string, CodeFailure>> = {
  INVALID_BACKUP_CODE: "wrong_code",
  INVALID_CODE: "wrong_code",
  INVALID_TWO_FACTOR_COOKIE: "expired",
  OTP_HAS_EXPIRED: "expired",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "no_attempts_left",
};

/** Asks for a one-time code to the operator's address; the second-step cookie the sign-in set names the account. */
export async function sendCode(): Promise<CodeResult> {
  let response: Response;
  try {
    response = await post("/two-factor/send-otp", {});
  } catch {
    return { failure: "unavailable", ok: false };
  }
  if (response.ok) {
    return { ok: true };
  }
  if (response.status === 429) {
    return { failure: "rate_limited", ok: false };
  }
  // A 401 is the sign-in's ten minutes gone: it starts over.
  return {
    failure: response.status === 401 ? "expired" : "unavailable",
    ok: false,
  };
}

/** Where each method's code is verified. */
const verifyPaths: Readonly<Record<CodeMethod, string>> = {
  app: "/two-factor/verify-totp",
  backup: "/two-factor/verify-backup-code",
  email: "/two-factor/verify-otp",
};

/** With the app or a backup code no new code can be asked for: a spent or expired pending sign-in starts over from the password. */
const startOver: Readonly<Record<string, CodeFailure>> = {
  INVALID_TWO_FACTOR_COOKIE: "start_over",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "start_over",
};

/** Posts the code to the method's endpoint; on success the session cookie is set, and the trusted-browser cookie when asked. */
export async function verifyCode(
  input: CodeInput | BackupCodeInput,
  method: CodeMethod
): Promise<CodeResult> {
  const parsed = (
    method === "backup" ? backupCodeSchema : codeSchema
  ).safeParse(input);
  if (!parsed.success) {
    return { failure: "wrong_code", ok: false };
  }
  let response: Response;
  try {
    response = await post(verifyPaths[method], {
      code: parsed.data.code,
      trustDevice: parsed.data.trust,
    });
  } catch {
    return { failure: "unavailable", ok: false };
  }
  if (response.ok) {
    return { ok: true };
  }
  const { code } = await bodyOf(response);
  // Both are 429: the lock after ten wrong codes names itself; the rate limit does not.
  if (code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return { failure: "locked", ok: false };
  }
  if (response.status === 429) {
    return { failure: "rate_limited", ok: false };
  }
  const failures =
    method === "email" ? codeFailures : { ...codeFailures, ...startOver };
  return {
    failure: (typeof code === "string" && failures[code]) || "unavailable",
    ok: false,
  };
}

/** Asks for a reset link to the address; the answer never says whether the address is the account's. */
export async function requestReset(
  input: ResetRequestInput
): Promise<ResetRequestResult> {
  const parsed = resetRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { failure: "unavailable", ok: false };
  }
  let response: Response;
  try {
    response = await post("/request-password-reset", parsed.data);
  } catch {
    return { failure: "unavailable", ok: false };
  }
  if (response.ok) {
    return { ok: true };
  }
  return {
    failure: response.status === 429 ? "rate_limited" : "unavailable",
    ok: false,
  };
}

/** Sets the new password with the link's token; no sign-in follows. */
export async function resetPassword(
  input: ResetPasswordInput
): Promise<ResetResult> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { failure: "unavailable", ok: false };
  }
  let response: Response;
  try {
    response = await post("/reset-password", parsed.data);
  } catch {
    return { failure: "unavailable", ok: false };
  }
  if (response.ok) {
    return { ok: true };
  }
  if (response.status === 429) {
    return { failure: "rate_limited", ok: false };
  }
  // Only a refused token spends the link; any other refusal leaves it usable.
  const { code } = await bodyOf(response);
  return {
    failure: code === "INVALID_TOKEN" ? "invalid_link" : "unavailable",
    ok: false,
  };
}

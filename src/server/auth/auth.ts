/**
 * The auth module's interface: one Better Auth instance
 * per open storage, built from `better-auth/minimal` over the storage's
 * adapter, the versioned secret, the public address and the trusted proxies.
 * Sign-in and sign-out go over HTTP through `handleAuth` so Better Auth's own
 * rate limit, origin check and disabled-paths check apply (they run only in
 * its router, never on `auth.api`); the rate limit keys on the client address
 * the entry resolved behind the trusted proxies (server/boot/proxies.ts). The
 * admin guard reads the session on the server through `readOperator`.
 */

import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { generateRandomString } from "better-auth/crypto";
import { betterAuth } from "better-auth/minimal";
import { twoFactor } from "better-auth/plugins/two-factor";
import { record } from "@/server/audit/audit.ts";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import type { BootSettings } from "@/server/boot/settings.ts";
import { error as logError, info as logInfo, reasonOf } from "@/server/log.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { AuthDatabase } from "@/server/storage/auth.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { Role } from "@/shared/domain/roles.ts";
import {
  closedGate,
  type InvitationGate,
  invitationAccept,
  invitationGate,
} from "./invitation.ts";
import { authMailOver } from "./mail.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { disabledPaths, unblockablePaths } from "./paths.ts";
import { parseSecrets, resolveSecrets } from "./secret.ts";
import {
  notInvitedCode,
  passwordRefused,
  readSsoProvider,
  type SsoProvider,
  signUpRole,
  ssoCallbackPath,
  ssoPlugin,
  ssoRequiredCode,
  testDiscovery,
} from "./sso.ts";

/** The boot settings auth reads; the request context carries them beside the storage. The install key opens the auth email channel's secrets. */
export type AuthBoot = Pick<BootSettings, "betterAuthSecrets" | "installKey">;

/** The mail an instance sends; server/auth/mail.ts builds it over a storage, the reset command captures it. */
export interface AuthMail {
  /** The one-time code of the second step. */
  readonly code: (to: string, code: string) => Promise<void>;
  /** The reset link; the request answers the same whether it went or not, so a failure is this function's to log. */
  readonly resetLink: (to: string, link: string) => Promise<void>;
}

// The sends Better Auth hands off so a request answers before them; Better Auth catches and logs each one's failure.
const handedOff = new Set<Promise<unknown>>();

function handOff(send: Promise<unknown>): void {
  handedOff.add(send);
  const forget = () => handedOff.delete(send);
  send.then(forget, forget);
}

/** Resolves once no reset link or one-time code is left handed off, including those handed off while it waits; the stop path waits on it before closing the storage the send reads. */
export async function mailSettled(): Promise<void> {
  // A request still in flight when the server stopped may hand a send off while this waits.
  while (handedOff.size > 0) {
    // biome-ignore lint/performance/noAwaitInLoops: each pass waits for the sends handed off during the last one
    await Promise.allSettled(handedOff);
  }
}

/** The set-new-password page; the reset link points at it with the token. */
export const resetPagePath = "/reset-password";

/** The reset link: the public address, the page and the core token. */
export function resetLinkOf(publicAddress: string, token: string): string {
  return `${publicAddress}${resetPagePath}?token=${encodeURIComponent(token)}`;
}

/** Whether a reset link's token still sets a password: issued, not used and not expired, so the page shows the form or says to ask for a new link. */
export async function resetLinkOpen(
  auth: Auth,
  token: string,
  now: number
): Promise<boolean> {
  if (token === "") {
    return false;
  }
  // The row Better Auth's request writes and its reset deletes (api/routes/password.mjs).
  const row = await (await auth.$context).internalAdapter.findVerificationValue(
    `reset-password:${token}`
  );
  return row !== null && row !== undefined && row.expiresAt.getTime() > now;
}

/** Deletes every trusted browser: Better Auth's rows are `trust-device-<random>`, one per browser. */
async function forgetTrustedBrowsers(adapter: {
  deleteMany: (input: {
    model: string;
    where: { field: string; operator: "starts_with"; value: string }[];
  }) => Promise<number>;
}): Promise<void> {
  await adapter.deleteMany({
    model: "verification",
    where: [
      { field: "identifier", operator: "starts_with", value: "trust-device-" },
    ],
  });
}

export interface CreateAuthInput {
  /** The versioned secrets text. */
  /** Writes each sign-in's audit entry. */
  readonly audit?: AuthAudit;
  /** The public address as an origin, Better Auth's base URL and its one trusted origin; nothing before onboarding stores one, and then Better Auth infers it from the request. */
  readonly baseURL: string | undefined;
  readonly database: AuthDatabase;
  /** The invitations the accept endpoint takes; none is open by default. */
  readonly invitations?: InvitationGate;
  /** Better Auth's own log lines, already prefixed; routed to stderr by default. */
  readonly log?: (line: string) => void;
  readonly mail: AuthMail;
  readonly secrets: string;
  /** The identity provider operators may sign in with; none while single sign-on is off. */
  readonly sso?: SsoProvider;
}

const day = 24 * 60 * 60;
/** The second step's endpoints the browser calls between the password and the code. */
const secondStepPaths = new Set([
  "/two-factor/send-otp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/two-factor/verify-totp",
]);
/** The second step's code: five minutes and three attempts. */
const codeMinutes = 5;
const codeAttempts = 3;

/** Ten backup codes of lower-case letters and digits, `xxxxx-xxxxx`, so one copied from paper has no case to get wrong. */
function backupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const code = generateRandomString(10, "a-z", "0-9");
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** Where a backup code is spent or made: only for an authenticator app in force. */
const backupCodePaths = new Set([
  "/two-factor/generate-backup-codes",
  "/two-factor/verify-backup-code",
]);
/** An app code's window: its 30 seconds and the 30 either side, with a margin. */
const usedCodeMs = 2 * 60 * 1000;

function usedCodeOf(account: string, code: string): string {
  return `totp-used-${account}-${code}`;
}

/**
 * The name the authenticator app lists the install under: its host name, so
 * two installs stay apart. A colon separates issuer from account in the
 * app's label, so a port is left out and an IPv6 address leaves the name
 * alone.
 */
function issuerOf(baseURL: string | undefined): string {
  const host = baseURL ? new URL(baseURL).hostname : "";
  return host === "" || host.includes(":") ? "Raaqeb" : `Raaqeb (${host})`;
}

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The account a pending sign-in names: the plugin's signed `two_factor` cookie (plugins/two-factor/constant.mjs) holds a verification row's identifier, whose value is the account's id. */
async function pendingAccount(ctx: HookContext): Promise<string | undefined> {
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) {
    return;
  }
  return (
    (await ctx.context.internalAdapter.findVerificationValue(identifier))
      ?.value ?? undefined
  );
}

/**
 * The second step's code endpoints. Over HTTP they serve a pending sign-in
 * only: with a session they would switch the second step on without the
 * password or a test, and the settings page confirms the app on the server.
 * Backup codes count only once the app's first code was entered; Better Auth
 * would take those of a setup left halfway. An app code that signed in is
 * refused again inside its window.
 */
async function guardCodes(ctx: HookContext): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (ctx.request && session && secondStepPaths.has(ctx.path)) {
    throw new APIError("FORBIDDEN", {
      code: "SIGNED_IN",
      message: "the second step's codes are for a pending sign-in",
    });
  }
  const account = session?.user.id ?? (await pendingAccount(ctx));
  if (!account) {
    // Better Auth answers a missing or spent pending sign-in itself.
    return;
  }
  if (backupCodePaths.has(ctx.path)) {
    const app = await ctx.context.adapter.findOne<{ verified?: boolean }>({
      model: "twoFactor",
      where: [{ field: "userId", value: account }],
    });
    // The plugin's own rule for an app at sign-in (plugins/two-factor/index.mjs).
    if (!app || app.verified === false) {
      throw new APIError("BAD_REQUEST", {
        code: "BACKUP_CODES_NOT_ENABLED",
        message: "backup codes count once the authenticator app is in force",
      });
    }
  }
  const code: unknown = ctx.body?.code;
  if (ctx.path === "/two-factor/verify-totp" && typeof code === "string") {
    const used = await ctx.context.internalAdapter.findVerificationValue(
      usedCodeOf(account, code)
    );
    if (used && used.expiresAt > new Date()) {
      throw new APIError("UNAUTHORIZED", {
        code: "INVALID_CODE",
        message: "the app's code was used already",
      });
    }
  }
}

/** The codes that finish a pending sign-in; asking for an emailed code finishes nothing. */
const finishingPaths = new Set(
  [...secondStepPaths].filter((path) => path !== "/two-factor/send-otp")
);

/**
 * The endpoints that check the signed-in account's current password. The
 * settings and team pages call them on the server, where Better Auth's rate
 * limit never runs, so wrong passwords are counted here per account: five in
 * a quarter of an hour make every check wait until the oldest of them is
 * that old.
 */
const passwordCheckPaths = new Set([
  "/change-password",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
  "/verify-password",
]);
const passwordAttempts = 5;
const passwordWindowMs = 15 * 60 * 1000;

/** The code a check the account's wrong passwords hold back answers with. */
export const tooManyPasswordsCode = "TOO_MANY_PASSWORD_ATTEMPTS";

// When each account's recent wrong passwords were typed, process-wide like Better Auth's own limit.
const wrongPasswords = new Map<string, number[]>();

function recentWrong(account: string, now: number): number[] {
  const recent = (wrongPasswords.get(account) ?? []).filter(
    (at) => at > now - passwordWindowMs
  );
  if (recent.length === 0) {
    wrongPasswords.delete(account);
  } else {
    wrongPasswords.set(account, recent);
  }
  return recent;
}

/** Refuses a password check while the account's wrong passwords hold it back. */
async function guardPasswordCheck(ctx: HookContext): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (
    session &&
    recentWrong(session.user.id, Date.now()).length >= passwordAttempts
  ) {
    throw new APIError("TOO_MANY_REQUESTS", {
      code: tooManyPasswordsCode,
      message: "too many wrong passwords for this account lately",
    });
  }
}

/** Counts a wrong password against the signed-in account. */
async function countWrongPassword(ctx: HookContext): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (session) {
    const now = Date.now();
    wrongPasswords.set(session.user.id, [
      ...recentWrong(session.user.id, now),
      now,
    ]);
  }
}

/** The provider's callback as Better Auth's router names it. */
const callbackPath = "/callback/:id";

/** The endpoints whose new session is a sign-in: the password, a code that finishes one, an accepted invitation, onboarding's sign-up, the provider's callback. */
const signingInPaths = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/invitation/accept",
  callbackPath,
  ...finishingPaths,
]);

/** Whether an endpoint answered with a refusal; the provider's callback answers a sign-in with a redirect, which Better Auth throws as an error too. */
function refused(returned: unknown): returned is APIError {
  return isAPIError(returned) && returned.statusCode >= 400;
}

/**
 * One log line per sign-in attempt over HTTP, with the client address and
 * never the email: a password that needs the second step waits, a code
 * that passes signs in. A plugin, so it runs after the two-factor plugin's
 * hook has decided whether a code is due. A 429 never reaches here. Each
 * sign-in, and each refused one with the email typed or the provider gave
 * and the code it was refused with, is also an audit entry; a sign-in that
 * waits for its second step is one once the code passes.
 */
function signInLog(
  log: (line: string) => void,
  audit: AuthAudit | undefined,
  providerEmails: WeakMap<Request, string>
): BetterAuthPlugin {
  return {
    hooks: {
      after: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const address = ctx.request?.headers.get(clientAddressHeader);
            const returned: unknown = ctx.context.returned;
            const pending =
              typeof returned === "object" &&
              returned !== null &&
              "twoFactorRedirect" in returned;
            const user = ctx.context.newSession?.user;
            log(
              `${logEventOf(ctx.path, user !== undefined, returned, pending)} from ${address ?? "an unknown address"}`
            );
            if (pending) {
              return;
            }
            const method = methodOf(ctx.path);
            if (user) {
              await audit?.({
                action: "sign_in.succeed",
                actor: { email: user.email, id: user.id },
                address: address ?? undefined,
                input: { method },
              });
              return;
            }
            // A refused sign-in names the email typed or the provider gave, never the password, and the code it was refused with.
            const typed: unknown =
              ctx.body?.email ??
              (ctx.request && providerEmails.get(ctx.request));
            await audit?.({
              action: "sign_in.refuse",
              actor: undefined,
              address: address ?? undefined,
              input: {
                ...(typeof typed === "string" && {
                  email: typed.toLowerCase(),
                }),
                method,
                reason: refusalOf(returned),
              },
            });
          }),
          matcher: (ctx) =>
            ctx.request !== undefined &&
            (ctx.path === "/sign-in/email" ||
              ctx.path === "/invitation/accept" ||
              ctx.path === callbackPath ||
              finishingPaths.has(ctx.path ?? "")),
        },
      ],
    },
    id: "raaqeb-sign-in-log",
  };
}

/** The code a sign-in was refused with: the answer's own, or the one the provider's callback redirects with. */
function refusalOf(returned: unknown): string | undefined {
  if (!isAPIError(returned)) {
    return;
  }
  const code: unknown = returned.body?.code;
  return typeof code === "string"
    ? code
    : (new URL(
        new Headers(returned.headers).get("location") ?? "/",
        "http://raaqeb.invalid"
      ).searchParams.get("error") ?? undefined);
}

/** A sign-in attempt's log line, before its address. */
function logEventOf(
  path: string,
  signedIn: boolean,
  returned: unknown,
  pending: boolean
): string {
  if (path === callbackPath) {
    return signedIn
      ? "sign-in through single sign-on"
      : "sign-in through single sign-on refused";
  }
  if (refused(returned)) {
    return path === "/sign-in/email"
      ? "sign-in refused"
      : "sign-in refused at the second step";
  }
  return pending ? "sign-in waits for the second step" : "sign-in";
}

/** How an endpoint signs in, as an audit entry names it. */
function methodOf(path: string): string {
  if (path === callbackPath) {
    return "provider";
  }
  if (path === "/invitation/accept") {
    return "invitation";
  }
  return path === "/sign-in/email" ? "password" : "second_step";
}

/** Writes a sign-in's audit entry (server/audit/audit.ts); none for an instance built without a storage's log. */
export type AuthAudit = (event: {
  readonly action: string;
  readonly actor: { readonly email: string; readonly id: string } | undefined;
  readonly address: string | undefined;
  readonly input: unknown;
}) => Promise<void>;

/** The Better Auth instance for these inputs: minimal build, Argon2id, UUIDv7 ids, 7-day sessions refreshed daily, the disabled-paths list, the in-memory rate limit keyed on the address the entry resolved. */
export function createAuth(input: CreateAuthInput) {
  const log = input.log ?? logError;
  const invitations = input.invitations ?? closedGate;
  const { sso } = input;
  // The role each address signing up through the provider was admitted with, from the admission check to the account's creation a moment later in the same callback.
  const admitted = new Map<string, Role>();
  // The address the provider gave in a callback, for the audit entry of a sign-in it refuses.
  const providerEmails = new WeakMap<Request, string>();
  return betterAuth({
    // An address that has an account is linked to the provider only when the provider says the address is verified: no provider is trusted without it.
    account: {
      accountLinking: {
        enabled: true,
        // Only an emailed code verifies an account here, so most are unverified locally and the default `true` would stop them linking.
        requireLocalEmailVerified: false,
        trustedProviders: [],
      },
    },
    advanced: {
      // The reset link and the one-time code go after the answer, so the operator's address answers as fast as any other.
      backgroundTasks: { handler: handOff },
      cookiePrefix: "raaqeb",
      // The schema check runs in every environment; Better Auth's default skips it in production.
      database: { generateId: () => Bun.randomUUIDv7(), validateSchema: true },
      // Better Auth skips its origin check under NODE_ENV=test unless told; the check never depends on the environment here.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      // The install decides, never NODE_ENV: Secure once an https address is stored, plain before.
      useSecureCookies: input.baseURL?.startsWith("https://") ?? false,
      // The entry writes this header on every request from the socket peer and
      // the trusted proxies; nothing a client sends survives.
      ipAddress: { ipAddressHeaders: [clientAddressHeader] },
    },
    appName: "Raaqeb",
    baseURL: input.baseURL,
    database: input.database,
    databaseHooks: {
      session: {
        create: {
          // A deactivated account makes no session, whichever way it signs in; the password was checked before this.
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(
              session.userId
            );
            // The fields are Raaqeb's own (user.additionalFields), which the hook's type leaves out.
            if (user && "deactivatedAt" in user && user.deactivatedAt) {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_DEACTIVATED",
                message: "the account is deactivated",
              });
            }
            // Checked after the password, so a wrong one answers as before.
            if (
              ctx?.path === "/sign-in/email" &&
              user &&
              "role" in user &&
              passwordRefused(sso, String(user.role))
            ) {
              throw new APIError("FORBIDDEN", {
                code: ssoRequiredCode,
                message: "the account signs in through single sign-on",
              });
            }
            const method = ctx?.path === callbackPath ? "oidc" : "password";
            return { data: { ...session, method } };
          },
        },
      },
      user: {
        create: {
          // The install's first account is its owner (CONTEXT.md "Role"); onboarding makes it. One made through the provider takes the role it was admitted with, and none was refused.
          after: async (user, ctx) => {
            if (ctx?.path === callbackPath) {
              await invitations.forget(user.email);
            }
          },
          before: async (user, ctx) => {
            if (ctx?.path === callbackPath) {
              const role = admitted.get(user.email.toLowerCase());
              admitted.delete(user.email.toLowerCase());
              if (!role) {
                throw new APIError("FORBIDDEN", {
                  code: notInvitedCode,
                  message: "the address may not sign up",
                });
              }
              return { data: { ...user, role } };
            }
            return ctx &&
              (await ctx.context.internalAdapter.countTotalUsers()) === 0
              ? { data: { ...user, role: "owner" } }
              : { data: user };
          },
        },
      },
    },
    // The provider's sign-in starts at /sign-in/social only while single sign-on is on.
    disabledPaths: sso
      ? disabledPaths.filter((path) => path !== "/sign-in/social")
      : [...disabledPaths],
    emailAndPassword: {
      enabled: true,
      password: { hash: hashPassword, verify: verifyPassword },
      // A reset ends every session; the after hook forgets the trusted browsers.
      revokeSessionsOnPasswordReset: true,
      // The core token, stored as Better Auth's verification row on both backends; one hour.
      resetPasswordTokenExpiresIn: 60 * 60,
      // Every address gets the same answer whether the link went or not; only the log says it did not.
      sendResetPassword: async ({ token, user }) => {
        if (input.baseURL === undefined) {
          log("the reset link was not sent: no public address is stored");
          return;
        }
        await input.mail.resetLink(
          user.email,
          resetLinkOf(input.baseURL, token)
        );
      },
    },
    experimental: { instrumentation: { enabled: false } },
    hooks: {
      // A reset forgets the trusted browsers; an app code that signed in is spent; an emailed code verifies the address. The sign-in log is signInLog.
      after: createAuthMiddleware(async (ctx) => {
        const returned: unknown = ctx.context.returned;
        if (refused(returned)) {
          if (
            passwordCheckPaths.has(ctx.path) &&
            returned.body?.code === "INVALID_PASSWORD"
          ) {
            await countWrongPassword(ctx);
          }
          return;
        }
        if (ctx.path === "/reset-password") {
          await forgetTrustedBrowsers(ctx.context.adapter);
          return;
        }
        const user = ctx.context.newSession?.user;
        // A sign-in that made a session is the account's last one; a password change re-issuing one is none.
        if (user && signingInPaths.has(ctx.path)) {
          await ctx.context.internalAdapter.updateUser(user.id, {
            lastSignInAt: new Date(),
          });
        }
        // An app code that signed in is spent until its window has passed (RFC 6238, 5.2); Better Auth keeps no record.
        // Only a sign-in over HTTP spends it: the setup's first code may sign in next.
        if (
          ctx.path === "/two-factor/verify-totp" &&
          ctx.request &&
          user &&
          typeof ctx.body?.code === "string"
        ) {
          await ctx.context.internalAdapter.createVerificationValue({
            expiresAt: new Date(Date.now() + usedCodeMs),
            identifier: usedCodeOf(user.id, ctx.body.code),
            value: user.id,
          });
        }
        // The address counts as verified the first time an emailed code is entered.
        if (
          ctx.path === "/two-factor/verify-otp" &&
          user &&
          !user.emailVerified
        ) {
          await ctx.context.internalAdapter.updateUser(user.id, {
            emailVerified: true,
          });
        }
      }),
      // A password change ends every other session; the caller cannot opt out.
      before: createAuthMiddleware(async (ctx) => {
        if (secondStepPaths.has(ctx.path) || backupCodePaths.has(ctx.path)) {
          await guardCodes(ctx);
        }
        if (passwordCheckPaths.has(ctx.path)) {
          await guardPasswordCheck(ctx);
        }
        if (ctx.path !== "/change-password") {
          return;
        }
        return {
          context: { ...ctx, body: { ...ctx.body, revokeOtherSessions: true } },
        };
      }),
    },
    // The router writes every refused request through a process-wide logger whose default prints its own line beside ours, ignoring `logger.log`. A refusal is already a line of Raaqeb's; only a failure is written.
    onAPIError: {
      onError: (thrown) => {
        if (!isAPIError(thrown) || thrown.status === "INTERNAL_SERVER_ERROR") {
          log(`better-auth: ${reasonOf(thrown)}`);
        }
      },
    },
    // Better Auth's info and warn lines print addresses or repeat the sign-in events above; errors carry neither.
    logger: {
      level: "error",
      log: (_level, message) => log(`better-auth: ${message}`),
    },
    // The second step: the authenticator app with its backup
    // codes, and the emailed code. Enabling, disabling and new backup codes
    // run on the server only (paths.ts).
    plugins: [
      twoFactor({
        backupCodeOptions: { customBackupCodesGenerate: backupCodes },
        issuer: issuerOf(input.baseURL),
        otpOptions: {
          allowedAttempts: codeAttempts,
          digits: 6,
          period: codeMinutes,
          sendOTP: ({ otp, user }) => input.mail.code(user.email, otp),
          storeOTP: "hashed",
        },
        // A trusted browser lasts Better Auth's default of 30 days, pinned by a test.
      }),
      invitationAccept(invitations, (role) => passwordRefused(sso, role)),
      signInLog(log, input.audit, providerEmails),
      ...(sso ? [ssoPlugin(sso)] : []),
    ],
    rateLimit: {
      // A reset request sends an email, so it keeps Better Auth's 3 a minute; the reset itself and accepting an invitation get sign-in's 3 in 10 seconds.
      // Starting single sign-on checks no secret (the provider guards its own sign-in), so it gets Better Auth's general 100 in 10 seconds, not the password's 3: a team behind one NAT would meet those.
      customRules: {
        "/invitation/accept": { max: 3, window: 10 },
        "/request-password-reset": { max: 3, window: 60 },
        "/reset-password": { max: 3, window: 10 },
        "/sign-in/social": { max: 100, window: 10 },
      },
      enabled: true,
      storage: "memory",
    },
    secrets: parseSecrets(input.secrets),
    session: {
      // How the session signed in, which the second step an owner requires reads.
      additionalFields: {
        method: { input: false, required: false, type: "string" },
      },
      expiresIn: 7 * day,
      updateAge: day,
    },
    telemetry: { enabled: false },
    // The account page changes the address on the server (server/auth/account.ts) without an email: the second step's codes go to the address in force.
    // Raaqeb's own fields ride on the user row (storage/schema), so the session read carries the role and the preferences with no second query; no request sets one.
    user: {
      // Who may make an account through the provider (sso.ts), read from the raw claims before the account is made; the address is kept for the audit entry of a callback that refuses it.
      validateUserInfo: async ({ source, user }, ctx) => {
        if (
          !sso ||
          source.method !== "oauth" ||
          typeof user.email !== "string"
        ) {
          return;
        }
        if (ctx?.request) {
          providerEmails.set(ctx.request, user.email);
        }
        if (source.action !== "create-user") {
          return;
        }
        const decision = await signUpRole(
          sso,
          invitations,
          {
            claims: source.oauth?.profile ?? {},
            email: user.email,
            emailVerified: user.emailVerified === true,
          },
          Date.now()
        );
        if (!decision.ok) {
          return { error: decision.code };
        }
        admitted.set(user.email.toLowerCase(), decision.role);
      },
      // Roles are these columns and the hooks above, not Better Auth's admin plugin (it mounts many endpoints, keeps its own role table beside ours and bans with a reason, an expiry and impersonation, which is not a deactivation) nor its organization plugin (multi-tenant).
      additionalFields: {
        calendar: { input: false, required: false, type: "string" },
        clock: { input: false, required: false, type: "string" },
        deactivatedAt: { input: false, required: false, type: "date" },
        language: { input: false, required: false, type: "string" },
        lastSignInAt: { input: false, required: false, type: "date" },
        role: {
          defaultValue: "viewer",
          input: false,
          required: true,
          type: "string",
        },
        timeZone: { input: false, required: false, type: "string" },
      },
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
    },
  });
}

/** A Better Auth instance as this module builds it. */
export type Auth = ReturnType<typeof createAuth>;

interface Built {
  readonly auth: Auth;
  readonly key: string;
  /** When an instance built without its unreachable identity provider tries the provider again. */
  readonly retryAt: number | undefined;
}

// One instance per storage; the key is the settings the instance was built from.
const built = new WeakMap<Storage, Built>();
// The instances that serve the provider's callback.
const withSso = new WeakSet<Auth>();
/** How long single sign-on stays off after the provider's discovery document did not answer. */
const ssoRetryMs = 60_000;
// A build in flight, so two first calls at once share one instance and one generated secret.
const building = new WeakMap<Storage, Promise<Auth>>();

/**
 * The instance for an open storage, memoised on the storage and rebuilt when
 * the public address or the secret setting changes, so a settings edit needs
 * no restart and no extra call.
 */
export function authFor(storage: Storage, boot: AuthBoot): Promise<Auth> {
  const inFlight = building.get(storage);
  if (inFlight) {
    return inFlight;
  }
  const build = buildFor(storage, boot).finally(() => building.delete(storage));
  building.set(storage, build);
  return build;
}

/** The settings an instance is built from, read from the storage. */
async function inputsOf(storage: Storage, boot: AuthBoot) {
  const [address, resolved] = await Promise.all([
    readPublicAddress(storage),
    resolveSecrets(storage, boot.betterAuthSecrets),
  ]);
  return { address, resolved };
}

/** One instance over the storage, built from its stored settings and the given mail; `authFor` memoises this, the reset command calls it with a mail that prints. */
export async function buildAuth(
  storage: Storage,
  boot: AuthBoot,
  mail: AuthMail
): Promise<Auth> {
  const { address, resolved } = await inputsOf(storage, boot);
  return createAuth({
    baseURL: address,
    database: storage.authDatabase,
    invitations: invitationGate(storage),
    mail,
    secrets: resolved.secrets,
  });
}

/**
 * The identity provider an instance is built with: the stored one, when its
 * discovery document answers within the test's wait. Better Auth fetches it
 * again with no time limit while the instance starts, and every sign-in,
 * the owner's way back in included, waits on that start.
 */
async function reachable(
  sso: SsoProvider | undefined
): Promise<SsoProvider | undefined> {
  if (!sso || (await testDiscovery(sso.discoveryUrl, fetch)).ok) {
    return sso;
  }
  logError(
    "single sign-on is off for now: the identity provider's discovery document did not answer"
  );
}

async function buildFor(storage: Storage, boot: AuthBoot): Promise<Auth> {
  const [{ address, resolved }, stored] = await Promise.all([
    inputsOf(storage, boot),
    // A provider that cannot be read leaves the password, so an owner still signs in.
    readSsoProvider(storage, boot.installKey).catch(() => undefined),
  ]);
  const key = `${address ?? ""}\n${resolved.secrets}\n${stored ? JSON.stringify(stored) : ""}`;
  const current = built.get(storage);
  if (
    current?.key === key &&
    (current.retryAt === undefined || Date.now() < current.retryAt)
  ) {
    return current.auth;
  }
  const sso = await reachable(stored);
  if (resolved.generated) {
    logInfo("Better Auth secret generated into the settings table");
  }
  if (resolved.overridden && !current) {
    logInfo(
      "BETTER_AUTH_SECRETS is set; a secret stored in the settings table is not used"
    );
  }
  const auth = createAuth({
    audit: (event) => record(storage, { ...event, now: Date.now() }),
    baseURL: address,
    database: storage.authDatabase,
    invitations: invitationGate(storage),
    mail: authMailOver(
      storage,
      boot.installKey,
      { fetch, now: Date.now },
      logError
    ),
    secrets: resolved.secrets,
    sso,
  });
  if (sso) {
    withSso.add(auth);
  }
  built.set(storage, {
    auth,
    key,
    retryAt: stored && !sso ? Date.now() + ssoRetryMs : undefined,
  });
  return auth;
}

// The routes with a parameter, as the prefixes a request path would start with.
const blockedPrefixes = unblockablePaths.map(
  (path) => `/api/auth${path.slice(0, path.indexOf(":"))}`
);

/**
 * Answers a request under /api/auth: Not Found for a route with a parameter
 * (which the disabled-paths list cannot name) but the identity provider's
 * callback while single sign-on is on, 503 with no body when no database is
 * open or it cannot answer, otherwise Better Auth's handler.
 */
export async function handleAuth(
  storage: Storage | undefined,
  boot: AuthBoot,
  request: Request
): Promise<Response> {
  const notFound = () => new Response("Not Found", { status: 404 });
  const { pathname } = new URL(request.url);
  const callback = pathname === ssoCallbackPath;
  if (
    !callback &&
    blockedPrefixes.some((prefix) => pathname.startsWith(prefix))
  ) {
    return notFound();
  }
  if (!storage) {
    return new Response(null, { status: 503 });
  }
  let auth: Auth;
  try {
    auth = await authFor(storage, boot);
  } catch {
    // The settings the instance is built from could not be read or written.
    return new Response(null, { status: 503 });
  }
  return callback && !withSso.has(auth) ? notFound() : auth.handler(request);
}

/** The `name` the tests, the e2e installs and the bench seed an account with: none, as an account from single sign-on or an import may have, so its email stands for it. Onboarding takes the owner's name from its account screen. */
export const operatorName = "";

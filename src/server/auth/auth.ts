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
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { generateRandomString } from "better-auth/crypto";
import { betterAuth } from "better-auth/minimal";
import { twoFactor } from "better-auth/plugins/two-factor";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import type { BootSettings } from "@/server/boot/settings.ts";
import { error as logError, info as logInfo } from "@/server/log.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { AuthDatabase } from "@/server/storage/auth.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { authMailOver } from "./mail.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { disabledPaths, unblockablePaths } from "./paths.ts";
import { parseSecrets, resolveSecrets } from "./secret.ts";

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
  /** The public address as an origin, Better Auth's base URL and its one trusted origin; nothing before onboarding stores one, and then Better Auth infers it from the request. */
  readonly baseURL: string | undefined;
  readonly database: AuthDatabase;
  /** Better Auth's own log lines, already prefixed; routed to stderr by default. */
  readonly log?: (line: string) => void;
  readonly mail: AuthMail;
  /** The versioned secrets text. */
  readonly secrets: string;
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

/** The Better Auth instance for these inputs: minimal build, Argon2id, UUIDv7 ids, 7-day sessions refreshed daily, the disabled-paths list, the in-memory rate limit keyed on the address the entry resolved. */
export function createAuth(input: CreateAuthInput) {
  const log = input.log ?? logError;
  return betterAuth({
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
    disabledPaths: [...disabledPaths],
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
      // One line per sign-in attempt with the client address, never the email. A 429 never reaches here.
      after: createAuthMiddleware(async (ctx) => {
        const refused = isAPIError(ctx.context.returned);
        if (ctx.path === "/sign-in/email") {
          // One line per sign-in attempt with the client address, never the email. A 429 never reaches here.
          const address =
            ctx.request?.headers.get(clientAddressHeader) ??
            "an unknown address";
          log(`sign-in${refused ? " refused" : ""} from ${address}`);
          return;
        }
        if (refused) {
          return;
        }
        if (ctx.path === "/reset-password") {
          await forgetTrustedBrowsers(ctx.context.adapter);
          return;
        }
        const user = ctx.context.newSession?.user;
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
        if (ctx.path !== "/change-password") {
          return;
        }
        return {
          context: { ...ctx, body: { ...ctx.body, revokeOtherSessions: true } },
        };
      }),
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
    ],
    rateLimit: {
      // The reset request and the reset get sign-in's limit, 3 in 10 seconds.
      customRules: {
        "/request-password-reset": { max: 3, window: 10 },
        "/reset-password": { max: 3, window: 10 },
      },
      enabled: true,
      storage: "memory",
    },
    secrets: parseSecrets(input.secrets),
    session: { expiresIn: 7 * day, updateAge: day },
    telemetry: { enabled: false },
    // The account page changes the address on the server (server/auth/account.ts) without an email: the second step's codes go to the address in force.
    user: {
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
    },
  });
}

/** A Better Auth instance as this module builds it. */
export type Auth = ReturnType<typeof createAuth>;

interface Built {
  readonly auth: Auth;
  readonly key: string;
}

// One instance per storage; the key is the two settings the instance was built from.
const built = new WeakMap<Storage, Built>();
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
    mail,
    secrets: resolved.secrets,
  });
}

async function buildFor(storage: Storage, boot: AuthBoot): Promise<Auth> {
  const { address, resolved } = await inputsOf(storage, boot);
  const key = `${address ?? ""}\n${resolved.secrets}`;
  const current = built.get(storage);
  if (current?.key === key) {
    return current.auth;
  }
  if (resolved.generated) {
    logInfo("Better Auth secret generated into the settings table");
  }
  if (resolved.overridden && !current) {
    logInfo(
      "BETTER_AUTH_SECRETS is set; a secret stored in the settings table is not used"
    );
  }
  const auth = createAuth({
    baseURL: address,
    database: storage.authDatabase,
    mail: authMailOver(
      storage,
      boot.installKey,
      { fetch, now: Date.now },
      logError
    ),
    secrets: resolved.secrets,
  });
  built.set(storage, { auth, key });
  return auth;
}

// The routes with a parameter, as the prefixes a request path would start with.
const blockedPrefixes = unblockablePaths.map(
  (path) => `/api/auth${path.slice(0, path.indexOf(":"))}`
);

/**
 * Answers a request under /api/auth: Not Found for a route with a parameter
 * (which the disabled-paths list cannot name), 503 with no body when no
 * database is open or it cannot answer, otherwise Better Auth's handler.
 */
export async function handleAuth(
  storage: Storage | undefined,
  boot: AuthBoot,
  request: Request
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (blockedPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return new Response("Not Found", { status: 404 });
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
  return auth.handler(request);
}

/** The constant `name` Better Auth requires on sign-up; the operator account has no name (CONTEXT.md). */
export const operatorName = "operator";

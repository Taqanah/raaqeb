/**
 * Onboarding (CONTEXT.md "Onboarding"): the state of an
 * install before an operator account exists, and the three screens' work.
 * The language screen stores nothing (its choice travels as `?locale=` until
 * the account screen stores it); the database screen tests a URL, opens and
 * migrates the chosen database and writes `config.json`; the account screen
 * stores the install language and the public address, creates the account
 * through Better Auth and signs it in. Every function answers a result and
 * never throws.
 */

import { authFor, operatorName } from "@/server/auth/auth.ts";
import {
  type ConfigFile,
  readConfigFile,
  writeConfigFile,
} from "@/server/boot/datadir.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import { requestOriginHeader } from "@/server/boot/proxies.ts";
import type { BootSettings } from "@/server/boot/settings.ts";
import { error as logError, info as logInfo } from "@/server/log.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { installLanguage } from "@/server/settings/language.ts";
import type { UrlVerdict } from "@/server/storage/inspect.ts";
import {
  type DatabaseLocation,
  type DatabaseOpener,
  defaultDatabaseLocation,
  type Storage,
} from "@/server/storage/storage.ts";
import type {
  AccountRefusal,
  DatabaseChoice,
  DatabaseRefusal,
  OperatorAccountInput,
} from "@/shared/schemas/onboarding.ts";

/** Which screen the install is at: the database screen, the account screen, or onboarding is over. */
export type OnboardingStep = "database" | "account" | "done";

/** What the connection test found at a Postgres URL, or why it could not look. */
export type ConnectionVerdict = UrlVerdict;

/** The entry's side of onboarding: the boot settings, the open storage if any, and the opener that tests and opens a database in the entry's own module tree. */
export interface OnboardingContext {
  readonly boot: BootSettings;
  readonly opener: DatabaseOpener;
  readonly storage: Storage | undefined;
}

export type TestDatabaseResult =
  | { readonly ok: true; readonly verdict: ConnectionVerdict }
  /** A database is already open: the screen is behind the install, and the test is not an open endpoint. */
  | { readonly ok: false; readonly reason: "already_chosen" };

export type ChooseDatabaseResult =
  | {
      readonly ok: true;
      /** Where the screen goes next: the account screen, or done when the adopted database already holds the account. */
      readonly next: "account" | "done";
    }
  | { readonly ok: false; readonly reason: DatabaseRefusal };

export type CreateAccountResult =
  | {
      readonly ok: true;
      /** The session cookies Better Auth issued; the route puts each on the response. */
      readonly setCookies: readonly string[];
    }
  | { readonly ok: false; readonly reason: AccountRefusal };

/**
 * A screen's patience with a Postgres that does not answer: the boot window
 * of 30 seconds is for a server that is still starting; an
 * operator at the screen gets one attempt and the verdict.
 */
const screenWindowMs = 3000;

/** The verdicts the screen refuses to continue on; `openStorage` would refuse them too. */
const refusedKinds: ReadonlySet<ConnectionVerdict["kind"]> = new Set([
  "unreachable",
  "unrecorded",
  "newer",
  "foreign-record",
]);

/**
 * The screen the install is at: no storage means the database screen,
 * storage without an account the account screen, otherwise done. A database
 * that cannot answer counts as done: an install with an outage must never
 * present itself as unclaimed, and sign-in words the outage.
 */
export async function onboardingStep(
  storage: Storage | undefined
): Promise<OnboardingStep> {
  if (!storage) {
    return "database";
  }
  try {
    return (await storage.operatorAccount.exists()) ? "done" : "account";
  } catch {
    return "done";
  }
}

/** How many screens onboarding has: the database screen is one unless the environment names the database. */
export function onboardingSteps(
  boot: Pick<BootSettings, "databaseUrlFromEnvironment">
): 2 | 3 {
  return boot.databaseUrlFromEnvironment ? 2 : 3;
}

/** Connects to the URL once, classifies what it finds and disconnects; the screen words the verdict. Nothing is written. Refused once a database is open. */
export async function testDatabaseUrl(
  url: string,
  context: OnboardingContext
): Promise<TestDatabaseResult> {
  if (context.storage || chosen.has(context.opener)) {
    return { ok: false, reason: "already_chosen" };
  }
  return { ok: true, verdict: await inspect(url, context.opener) };
}

/** The opener's verdict; a driver that connects and then fails is unreachable with the unknown code, never a throw. */
async function inspect(
  url: string,
  opener: DatabaseOpener
): Promise<ConnectionVerdict> {
  try {
    return await opener.test(url, { windowMs: screenWindowMs });
  } catch {
    return { failure: "unknown", kind: "unreachable" };
  }
}

// One choice at a time per opener (one per process), and the openers that
// already opened: two submissions in the same instant both see no storage in
// their request context, and the second must not open a second database.
const choices = new WeakMap<DatabaseOpener, Promise<unknown>>();
const chosen = new WeakSet<DatabaseOpener>();

/**
 * Opens and migrates the chosen database (the default SQLite file in the data
 * directory, or the tested Postgres URL) through the entry's opener, which
 * makes it the served storage. The Postgres URL is written encrypted into
 * `config.json` after the test and before the open, and taken out again when
 * the open fails, so a boot never meets a URL that does not work; SQLite
 * writes nothing, the file's existence is the choice. Refused when a database
 * is already open or the verdict refuses it.
 */
export function chooseDatabase(
  choice: DatabaseChoice,
  context: OnboardingContext
): Promise<ChooseDatabaseResult> {
  const queued = (choices.get(context.opener) ?? Promise.resolve()).then(() =>
    chooseOnce(choice, context)
  );
  choices.set(context.opener, queued);
  return queued;
}

async function chooseOnce(
  choice: DatabaseChoice,
  context: OnboardingContext
): Promise<ChooseDatabaseResult> {
  if (context.storage || chosen.has(context.opener)) {
    return { ok: false, reason: "already_chosen" };
  }
  const location: DatabaseLocation =
    choice.backend === "sqlite"
      ? defaultDatabaseLocation(context.boot.dataDir)
      : { backend: "postgres", url: choice.url };
  let previous: ConfigFile | undefined;
  if (location.backend === "postgres") {
    // Tested again on continue: the verdict on the screen may be stale.
    const verdict = await inspect(location.url, context.opener);
    if (refusedKinds.has(verdict.kind)) {
      return { ok: false, reason: "refused" };
    }
    previous = await rememberUrl(context.boot, location.url);
    if (!previous) {
      return { ok: false, reason: "open_failed" };
    }
  }
  const opened = await context.opener.open(location);
  if (!opened.ok) {
    logError(opened.message);
    if (previous) {
      await forgetUrl(context.boot, previous);
    }
    return { ok: false, reason: "open_failed" };
  }
  chosen.add(context.opener);
  for (const note of opened.notes) {
    logInfo(note);
  }
  logInfo(`onboarding chose ${location.backend}`);
  // An adopted database may already hold the account (a container recreated without its volume).
  const step = await onboardingStep(opened.storage);
  return { next: step === "done" ? "done" : "account", ok: true };
}

/** Writes the Postgres URL encrypted with the install key into `config.json`, keeping the key already there; answers the config as it was, or nothing when the write failed. */
async function rememberUrl(
  boot: Pick<BootSettings, "dataDir" | "installKey">,
  url: string
): Promise<ConfigFile | undefined> {
  const file = await readConfigFile(boot.dataDir);
  if (!file.ok) {
    logError(file.message);
    return;
  }
  try {
    await writeConfigFile(boot.dataDir, {
      ...file.config,
      databaseUrl: await encrypt(boot.installKey, url),
    });
    return file.config;
  } catch {
    logError("config.json cannot be written in the data directory");
  }
}

/** Puts `config.json` back as it was before the URL, so the next boot does not meet a database that would not open. */
async function forgetUrl(
  boot: Pick<BootSettings, "dataDir">,
  previous: ConfigFile
): Promise<void> {
  try {
    await writeConfigFile(boot.dataDir, previous);
  } catch {
    logError(
      "config.json holds a DATABASE_URL that did not open and could not be taken out; remove it by hand"
    );
  }
}

// One creation at a time per storage in this process: two submissions in
// the same instant would both pass the exists check and make two accounts.
const creations = new WeakMap<Storage, Promise<unknown>>();

/**
 * Stores the install language and the public address, creates the one
 * operator account through Better Auth and signs it in. The address is
 * stored before the instance is built, so the session cookie already
 * follows it (Secure on https). Refused when an account already exists or
 * no database is open, and refused until confirmed when the address is not
 * the browser's origin (the request's `Origin` header, which the browser
 * sets on every POST and a proxy passes through): Better Auth would refuse
 * every sign-in from where the operator stands. Not refused outright, since
 * a tunnel or localhost before DNS is a fair place to onboard from.
 */
export function createOperatorAccount(
  input: OperatorAccountInput,
  context: OnboardingContext,
  headers: Headers
): Promise<CreateAccountResult> {
  const { storage } = context;
  if (!storage) {
    return Promise.resolve({ ok: false, reason: "no_database" });
  }
  const queued = (creations.get(storage) ?? Promise.resolve()).then(() =>
    createOnce(input, storage, context.boot, headers.get("origin"))
  );
  creations.set(storage, queued);
  return queued;
}

async function createOnce(
  input: OperatorAccountInput,
  storage: Storage,
  boot: BootSettings,
  browserOrigin: string | null
): Promise<CreateAccountResult> {
  try {
    if (await storage.operatorAccount.exists()) {
      return { ok: false, reason: "already_exists" };
    }
    // Both are serialised origins, so text equality is origin equality; no Origin at all proves nothing.
    if (input.publicAddress !== browserOrigin && !input.addressConfirmed) {
      return { ok: false, reason: "address_elsewhere" };
    }
    await storage.settings.set(installLanguage, input.locale);
    await storage.settings.set(publicAddress, input.publicAddress);
    // The entry's HSTS reads the address the memo keeps, refreshed when the counter moves.
    await storage.bump();
    const auth = await authFor(storage, boot);
    // Sign-up over HTTP is disabled; this is the one place an account is made, and Better Auth signs it in as it does.
    const signedUp = await auth.api.signUpEmail({
      body: {
        email: input.email,
        name: operatorName,
        password: input.password,
      },
      returnHeaders: true,
    });
    logInfo("onboarding created the operator account");
    return { ok: true, setCookies: signedUp.headers.getSetCookie() };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** The origin to pre-fill the public address with: the one the entry resolved behind the trusted proxies, or nothing, never a value the client chose (the request URL is built from the Host header). */
export function suggestedPublicAddress(headers: Headers): string {
  return headers.get(requestOriginHeader) ?? "";
}

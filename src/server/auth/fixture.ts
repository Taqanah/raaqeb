/**
 * Test support for the auth module: a scratch storage with the operator
 * account, an instance over it with a mail the test can read, and
 * browser-shaped requests to its handler. Imported by tests only.
 */
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import {
  type Auth,
  type AuthBoot,
  type AuthMail,
  createAuth,
  operatorName,
} from "./auth.ts";

export const testOrigin = "http://raaqeb.test";
export const testEmail = "operator@example.com";
export const testPassword = "correct horse battery";
export const testSecrets = "1:test-secret-test-secret-test-secret-test";

/** A mail that sends nothing. */
export const silentMail: AuthMail = {
  code: () => Promise.resolve(),
  resetLink: () => Promise.resolve(),
};

/** One message the instance asked to send. */
export interface SentMail {
  readonly kind: "code" | "reset_link";
  readonly to: string;
  readonly value: string;
}

/** A mail that keeps every message; `failResetLink` makes the link's send throw. */
export function capturingMail(options: { failResetLink?: boolean } = {}): {
  readonly mail: AuthMail;
  readonly sent: SentMail[];
} {
  const sent: SentMail[] = [];
  return {
    mail: {
      code: (to, value) => {
        sent.push({ kind: "code", to, value });
        return Promise.resolve();
      },
      resetLink: (to, value) => {
        if (options.failResetLink) {
          return Promise.reject(new Error("the channel refused the message"));
        }
        sent.push({ kind: "reset_link", to, value });
        return Promise.resolve();
      },
    },
    sent,
  };
}

export interface Scratch {
  readonly boot: AuthBoot;
  readonly cleanup: () => Promise<void>;
  readonly location: DatabaseLocation;
  readonly storage: Storage;
}

/** A fresh database with the public address stored. */
export async function scratchStorage(): Promise<Scratch> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  await opened.storage.settings.set(publicAddress, testOrigin);
  return {
    boot: {
      betterAuthSecrets: undefined,
      installKey: await scratchInstallKey(),
    },
    cleanup: async () => {
      await opened.storage.close();
      await scratch.cleanup();
    },
    location: scratch.location,
    storage: opened.storage,
  };
}

/** An instance over the storage with the operator account created. */
export async function authWithOperator(
  storage: Storage,
  mail: AuthMail = silentMail
): Promise<Auth> {
  const auth = createAuth({
    baseURL: testOrigin,
    database: storage.authDatabase,
    log: () => undefined,
    mail,
    secrets: testSecrets,
  });
  await auth.api.signUpEmail({
    body: { email: testEmail, name: operatorName, password: testPassword },
  });
  return auth;
}

// Better Auth keeps its in-memory rate-limit store once per process, so every
// call that does not measure the limit gets an address of its own.
let addresses = 0;
export function nextAddress(): string {
  addresses += 1;
  return `198.51.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}`;
}

export interface CallOptions {
  address?: string;
  body?: unknown;
  cookie?: string;
  method?: "GET" | "POST";
}

/** A browser-shaped request to one endpoint under /api/auth, from the public address. */
export function call(
  auth: Auth,
  path: string,
  options: CallOptions = {}
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: testOrigin,
    [clientAddressHeader]: options.address ?? nextAddress(),
  });
  if (options.cookie) {
    headers.set("cookie", options.cookie);
  }
  const method =
    options.method ?? (options.body === undefined ? "GET" : "POST");
  return auth.handler(
    new Request(`${testOrigin}/api/auth${path}`, {
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method,
    })
  );
}

export function signIn(
  auth: Auth,
  options: CallOptions & { password?: string } = {}
): Promise<Response> {
  const { password, ...rest } = options;
  return call(auth, "/sign-in/email", {
    body: { email: testEmail, password: password ?? testPassword },
    ...rest,
  });
}

/** The cookies a response set, as one Cookie header value. */
export function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((set) => set.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** Whether a response set the session cookie. */
export function setsSession(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some(
      (set) =>
        set.startsWith("raaqeb.session_token=") &&
        !set.startsWith("raaqeb.session_token=;")
    );
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The code an authenticator app shows for an otpauth URI at a time (RFC 6238:
 * HMAC-SHA1 over the 30-second step, six digits), written apart from Better
 * Auth's so a test checks it rather than repeats it.
 */
export function appCode(uri: string, at: number = Date.now()): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const bits = [...secret.toUpperCase()]
    .map((char) => base32Alphabet.indexOf(char).toString(2).padStart(5, "0"))
    .join("");
  const key = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i += 1) {
    key[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  const step = new DataView(new ArrayBuffer(8));
  step.setBigUint64(0, BigInt(Math.floor(at / 30_000)));
  const mac = new Bun.CryptoHasher("sha1", key)
    .update(new Uint8Array(step.buffer))
    .digest();
  const offset = (mac.at(-1) ?? 0) % 16;
  const value = mac.readUInt32BE(offset) % 2 ** 31;
  return String(value % 1_000_000).padStart(6, "0");
}

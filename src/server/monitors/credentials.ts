/**
 * A monitor's credentials at rest: an
 * HTTP monitor's auth, headers, client certificate key and passphrase and its own proxy's user name and password, a database monitor's connection URL,
 * sealed with the install key into one column, opened only by what
 * sends them (the scheduler and "test now"), and read back into the form as
 * names only, and whether a URL is stored. A secret the form leaves out
 * keeps the stored one.
 */

import { decrypt, encrypt, type InstallKey } from "@/server/boot/installkey.ts";
import {
  type Credentials,
  type CredentialsInput,
  type CredentialsView,
  credentialsSchema,
} from "@/shared/schemas/credentials.ts";

/** The credentials the input asks for, with every left-out secret taken from the stored ones; nothing when a left-out secret has no stored value. */
export function mergeCredentials(
  input: CredentialsInput,
  stored: Credentials | undefined
): Credentials | undefined {
  const auth = mergeAuth(input.auth, stored?.auth);
  const proxyAuth = mergeProxyAuth(input.proxyAuth, stored?.proxyAuth);
  const clientKey = mergeClientKey(input.clientKey, stored?.clientKey);
  if (auth === false || proxyAuth === false) {
    return;
  }
  const kept = new Map(
    (stored?.headers ?? []).map((header) => [
      header.name.toLowerCase(),
      header.value,
    ])
  );
  const headers: Credentials["headers"] = [];
  for (const header of input.headers) {
    const value = header.value ?? kept.get(header.name.toLowerCase());
    if (value === undefined) {
      return;
    }
    headers.push({ name: header.name, value });
  }
  return {
    auth,
    ...(clientKey && { clientKey }),
    headers,
    ...(proxyAuth && { proxyAuth }),
  };
}

/** The client key and passphrase to store; none when none is posted, or when a left-out key has none stored to keep, which leaves the certificate without a key for the save to refuse by name. A typed key replaces the stored passphrase with its own, or none; a kept key keeps its passphrase unless one is typed. */
function mergeClientKey(
  input: CredentialsInput["clientKey"],
  stored: Credentials["clientKey"]
): Credentials["clientKey"] {
  if (input === undefined) {
    return;
  }
  if (input.key !== undefined) {
    return {
      key: input.key,
      ...(input.passphrase !== undefined && { passphrase: input.passphrase }),
    };
  }
  if (stored === undefined) {
    return;
  }
  const passphrase = input.passphrase ?? stored.passphrase;
  return { key: stored.key, ...(passphrase !== undefined && { passphrase }) };
}

/** The proxy's user name and password to store, a left-out password taken from the stored one, or false when none is stored to keep. */
function mergeProxyAuth(
  input: CredentialsInput["proxyAuth"],
  stored: Credentials["proxyAuth"]
): Credentials["proxyAuth"] | false {
  if (input === undefined) {
    return;
  }
  const password = input.password ?? stored?.password;
  return password === undefined ? false : { password, user: input.user };
}

/** The auth to store, or false when a left-out secret has nothing of its kind stored. */
function mergeAuth(
  input: CredentialsInput["auth"],
  stored: Credentials["auth"]
): Credentials["auth"] | false {
  if (input?.kind === "basic") {
    const password =
      input.password ??
      (stored?.kind === "basic" ? stored.password : undefined);
    return password === undefined
      ? false
      : { kind: "basic", password, user: input.user };
  }
  if (input?.kind === "bearer") {
    const token =
      input.token ?? (stored?.kind === "bearer" ? stored.token : undefined);
    return token === undefined ? false : { kind: "bearer", token };
  }
}

/** The ciphertext of the credentials, or nothing when there are none to store. */
export function sealCredentials(
  key: InstallKey,
  credentials: Credentials
): Promise<string | undefined> {
  if (isEmpty(credentials)) {
    return Promise.resolve(undefined);
  }
  return encrypt(key, JSON.stringify(credentials));
}

/** Whether there is nothing to seal. */
export function isEmpty(credentials: Credentials): boolean {
  return (
    credentials.auth === undefined &&
    credentials.clientKey === undefined &&
    credentials.headers.length === 0 &&
    credentials.proxyAuth === undefined &&
    credentials.url === undefined
  );
}

/** The credentials behind a ciphertext, or nothing when the key cannot open it or what it holds no longer fits the schema. */
export async function openCredentials(
  key: InstallKey,
  sealed: string
): Promise<Credentials | undefined> {
  const text = await decrypt(key, sealed);
  if (text === undefined) {
    return;
  }
  const parsed = credentialsSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : undefined;
}

/** What the edit form may show of the credentials: never a secret. */
export function credentialsView(
  credentials: Credentials | undefined
): CredentialsView {
  const auth = credentials?.auth;
  return {
    auth:
      auth?.kind === "basic"
        ? { kind: "basic", user: auth.user }
        : auth && { kind: "bearer" },
    ...(credentials?.clientKey && { clientKey: true as const }),
    headers: (credentials?.headers ?? []).map(({ name }) => ({ name })),
    proxyUser: credentials?.proxyAuth?.user,
    url: credentials?.url !== undefined,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller reads it as no credentials.
  }
}

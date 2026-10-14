import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import type { DatabaseLocation } from "@/server/storage/storage.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  type Auth,
  type AuthBoot,
  type AuthMail,
  authFor,
  createAuth,
  handleAuth,
  mailSettled,
  operatorName,
} from "./auth.ts";
import { disabledPaths } from "./paths.ts";
import { betterAuthSecrets } from "./secret.ts";

// Sign-in, sign-out, sessions and the rate limit over Better Auth's own HTTP
// handler, on both backends. The handler is called directly
// with a Request; the Bun.serve entry adds nothing but the client address
// header, which these requests set themselves.

const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const origin = "http://raaqeb.test";
const email = "operator@example.com";
const password = "correct horse battery";
const secrets = "1:test-secret-test-secret-test-secret-test";
const day = 24 * 60 * 60 * 1000;
const boot: AuthBoot = {
  betterAuthSecrets: undefined,
  installKey: await scratchInstallKey(),
};
/** A mail that sends nothing; the tests of the recovery paths hand their own. */
const silentMail: AuthMail = {
  code: () => Promise.resolve(),
  resetLink: () => Promise.resolve(),
};

// Better Auth keeps its in-memory rate-limit store once per process, not per
// instance, so every call that does not measure the limit gets an address of
// its own; a test that measures it names one address on purpose.
let addresses = 0;
function nextAddress(): string {
  addresses += 1;
  return `203.0.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}`;
}
const secureAttribute = /;\s*Secure/i;
const versionOnePrefix = /^1:/;

let open:
  | {
      storage: Storage;
      location: DatabaseLocation;
      cleanup: () => Promise<void>;
    }
  | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    cleanup: scratch.cleanup,
    location: scratch.location,
    storage: opened.storage,
  };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** An auth over a fresh database with the operator account created. */
async function authWithOperator(
  input: Partial<Parameters<typeof createAuth>[0]> = {}
): Promise<Auth> {
  const store = await storage();
  const auth = createAuth({
    baseURL: origin,
    database: store.authDatabase,
    log: () => undefined,
    mail: silentMail,
    secrets,
    ...input,
  });
  await auth.api.signUpEmail({
    body: { email, name: operatorName, password },
  });
  return auth;
}

interface CallOptions {
  address?: string;
  body?: unknown;
  cookie?: string;
  method?: "GET" | "POST";
  origin?: string | null;
}

/** A browser-shaped request to one endpoint under /api/auth. */
function call(
  auth: Auth,
  path: string,
  options: CallOptions = {}
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    [clientAddressHeader]: options.address ?? nextAddress(),
  });
  const from = options.origin === undefined ? origin : options.origin;
  if (from !== null) {
    headers.set("origin", from);
  }
  if (options.cookie) {
    headers.set("cookie", options.cookie);
  }
  const method =
    options.method ?? (options.body === undefined ? "GET" : "POST");
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method,
    })
  );
}

function signIn(auth: Auth, options: CallOptions = {}): Promise<Response> {
  return call(auth, "/sign-in/email", {
    body: { email, password },
    ...options,
  });
}

/** The session cookie a sign-in response set, as a Cookie header value. */
function cookieOf(response: Response): string {
  const set = response.headers.get("set-cookie") ?? "";
  const pair = set.split(";")[0] ?? "";
  if (!pair.includes("session_token=")) {
    throw new Error(`no session cookie in ${JSON.stringify(set)}`);
  }
  return pair;
}

/** The session row's token: the signed cookie's value before its signature. */
function tokenOf(cookie: string): string {
  return decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
}

describe("the operator account", () => {
  test("has UUIDv7 ids on its user, account and session rows", async () => {
    const auth = await authWithOperator();
    const response = await signIn(auth);
    expect(response.status).toBe(200);
    const location = open?.location as DatabaseLocation;
    const [user] = await runSql(location, "SELECT id FROM auth_user");
    const [account] = await runSql(location, "SELECT id FROM auth_account");
    const [session] = await runSql(location, "SELECT id FROM auth_session");
    expect(user?.id).toMatch(uuidV7);
    expect(account?.id).toMatch(uuidV7);
    expect(session?.id).toMatch(uuidV7);
  });

  test("is stored in the repo's column conventions: millisecond integers, 0 or 1 booleans, an Argon2id hash", async () => {
    await authWithOperator();
    const location = open?.location as DatabaseLocation;
    const [user] = await runSql(
      location,
      "SELECT email, email_verified, created_at, name FROM auth_user"
    );
    expect(user).toMatchObject({
      email,
      email_verified: 0,
      name: operatorName,
    });
    expect(Number(user?.created_at)).toBeGreaterThan(Date.now() - 60_000);
    const [account] = await runSql(
      location,
      "SELECT password FROM auth_account"
    );
    expect(String(account?.password)).toStartWith("$argon2id$");
  });

  test("the adapter's schema check is registered and finds nothing wrong with the two schema files", async () => {
    const auth = await authWithOperator();
    const context = await auth.$context;
    expect(typeof context.checkSchema).toBe("function");
    expect(await context.checkSchema?.()).toBeUndefined();
  });
});

describe("sign-in", () => {
  test("answers the same 401 for a wrong password and for an unknown email", async () => {
    const auth = await authWithOperator();
    const wrong = await signIn(auth, {
      address: "203.0.113.2",
      body: { email, password: "wrong password" },
    });
    const unknown = await signIn(auth, {
      address: "203.0.113.3",
      body: { email: "nobody@example.com", password },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  test("refuses a request from an origin other than the public address", async () => {
    const auth = await authWithOperator();
    const response = await signIn(auth, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("with no public address stored yet, the request's own origin is accepted", async () => {
    const auth = await authWithOperator({ baseURL: undefined });
    const response = await signIn(auth);
    expect(response.status).toBe(200);
  });

  test("the session cookie is Secure and prefixed only when the public address is https", async () => {
    const plain = await authWithOperator();
    expect(cookieOf(await signIn(plain))).toStartWith("raaqeb.session_token=");
    await open?.storage.close();
    await open?.cleanup();
    open = undefined;
    const secure = await authWithOperator({
      baseURL: "https://status.example.test",
    });
    const response = await signIn(secure, {
      origin: "https://status.example.test",
    });
    const set = response.headers.get("set-cookie") ?? "";
    expect(set).toStartWith("__Secure-raaqeb.session_token=");
    expect(set).toMatch(secureAttribute);
  });
});

describe("the session cookie before onboarding stores a public address", () => {
  test("is decided by the install, never by NODE_ENV: plain until an https address is stored", async () => {
    // Better Auth reads NODE_ENV once at import, so the option itself is pinned: set, and false without an address.
    const plain = await authWithOperator({ baseURL: undefined });
    expect(plain.options.advanced?.useSecureCookies).toBe(false);
    const set = (await signIn(plain)).headers.get("set-cookie") ?? "";
    expect(set).toStartWith("raaqeb.session_token=");
    expect(set).not.toMatch(secureAttribute);
    await open?.storage.close();
    await open?.cleanup();
    open = undefined;
    const secure = await authWithOperator({
      baseURL: "https://status.example.test",
    });
    expect(secure.options.advanced?.useSecureCookies).toBe(true);
  });
});

describe("the rate limit", () => {
  test("is on, in memory, and the fourth sign-in attempt from one address inside ten seconds is a 429", async () => {
    const auth = await authWithOperator();
    expect(auth.options.rateLimit?.enabled).toBe(true);
    expect(auth.options.rateLimit?.storage ?? "memory").toBe("memory");
    const bad = { email, password: "wrong password" };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the limiter counts requests in order
      const response = await signIn(auth, {
        address: "203.0.113.7",
        body: bad,
      });
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
    const fourth = await signIn(auth, { address: "203.0.113.7", body: bad });
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("x-retry-after")).toBeTruthy();
  });

  test("counts per client address, the one the entry resolved, never a header the client sent", async () => {
    const auth = await authWithOperator();
    const bad = { email, password: "wrong password" };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the limiter counts requests in order
      await signIn(auth, { address: "203.0.113.8", body: bad });
    }
    const other = await signIn(auth, { address: "203.0.113.9", body: bad });
    expect(other.status).toBe(401);
    // A forwarded header alone moves nothing: the entry's header is the key.
    const forged = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        body: JSON.stringify(bad),
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": "198.51.100.1",
          [clientAddressHeader]: "203.0.113.8",
        },
        method: "POST",
      })
    );
    expect(forged.status).toBe(429);
  });
});

describe("the disabled endpoints", () => {
  test("every path on the list answers 404 with the body Not Found, under GET and POST", async () => {
    const auth = await authWithOperator();
    const session = cookieOf(await signIn(auth));
    for (const path of disabledPaths) {
      for (const method of ["GET", "POST"] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: one endpoint at a time keeps the failure readable
        const response = await call(auth, path, {
          body: method === "POST" ? {} : undefined,
          cookie: session,
          method,
        });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.text(), `${method} ${path}`).toBe("Not Found");
      }
    }
  });

  test("a route Better Auth mounts with a parameter is Not Found through the handler, since disabledPaths cannot name it", async () => {
    const store = await storage();
    for (const path of [
      "/callback/anything",
      "/reset-password/some-token",
      "/reset-password/some-token?callbackURL=/x",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one path at a time
      const response = await handleAuth(
        store,
        boot,
        new Request(`${origin}/api/auth${path}`)
      );
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("Not Found");
    }
  });

  test("a path Better Auth never mounted is a 404 with an empty body, which tells the two apart", async () => {
    const auth = await authWithOperator();
    const response = await call(auth, "/no-such-endpoint");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("an encoding that folds to a disabled path is still refused", async () => {
    const auth = await authWithOperator();
    for (const path of [
      "/get-session/",
      "/get-session?x=1",
      "/./get-session",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one path at a time
      const response = await call(auth, path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("Not Found");
    }
  });

  test("the server still reads sessions through auth.api although /get-session is disabled over HTTP", async () => {
    const auth = await authWithOperator();
    const session = cookieOf(await signIn(auth));
    const read = await auth.api.getSession({
      headers: new Headers({ cookie: session }),
    });
    expect(read?.user.email).toBe(email);
  });
});

describe("sessions", () => {
  test("last seven days", async () => {
    const auth = await authWithOperator();
    expect(auth.options.session?.expiresIn).toBe(7 * 24 * 60 * 60);
    const before = Date.now();
    const cookie = cookieOf(await signIn(auth));
    const [row] = await runSql(
      open?.location as DatabaseLocation,
      "SELECT expires_at FROM auth_session WHERE token = ?",
      [tokenOf(cookie)]
    );
    const expiresAt = Number(row?.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * day - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7 * day + 1000);
  });

  test("are refreshed once a day of use has passed, not before", async () => {
    const auth = await authWithOperator();
    expect(auth.options.session?.updateAge).toBe(24 * 60 * 60);
    const cookie = cookieOf(await signIn(auth));
    const location = open?.location as DatabaseLocation;
    const token = tokenOf(cookie);
    const read = () =>
      auth.api.getSession({ headers: new Headers({ cookie }) });
    const expiry = async () => {
      const [row] = await runSql(
        location,
        "SELECT expires_at FROM auth_session WHERE token = ?",
        [token]
      );
      return Number(row?.expires_at);
    };
    // Six days and a half left: under a day of use, so nothing moves.
    await runSql(
      location,
      "UPDATE auth_session SET expires_at = ? WHERE token = ?",
      [Date.now() + 6.5 * day, token]
    );
    await read();
    expect(await expiry()).toBeLessThan(Date.now() + 6.6 * day);
    // Five days left: a day of use has passed, so the expiry moves out to seven days again.
    await runSql(
      location,
      "UPDATE auth_session SET expires_at = ? WHERE token = ?",
      [Date.now() + 5 * day, token]
    );
    await read();
    expect(await expiry()).toBeGreaterThan(Date.now() + 6.9 * day);
  });

  test("sign-out over HTTP ends the session", async () => {
    const auth = await authWithOperator();
    const cookie = cookieOf(await signIn(auth));
    const response = await call(auth, "/sign-out", { body: {}, cookie });
    expect(response.status).toBe(200);
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) })
    ).toBeNull();
  });

  test("a password change through the server ends every session, even when the caller asks to keep the others, and answers a new one for the caller", async () => {
    const auth = await authWithOperator();
    const first = cookieOf(await signIn(auth));
    const second = cookieOf(await signIn(auth));
    const changed = await auth.api.changePassword({
      body: {
        currentPassword: password,
        newPassword: "another good password",
        revokeOtherSessions: false,
      },
      headers: new Headers({ cookie: first }),
      returnHeaders: true,
    });
    const ended = await Promise.all(
      [first, second].map((cookie) =>
        auth.api.getSession({ headers: new Headers({ cookie }) })
      )
    );
    expect(ended).toEqual([null, null]);
    const renewed = cookieOf(new Response(null, { headers: changed.headers }));
    const kept = await auth.api.getSession({
      headers: new Headers({ cookie: renewed }),
    });
    expect(kept?.user.email).toBe(email);
  });
});

describe("the instance for an open storage", () => {
  test("is built once and answered again while its settings hold", async () => {
    const store = await storage();
    const a = await authFor(store, boot);
    const b = await authFor(store, boot);
    expect(b).toBe(a);
    expect(await store.settings.get(betterAuthSecrets)).toMatch(
      versionOnePrefix
    );
  });

  test("two first calls at once build one instance and store one secret", async () => {
    const store = await storage();
    const [a, b] = await Promise.all([
      authFor(store, boot),
      authFor(store, boot),
    ]);
    expect(b).toBe(a);
    const stored = await store.settings.get(betterAuthSecrets);
    expect(a.options.secrets).toEqual([
      { value: String(stored).slice(2), version: 1 },
    ]);
  });

  test("is rebuilt when the public address changes: the new address is the base URL and the only trusted origin", async () => {
    const store = await storage();
    const before = await authFor(store, boot);
    expect(before.options.baseURL).toBeUndefined();
    await before.api.signUpEmail({
      body: { email, name: operatorName, password },
    });
    await store.settings.set(publicAddress, "https://status.example.test");
    const after = await authFor(store, boot);
    expect(after).not.toBe(before);
    expect(after.options.baseURL).toBe("https://status.example.test");
    const old = await after.handler(
      new Request("https://status.example.test/api/auth/sign-in/email", {
        body: JSON.stringify({ email, password }),
        headers: {
          "content-type": "application/json",
          origin,
          [clientAddressHeader]: nextAddress(),
        },
        method: "POST",
      })
    );
    expect(old.status).toBe(403);
    const current = await after.handler(
      new Request("https://status.example.test/api/auth/sign-in/email", {
        body: JSON.stringify({ email, password }),
        headers: {
          "content-type": "application/json",
          origin: "https://status.example.test",
          [clientAddressHeader]: nextAddress(),
        },
        method: "POST",
      })
    );
    expect(current.status).toBe(200);
  });

  test("is rebuilt when the secret setting changes", async () => {
    const store = await storage();
    const before = await authFor(store, boot);
    await store.settings.set(
      betterAuthSecrets,
      "2:rotated-rotated-rotated-rotated-rotated,1:old"
    );
    const after = await authFor(store, boot);
    expect(after).not.toBe(before);
    expect(after.options.secrets).toEqual([
      { value: "rotated-rotated-rotated-rotated-rotated", version: 2 },
      { value: "old", version: 1 },
    ]);
  });

  test("takes BETTER_AUTH_SECRETS over the stored secret", async () => {
    const store = await storage();
    const auth = await authFor(store, {
      ...boot,
      betterAuthSecrets: "1:from-the-environment-from-the-environment",
    });
    expect(auth.options.secrets).toEqual([
      { value: "from-the-environment-from-the-environment", version: 1 },
    ]);
    expect(await store.settings.get(betterAuthSecrets)).toBeUndefined();
  });
});

describe("the request handler", () => {
  test("answers 503 with no body while no database is open", async () => {
    const response = await handleAuth(
      undefined,
      boot,
      new Request(`${origin}/api/auth/sign-in/email`, { method: "POST" })
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  test("answers 503 with no body when the database cannot answer, never a thrown error", async () => {
    const store = await storage();
    await store.close();
    const response = await handleAuth(
      store,
      boot,
      new Request(`${origin}/api/auth/sign-in/email`, { method: "POST" })
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  test("hands a request to the storage's instance", async () => {
    const store = await storage();
    await (await authFor(store, boot)).api.signUpEmail({
      body: { email, name: operatorName, password },
    });
    const response = await handleAuth(
      store,
      boot,
      new Request(`${origin}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password }),
        headers: {
          "content-type": "application/json",
          origin,
          [clientAddressHeader]: nextAddress(),
        },
        method: "POST",
      })
    );
    expect(response.status).toBe(200);
    expect(cookieOf(response)).toStartWith("raaqeb.session_token=");
  });
});

describe("the instance's identity and switches", () => {
  test("is named Raaqeb, checks the schema in every environment, and traces nothing", async () => {
    const auth = await authWithOperator();
    expect(auth.options.appName).toBe("Raaqeb");
    expect(auth.options.advanced?.database?.validateSchema).toBe(true);
    expect(auth.options.experimental?.instrumentation?.enabled).toBe(false);
  });
});

describe("sign-in events in the log", () => {
  test("a refused sign-in is one line with the client address and never the email; an accepted one is one line too", async () => {
    const lines: string[] = [];
    const auth = await authWithOperator({ log: (line) => lines.push(line) });
    lines.length = 0;
    await signIn(auth, {
      address: "203.0.113.77",
      body: { email, password: "wrong password" },
    });
    expect(lines).toEqual(["sign-in refused from 203.0.113.77"]);
    lines.length = 0;
    await signIn(auth, { address: "203.0.113.78" });
    expect(lines).toEqual(["sign-in from 203.0.113.78"]);
    expect(lines.join("\n")).not.toContain(email);
  });

  test("with the second step on, the password alone is logged as waiting, and the sign-in once its code passes", async () => {
    const lines: string[] = [];
    const codes: string[] = [];
    const auth = await authWithOperator({
      log: (line) => lines.push(line),
      mail: {
        ...silentMail,
        code: (_to, code) => {
          codes.push(code);
          return Promise.resolve();
        },
      },
    });
    const context = await auth.$context;
    const [user] = await context.internalAdapter.listUsers();
    await context.internalAdapter.updateUser(user?.id ?? "", {
      twoFactorEnabled: true,
    });
    lines.length = 0;
    const pending = await signIn(auth, { address: "203.0.113.79" });
    expect(lines).toEqual([
      "sign-in waits for the second step from 203.0.113.79",
    ]);
    const cookie = (pending.headers.get("set-cookie") ?? "")
      .split(", ")
      .map((value) => value.split(";")[0] ?? "")
      .filter((value) => value.includes("two_factor"))
      .join("; ");
    await call(auth, "/two-factor/send-otp", { body: {}, cookie });
    await mailSettled();
    lines.length = 0;
    await call(auth, "/two-factor/verify-otp", {
      address: "203.0.113.79",
      body: { code: codes[0] === "000000" ? "111111" : "000000" },
      cookie,
    });
    expect(lines).toEqual([
      "sign-in refused at the second step from 203.0.113.79",
    ]);
    lines.length = 0;
    await call(auth, "/two-factor/verify-otp", {
      address: "203.0.113.79",
      body: { code: codes[0] },
      cookie,
    });
    expect(lines).toEqual(["sign-in from 203.0.113.79"]);
  });
});

describe("Better Auth's own log lines", () => {
  test("reach the log the caller gives, prefixed better-auth, at error level only", async () => {
    const lines: string[] = [];
    const auth = await authWithOperator({ log: (line) => lines.push(line) });
    // A weak secret only warns, and warnings are dropped; a refused origin is an error line.
    expect(lines.filter((line) => line.startsWith("better-auth: "))).toEqual(
      []
    );
    await signIn(auth, { origin: "https://evil.example" });
    expect(
      lines.some((line) => line.startsWith("better-auth: Invalid origin"))
    ).toBe(true);
  });

  test("never reach the console beside them: a refused request writes no second line of Better Auth's own", async () => {
    const auth = await authWithOperator();
    const written = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await signIn(auth, { origin: "https://evil.example" });
      await signIn(auth, { body: { email, password: "wrong password" } });
      // An error the auth hooks throw, as the second step's codes do for a signed-in session.
      const cookie = cookieOf(await signIn(auth));
      await call(auth, "/two-factor/send-otp", { body: {}, cookie });
      expect(written.mock.calls.flat().join("\n")).not.toContain(
        "[Better Auth]"
      );
    } finally {
      written.mockRestore();
    }
  });

  test("telemetry is off", async () => {
    const auth = await authWithOperator();
    expect(auth.options.telemetry?.enabled).toBe(false);
  });
});

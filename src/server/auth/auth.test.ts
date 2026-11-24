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
  resetLinkAccount,
  resetLinkOpen,
} from "./auth.ts";
import {
  createKnownBrowsers,
  knownBrowserCookieName,
} from "./known-browsers.ts";
import { disabledPaths } from "./paths.ts";
import { betterAuthSecrets } from "./secret.ts";

// Sign-in, sign-out, sessions, known browsers and password tries over Better Auth's own HTTP
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

// Every call comes from an address of its own, as different visitors would.
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

describe("known browsers and password tries", () => {
  /** The known-browser cookie a response set, as a Cookie header value, and its attributes. */
  const knownOf = (response: Response) => {
    const set = response.headers
      .getSetCookie()
      .find((each) => each.startsWith(`${knownBrowserCookieName}=`));
    return { cookie: set?.split(";")[0], set };
  };
  /** An install whose counts run on a clock the test moves, a second a try unless told. */
  const install = async () => {
    let now = 1_000_000;
    const browsers = createKnownBrowsers(() => now);
    const auth = await authWithOperator({
      installKey: boot.installKey,
      knownBrowsers: browsers,
    });
    const tick = (ms = 1000) => {
      now += ms;
    };
    return { auth, browsers, tick };
  };
  const wrong = { email, password: "not the password" };

  test("a sign-in makes the browser known for its account, renewed at each sign-in, HttpOnly, SameSite=Lax and sent only to Better Auth's addresses; a refused one does not", async () => {
    const { auth, browsers, tick } = await install();
    const first = knownOf(await signIn(auth));
    expect(first.set).toContain("Path=/api/auth");
    expect(first.set).toContain("HttpOnly");
    expect(first.set).toContain("SameSite=Lax");
    expect(first.set).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
    const { internalAdapter } = await auth.$context;
    expect(await browsers.read(boot.installKey, first.cookie ?? null)).toEqual({
      account: (await internalAdapter.findUserByEmail(email))?.user.id ?? "",
    });
    tick();
    const renewed = knownOf(await signIn(auth, { cookie: first.cookie }));
    expect(renewed.cookie).toBeDefined();
    expect(renewed.cookie).not.toBe(first.cookie);
    tick();
    expect(knownOf(await signIn(auth, { body: wrong })).set).toBeUndefined();
  });

  test("an account takes ten tries in a quarter of an hour from browsers not known for it, then each is refused before any hash, as a made-up address is, while a browser known for it signs in", async () => {
    const { auth, tick } = await install();
    const { cookie } = knownOf(await signIn(auth));
    const hashed = spyOn(Bun.password, "verify");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      tick();
      // biome-ignore lint/performance/noAwaitInLoops: one try after another, as a guesser sends them
      statuses.push((await signIn(auth, { body: wrong })).status);
    }
    // The first sign-in was a try from a browser not yet known: nine more were left.
    expect(statuses).toEqual([...new Array(9).fill(401), 429]);
    const hashes = hashed.mock.calls.length;
    tick();
    const refused = await signIn(auth, { body: wrong });
    const unknown = { email: "nobody@example.com", password: "x".repeat(12) };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      tick();
      // biome-ignore lint/performance/noAwaitInLoops: one try after another
      await signIn(auth, { body: unknown });
    }
    tick();
    const made = await signIn(auth, { body: unknown });
    expect([made.status, await made.json()]).toEqual([
      refused.status,
      await refused.json(),
    ]);
    expect(refused.status).toBe(429);
    hashed.mockClear();
    tick();
    await signIn(auth, { body: wrong });
    expect(hashed).not.toHaveBeenCalled();
    expect(hashes).toBeGreaterThan(0);
    hashed.mockRestore();
    tick();
    expect((await signIn(auth, { cookie })).status).toBe(200);
    // A quarter of an hour later the account takes tries again.
    tick(15 * 60 * 1000);
    expect((await signIn(auth, { body: wrong })).status).toBe(401);
  });

  test("past the install's five password checks a second, a try from a browser not known for the account is refused; a known browser's is not", async () => {
    const { auth, tick } = await install();
    const { cookie } = knownOf(await signIn(auth));
    tick();
    const statuses: number[] = [];
    for (let each = 0; each < 6; each += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: within one second, as a flood sends them
      const answer = await signIn(auth, {
        body: { email: `guess${each}@example.com`, password: "x".repeat(12) },
      });
      statuses.push(answer.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await signIn(auth, { cookie })).status).toBe(200);
  });

  test("the install's instance keeps the account's tries when it is rebuilt for a new public address", async () => {
    const store = await storage();
    const auth = await authFor(store, boot);
    await auth.api.signUpEmail({
      body: { email, name: operatorName, password },
    });
    const through = (body: unknown) =>
      handleAuth(
        store,
        boot,
        new Request(`${origin}/api/auth/sign-in/email`, {
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            origin,
            [clientAddressHeader]: nextAddress(),
          },
          method: "POST",
        })
      );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one try after another; the install checks five a second
      await through(wrong);
      await Bun.sleep(210);
    }
    expect((await through({ email, password })).status).toBe(429);
    await store.settings.set(publicAddress, origin);
    expect(await authFor(store, boot)).not.toBe(auth);
    expect((await through({ email, password })).status).toBe(429);
  }, 15_000);

  test("a known browser's cookie ends on the millisecond its 400 days do, and is Secure only on an https address", async () => {
    const { auth, browsers, tick } = await install();
    const { cookie, set } = knownOf(await signIn(auth));
    expect(set).not.toContain("Secure");
    tick(400 * 24 * 60 * 60 * 1000 - 1);
    expect(await browsers.read(boot.installKey, cookie ?? null)).toBeDefined();
    tick(1);
    expect(
      await browsers.read(boot.installKey, cookie ?? null)
    ).toBeUndefined();
    const secure = await authWithOperator({
      baseURL: "https://raaqeb.test",
      installKey: boot.installKey,
    });
    const answer = await call(secure, "/sign-in/email", {
      body: { email, password },
      origin: "https://raaqeb.test",
    });
    expect(knownOf(answer).set).toContain("Secure");
    const unaddressed = await authWithOperator({
      baseURL: undefined,
      installKey: boot.installKey,
    });
    expect(knownOf(await signIn(unaddressed)).set).not.toContain("Secure");
  });

  test("an open reset link names its account and opens; a link no reset wrote, or one past its hour, does neither", async () => {
    const auth = await authWithOperator();
    const { internalAdapter } = await auth.$context;
    const account = await internalAdapter.findUserByEmail(email);
    const now = Date.now();
    await internalAdapter.createVerificationValue({
      expiresAt: new Date(now + 60_000),
      identifier: "reset-password:open-link",
      value: account?.user.id ?? "",
    });
    expect(await resetLinkAccount(auth, "open-link", now)).toBe(
      account?.user.id
    );
    expect(await resetLinkOpen(auth, "open-link", now)).toBe(true);
    expect(await resetLinkAccount(auth, "no-such-link", now)).toBeUndefined();
    expect(await resetLinkOpen(auth, "no-such-link", now)).toBe(false);
    expect(await resetLinkOpen(auth, "open-link", now + 60_000)).toBe(false);
    expect(await resetLinkOpen(auth, "open-link", now + 59_999)).toBe(true);
  });

  test("ten wrong passwords from a known browser for its own account make it a stranger's again, and its tries at another account count as a stranger's", async () => {
    const { auth, browsers, tick } = await install();
    const { cookie } = knownOf(await signIn(auth));
    for (let attempt = 0; attempt < 9; attempt += 1) {
      tick();
      // biome-ignore lint/performance/noAwaitInLoops: one try after another
      await signIn(auth, { body: wrong, cookie });
    }
    expect(await browsers.read(boot.installKey, cookie ?? null)).toBeDefined();
    tick();
    await signIn(auth, { body: wrong, cookie });
    expect(
      await browsers.read(boot.installKey, cookie ?? null)
    ).toBeUndefined();
    // Its wrong tries counted against the browser, not the account's ten from strangers.
    tick();
    expect((await signIn(auth, { body: wrong })).status).toBe(401);
  });
});

describe("the rate limit", () => {
  test("is off in Better Auth, since the entry's rate rules count every request under /api/auth/ before its body is read: a seventh wrong sign-in from one address inside ten seconds still reaches the password check", async () => {
    const auth = await authWithOperator();
    expect(auth.options.rateLimit?.enabled).toBe(false);
    const bad = { email, password: "wrong password" };
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one attempt after another, as a person types them
      const response = await signIn(auth, {
        address: "203.0.113.7",
        body: bad,
      });
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
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

describe("the accounts' roles", () => {
  test("the first account is the install's owner, and a later one a viewer", async () => {
    const auth = await authWithOperator();
    await auth.api.signUpEmail({
      body: { email: "later@example.com", name: "Later", password },
    });
    const rows = await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "SELECT email, role FROM auth_user ORDER BY created_at"
    );
    expect(rows).toEqual([
      { email, role: "owner" },
      { email: "later@example.com", role: "viewer" },
    ]);
  });
});

describe("a deactivated account", () => {
  test("cannot sign in with the right password, and is told so; a wrong one is refused as for anyone", async () => {
    const auth = await authWithOperator();
    const location = open?.location ?? { backend: "sqlite", file: "" };
    // As deactivating does: the mark, and no session left.
    await runSql(location, "UPDATE auth_user SET deactivated_at = 1");
    await runSql(location, "DELETE FROM auth_session");
    const refused = await signIn(auth);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ACCOUNT_DEACTIVATED" });
    expect(refused.headers.get("set-cookie") ?? "").not.toContain(
      "session_token=ey"
    );
    const wrong = await signIn(auth, {
      body: { email, password: "not the password" },
    });
    expect(wrong.status).toBe(401);
    expect(
      await runSql(
        open?.location ?? { backend: "sqlite", file: "" },
        "SELECT id FROM auth_session"
      )
    ).toEqual([]);
  });

  test("signs in again once reactivated", async () => {
    const auth = await authWithOperator();
    const location = open?.location ?? { backend: "sqlite", file: "" };
    await runSql(location, "UPDATE auth_user SET deactivated_at = 1");
    expect((await signIn(auth)).status).toBe(403);
    await runSql(location, "UPDATE auth_user SET deactivated_at = NULL");
    expect((await signIn(auth)).status).toBe(200);
  });
});

describe("the last sign-in", () => {
  test("is recorded when a sign-in makes a session, and not when a password change re-issues one", async () => {
    const auth = await authWithOperator();
    const location = open?.location ?? { backend: "sqlite", file: "" };
    const lastSignIn = async () =>
      Number(
        (
          await runSql(location, "SELECT last_sign_in_at AS at FROM auth_user")
        )[0]?.at ?? 0
      );
    await runSql(location, "UPDATE auth_user SET last_sign_in_at = NULL");
    const before = Date.now();
    const signedIn = await signIn(auth);
    const at = await lastSignIn();
    expect(at).toBeGreaterThanOrEqual(before);
    await runSql(location, "UPDATE auth_user SET last_sign_in_at = 5");
    await auth.api.changePassword({
      body: { currentPassword: password, newPassword: "another good password" },
      headers: new Headers({ cookie: cookieOf(signedIn) }),
    });
    expect(await lastSignIn()).toBe(5);
  });
});

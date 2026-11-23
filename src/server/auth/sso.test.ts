import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readAuditLog, record } from "@/server/audit/audit.ts";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { decrypt } from "@/server/boot/installkey.ts";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { runSql } from "@/server/storage/fixture.ts";
import { transferOwnership } from "@/server/team/team.ts";
import type { SsoInput } from "@/shared/schemas/sso.ts";
import {
  type Auth,
  type AuthBoot,
  authFor,
  createAuth,
  handleAuth,
  operatorName,
} from "./auth.ts";
import {
  accountIdOf,
  call,
  cookiesOf,
  nextAddress,
  type Scratch,
  scratchStorage,
  setsSession,
  silentMail,
  testEmail,
  testOrigin,
  testPassword,
  testSecrets,
} from "./fixture.ts";
import {
  invitationGate,
  invitationTokenHash,
  newInvitationToken,
} from "./invitation.ts";
import {
  type OidcPerson,
  type OidcProviderFixture,
  startOidcProvider,
} from "./oidc-fixture.ts";
import { readOperator } from "./session.ts";
import {
  readSso,
  readSsoOffer,
  readSsoView,
  type SsoProvider,
  saveSso,
  ssoCallbackPath,
  ssoRequired,
  testDiscovery,
} from "./sso.ts";

// Single sign-on against a real OIDC provider on a local port
// (oidc-fixture.ts): the settings that hold it, who may sign up through it,
// linking by a verified address, and the password under single sign-on.
// Over Better Auth's own handler, on both backends.

let provider: OidcProviderFixture;
beforeAll(async () => {
  provider = await startOidcProvider();
});
afterAll(() => {
  provider.stop();
});

let open: Scratch | undefined;
async function scratch(): Promise<Scratch> {
  open = await scratchStorage();
  return open;
}
afterEach(async () => {
  await open?.cleanup();
  open = undefined;
});

function input(over: Partial<SsoInput> = {}): SsoInput {
  return {
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    defaultRole: "viewer",
    discoveryUrl: provider.discoveryUrl,
    domains: [],
    enabled: true,
    name: "Company login",
    requireSso: false,
    roleClaim: "groups",
    roleRules: [{ role: "editor", value: "sre" }],
    signUp: "invitation",
    ...over,
  };
}

function ssoOf(over: Partial<SsoProvider> = {}): SsoProvider {
  const { clientSecret: _secret, ...rest } = input();
  return { ...rest, clientSecret: provider.clientSecret, ...over };
}

/** An instance with the operator (an owner) and single sign-on as given. */
async function ssoAuth(s: Scratch, sso: SsoProvider = ssoOf()): Promise<Auth> {
  const auth = createAuth({
    audit: (event) => record(s.storage, { ...event, now: Date.now() }),
    baseURL: testOrigin,
    database: s.storage.authDatabase,
    invitations: invitationGate(s.storage),
    log: () => undefined,
    mail: silentMail,
    secrets: testSecrets,
    sso,
    ssoRequired: sso.requireSso,
  });
  await auth.api.signUpEmail({
    body: { email: testEmail, name: operatorName, password: testPassword },
  });
  return auth;
}

/** The browser's whole sign-in through the provider as the person: where Raaqeb sends it at the end, and the cookies it set. */
async function ssoSignIn(
  auth: Auth,
  who: OidcPerson
): Promise<{ readonly location: string; readonly response: Response }> {
  provider.signInAs(who);
  const started = await call(auth, "/sign-in/social", {
    body: {
      callbackURL: "/admin",
      errorCallbackURL: "/sign-in",
      provider: "oidc",
    },
  });
  expect(started.status).toBe(200);
  const { url } = await started.json();
  const authorized = await fetch(url, { redirect: "manual" });
  const back = authorized.headers.get("location") ?? "";
  expect(back.startsWith(`${testOrigin}${ssoCallbackPath}?`)).toBe(true);
  const response = await auth.handler(
    new Request(back, {
      headers: {
        cookie: cookiesOf(started),
        [clientAddressHeader]: nextAddress(),
      },
    })
  );
  // Better Auth redirects to the paths the sign-in page gave, relative to the install.
  const location = new URL(
    response.headers.get("location") ?? "",
    testOrigin
  ).toString();
  return { location, response };
}

const person = (over: Partial<OidcPerson> = {}): OidcPerson => ({
  email: "new@example.com",
  emailVerified: true,
  name: "Nadia",
  sub: "nadia",
  ...over,
});

async function invite(s: Scratch, email: string, role: "editor" | "viewer") {
  // The owner sent it: an invitation is open while its sender may still give its role.
  const owner = await s.storage.operatorAccounts.findByEmail(testEmail);
  await s.storage.invitations.put({
    createdAt: Date.now(),
    email,
    expiresAt: Date.now() + 60_000,
    id: `i-${email}`,
    invitedBy: owner?.id ?? null,
    role,
    tokenHash: invitationTokenHash(newInvitationToken()),
  });
}

describe("the provider's settings", () => {
  test("store the client secret sealed with the install key and show it nowhere", async () => {
    const s = await scratch();
    expect(await saveSso(s.storage, s.boot.installKey, input())).toEqual({
      ok: true,
    });
    const [row] = await runSql(
      s.location,
      "SELECT value FROM settings WHERE key = 'sso_provider'"
    );
    const stored = JSON.parse(String(row?.value));
    expect(JSON.stringify(stored)).not.toContain(provider.clientSecret);
    expect(await decrypt(s.boot.installKey, stored.clientSecret)).toBe(
      provider.clientSecret
    );
    const view = await readSsoView(s.storage, testOrigin);
    expect(view).toMatchObject({
      callbackUrl: `${testOrigin}${ssoCallbackPath}`,
      clientId: provider.clientId,
      secretStored: true,
    });
    expect(JSON.stringify(view)).not.toContain(provider.clientSecret);
  });

  test("keep the stored secret when a save leaves it out, and need one the first time", async () => {
    const s = await scratch();
    const { clientSecret: _secret, ...withoutSecret } = input();
    expect(await saveSso(s.storage, s.boot.installKey, withoutSecret)).toEqual({
      ok: false,
      reason: "secret_required",
    });
    await saveSso(s.storage, s.boot.installKey, input());
    expect(
      await saveSso(s.storage, s.boot.installKey, {
        ...withoutSecret,
        name: "Renamed",
      })
    ).toEqual({ ok: true });
    expect(
      (await readSso(s.storage, s.boot.installKey)).provider
    ).toMatchObject({
      clientSecret: provider.clientSecret,
      name: "Renamed",
    });
  });

  test("give an instance no provider while it is off, and the sign-in page no button", async () => {
    const s = await scratch();
    expect(
      (await readSso(s.storage, s.boot.installKey)).provider
    ).toBeUndefined();
    expect(await readSsoOffer(s.storage)).toBeUndefined();
    await saveSso(s.storage, s.boot.installKey, input({ enabled: false }));
    expect(
      (await readSso(s.storage, s.boot.installKey)).provider
    ).toBeUndefined();
    expect(await readSsoOffer(s.storage)).toBeUndefined();
    await saveSso(
      s.storage,
      s.boot.installKey,
      input({ enabled: true, requireSso: true })
    );
    expect(await readSsoOffer(s.storage)).toEqual({
      name: "Company login",
      requireSso: true,
    });
    expect(await readSsoOffer(undefined)).toBeUndefined();
  });

  test("refuse a role rule that would give the owner role, or a domain that is not one", async () => {
    const s = await scratch();
    expect(
      await saveSso(
        s.storage,
        s.boot.installKey,
        // As a hand-made request would post it, past the types.
        JSON.parse(
          JSON.stringify({
            ...input(),
            roleRules: [{ role: "owner", value: "x" }],
          })
        )
      )
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await saveSso(s.storage, s.boot.installKey, {
        ...input(),
        domains: ["not a domain"],
      })
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("the discovery test", () => {
  test("names the issuer of a discovery document with signing keys", async () => {
    expect(await testDiscovery(provider.discoveryUrl, fetch)).toEqual({
      issuer: provider.issuer,
      ok: true,
    });
  });

  test("says when the address answers no discovery document, or nothing at all", async () => {
    expect(
      await testDiscovery(`${provider.issuer}/somewhere-else`, fetch)
    ).toEqual({ ok: false, reason: "not_discovery" });
    expect(await testDiscovery("http://127.0.0.1:1/x", fetch)).toEqual({
      ok: false,
      reason: "unreachable",
    });
    const noKeys: typeof fetch = Object.assign(
      () =>
        Promise.resolve(
          Response.json({
            authorization_endpoint: "https://idp.example/authorize",
            issuer: "https://idp.example",
            token_endpoint: "https://idp.example/token",
          })
        ),
      { preconnect: fetch.preconnect }
    );
    expect(await testDiscovery("https://idp.example/x", noKeys)).toEqual({
      ok: false,
      reason: "no_keys",
    });
  });
});

describe("signing in through the provider", () => {
  test("of an invited address makes the account with the invitation's role, ends the invitation and signs it in", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await invite(s, "new@example.com", "editor");
    const { location, response } = await ssoSignIn(auth, person());
    expect(location).toBe(`${testOrigin}/admin`);
    expect(setsSession(response)).toBe(true);
    expect(
      await s.storage.operatorAccounts.findByEmail("new@example.com")
    ).toMatchObject({ name: "Nadia", role: "editor" });
    expect(await s.storage.invitations.list()).toEqual([]);
    const session = await readOperator(
      auth,
      new Headers({ cookie: cookiesOf(response) })
    );
    expect(session?.operator).toMatchObject({
      role: "editor",
      signedInWith: "oidc",
    });
  });

  test("of an address with no invitation is refused when only those invited may sign up, and makes nothing", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    const { location, response } = await ssoSignIn(auth, person());
    expect(new URL(location).pathname).toBe("/sign-in");
    expect(new URL(location).searchParams.get("error")).toBe("NOT_INVITED");
    expect(setsSession(response)).toBe(false);
    expect(await s.storage.operatorAccounts.list()).toHaveLength(1);
  });

  test("at an allowed domain makes the account with the role its claims map to, else the default role", async () => {
    const s = await scratch();
    const auth = await ssoAuth(
      s,
      ssoOf({
        defaultRole: "responder",
        domains: ["example.com"],
        signUp: "domains",
      })
    );
    await ssoSignIn(auth, person({ claims: { groups: ["sre"] } }));
    expect(
      (await s.storage.operatorAccounts.findByEmail("new@example.com"))?.role
    ).toBe("editor");
    await ssoSignIn(auth, person({ email: "plain@example.com", sub: "plain" }));
    expect(
      (await s.storage.operatorAccounts.findByEmail("plain@example.com"))?.role
    ).toBe("responder");
    const outside = await ssoSignIn(
      auth,
      person({ email: "x@elsewhere.test", sub: "x" })
    );
    expect(new URL(outside.location).searchParams.get("error")).toBe(
      "NOT_INVITED"
    );
  });

  test("of an address that has an account links it when the provider says the address is verified, and signs it in as that account", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    const before = await s.storage.operatorAccounts.findByEmail(testEmail);
    const { location, response } = await ssoSignIn(
      auth,
      person({ email: testEmail, sub: "the-operator" })
    );
    expect(location).toBe(`${testOrigin}/admin`);
    const session = await readOperator(
      auth,
      new Headers({ cookie: cookiesOf(response) })
    );
    expect(session?.operator).toMatchObject({ id: before?.id, role: "owner" });
    expect(await s.storage.operatorAccounts.list()).toHaveLength(1);
  });

  test("of an address that has an account is refused when the provider does not say the address is verified", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    const { location } = await ssoSignIn(
      auth,
      person({ email: testEmail, emailVerified: false, sub: "unverified" })
    );
    expect(new URL(location).searchParams.get("error")).toBe(
      "account_not_linked"
    );
  });

  test("that lands in an account whose address nobody confirmed ends its password and its sessions, which whoever accepted the invitation may hold", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    // Whoever holds the link accepts it: here the sender, not the person at the address.
    const token = newInvitationToken();
    await s.storage.invitations.put({
      createdAt: Date.now(),
      email: "boss@example.com",
      expiresAt: Date.now() + 60_000,
      id: "i-boss",
      invitedBy:
        (await s.storage.operatorAccounts.findByEmail(testEmail))?.id ?? null,
      role: "editor",
      tokenHash: invitationTokenHash(token),
    });
    const planted = await call(auth, "/invitation/accept", {
      body: { name: "Boss", password: testPassword, token },
    });
    expect(setsSession(planted)).toBe(true);
    const made =
      await s.storage.operatorAccounts.findByEmail("boss@example.com");
    const { location, response } = await ssoSignIn(
      auth,
      person({ email: "boss@example.com", sub: "the-boss" })
    );
    expect(location).toBe(`${testOrigin}/admin`);
    const session = await readOperator(
      auth,
      new Headers({ cookie: cookiesOf(response) })
    );
    expect(session?.operator).toMatchObject({ id: made?.id, role: "editor" });
    const password = await call(auth, "/sign-in/email", {
      body: { email: "boss@example.com", password: testPassword },
    });
    expect(setsSession(password)).toBe(false);
    expect(
      await readOperator(auth, new Headers({ cookie: cookiesOf(planted) }))
    ).toBeUndefined();
    // An owner reads in the audit log why the password stopped working.
    const view = await readAuditLog(s.storage, { kind: "password" }, "UTC");
    expect(
      view?.entries.map(({ action, actorEmail, detail, targetId }) => ({
        action,
        actorEmail,
        detail,
        targetId,
      }))
    ).toEqual([
      {
        action: "password.delete",
        actorEmail: "boss@example.com",
        detail: { id: made?.id ?? "", method: "provider" },
        targetId: made?.id ?? "",
      },
    ]);
  });

  test("that is refused to a deactivated account still ends a password nobody confirmed, and says so in the audit log", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await auth.api.signUpEmail({
      body: { email: "boss@example.com", name: "", password: testPassword },
    });
    const made =
      await s.storage.operatorAccounts.findByEmail("boss@example.com");
    await s.storage.operatorAccounts.deactivate(made?.id ?? "", Date.now());
    const { location } = await ssoSignIn(
      auth,
      person({ email: "boss@example.com", sub: "the-boss" })
    );
    expect(location).toContain("error=ACCOUNT_DEACTIVATED");
    const view = await readAuditLog(s.storage, { kind: "password" }, "UTC");
    expect(view?.entries.map((one) => one.action)).toEqual(["password.delete"]);
  });

  test("that links an owner, or an account whose address an emailed code confirmed, keeps its password", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    const token = newInvitationToken();
    await s.storage.invitations.put({
      createdAt: Date.now(),
      email: "huda@example.com",
      expiresAt: Date.now() + 60_000,
      id: "i-huda",
      invitedBy:
        (await s.storage.operatorAccounts.findByEmail(testEmail))?.id ?? null,
      role: "editor",
      tokenHash: invitationTokenHash(token),
    });
    await call(auth, "/invitation/accept", {
      body: { name: "Huda", password: testPassword, token },
    });
    await runSql(
      s.location,
      "UPDATE auth_user SET email_verified = 1 WHERE email = 'huda@example.com'"
    );
    await ssoSignIn(auth, person({ email: "huda@example.com", sub: "huda" }));
    await ssoSignIn(auth, person({ email: testEmail, sub: "the-operator" }));
    for (const email of ["huda@example.com", testEmail]) {
      // biome-ignore lint/performance/noAwaitInLoops: two accounts
      const again = await call(auth, "/sign-in/email", {
        body: { email, password: testPassword },
      });
      expect(setsSession(again)).toBe(true);
    }
  });

  test("of a deactivated account is refused as such", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await runSql(s.location, "UPDATE auth_user SET deactivated_at = 1");
    const { location } = await ssoSignIn(
      auth,
      person({ email: testEmail, sub: "the-operator" })
    );
    expect(new URL(location).searchParams.get("error")).toBe(
      "ACCOUNT_DEACTIVATED"
    );
  });

  test("that is refused is an audit entry naming the address the provider gave and why", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await ssoSignIn(auth, person({ email: "New@Example.com" }));
    await ssoSignIn(
      auth,
      person({ email: "late@example.com", emailVerified: false, sub: "late" })
    );
    await runSql(s.location, "UPDATE auth_user SET deactivated_at = 1");
    await ssoSignIn(auth, person({ email: testEmail, sub: "the-operator" }));
    const view = await readAuditLog(s.storage, { kind: "sign_in" }, "UTC");
    expect(
      view?.entries.map((one) => ({ action: one.action, detail: one.detail }))
    ).toEqual([
      {
        action: "sign_in.refuse",
        detail: {
          email: testEmail,
          method: "provider",
          reason: "ACCOUNT_DEACTIVATED",
        },
      },
      {
        action: "sign_in.refuse",
        detail: {
          email: "late@example.com",
          method: "provider",
          reason: "EMAIL_NOT_VERIFIED",
        },
      },
      {
        action: "sign_in.refuse",
        detail: {
          email: "new@example.com",
          method: "provider",
          reason: "NOT_INVITED",
        },
      },
    ]);
  });

  test("never makes an owner, whatever the claims", async () => {
    const s = await scratch();
    const auth = await ssoAuth(
      s,
      ssoOf({
        domains: ["example.com"],
        roleRules: [{ role: "admin", value: "owners" }],
        signUp: "domains",
      })
    );
    await ssoSignIn(
      auth,
      person({ claims: { groups: ["owners"], role: "owner" } })
    );
    expect(
      (await s.storage.operatorAccounts.findByEmail("new@example.com"))?.role
    ).toBe("admin");
  });
});

describe("starting a sign-in through the provider", () => {
  const start = (auth: Auth, address: string) =>
    call(auth, "/sign-in/social", {
      address,
      body: { callbackURL: "/admin", provider: "oidc" },
    });

  test("is not held to the password sign-in's limit: a team behind one address starts eight in ten seconds", async () => {
    const auth = await ssoAuth(await scratch());
    const statuses: number[] = [];
    for (let started = 0; started < 8; started += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the limiter counts requests in order
      statuses.push((await start(auth, "203.0.113.40")).status);
    }
    expect(statuses).toEqual(new Array(8).fill(200));
  });

  test("is still limited per address: past a hundred in ten seconds the next is a 429", async () => {
    const auth = await ssoAuth(await scratch());
    for (let started = 0; started < 100; started += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the limiter counts requests in order
      await start(auth, "203.0.113.41");
    }
    expect((await start(auth, "203.0.113.41")).status).toBe(429);
    expect((await start(auth, "203.0.113.42")).status).toBe(200);
  });
});

describe("a provider whose id tokens cannot be checked", () => {
  test("whose discovery names no signing keys starts no sign-in", async () => {
    const keyless = await startOidcProvider({ publishesKeys: false });
    try {
      const auth = await ssoAuth(
        await scratch(),
        ssoOf({ discoveryUrl: keyless.discoveryUrl })
      );
      const started = await call(auth, "/sign-in/social", {
        body: { callbackURL: "/admin", provider: "oidc" },
      });
      expect(started.status).toBe(404);
      expect(await started.json()).toMatchObject({
        code: "PROVIDER_NOT_FOUND",
      });
    } finally {
      keyless.stop();
    }
  });
});

describe("the password under single sign-on", () => {
  test("ends the sessions a non-owner opened with a password once an owner requires it, and keeps the owner's and the provider's", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await auth.api.signUpEmail({
      body: { email: "editor@example.com", name: "", password: testPassword },
    });
    const editor = await call(auth, "/sign-in/email", {
      body: { email: "editor@example.com", password: testPassword },
    });
    const owner = await call(auth, "/sign-in/email", {
      body: { email: testEmail, password: testPassword },
    });
    await invite(s, "new@example.com", "editor");
    const { response: throughProvider } = await ssoSignIn(auth, person());
    const read = (signedIn: Response) =>
      readOperator(auth, new Headers({ cookie: cookiesOf(signedIn) }));
    const before = await call(auth, "/sign-in/email", {
      body: { email: "editor@example.com", password: testPassword },
    });
    // A session from before the method was recorded.
    await runSql(
      s.location,
      `UPDATE auth_session SET method = NULL WHERE token = '${decodeURIComponent(cookiesOf(before).split("=")[1] ?? "").split(".")[0]}'`
    );
    await saveSso(s.storage, s.boot.installKey, input());
    expect(await read(editor)).toBeDefined();
    expect(await read(before)).toBeDefined();
    expect(
      await saveSso(s.storage, s.boot.installKey, input({ requireSso: true }))
    ).toEqual({ ok: true });
    expect(await read(editor)).toBeUndefined();
    expect(await read(before)).toBeUndefined();
    expect(await read(owner)).toBeDefined();
    expect(await read(throughProvider)).toBeDefined();
  });
  test("keeps the password sessions open when single sign-on is saved off with Require still switched on", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await auth.api.signUpEmail({
      body: { email: "editor@example.com", name: "", password: testPassword },
    });
    const editor = await call(auth, "/sign-in/email", {
      body: { email: "editor@example.com", password: testPassword },
    });
    const read = () =>
      readOperator(auth, new Headers({ cookie: cookiesOf(editor) }));
    expect(await read()).toBeDefined();
    expect(
      await saveSso(
        s.storage,
        s.boot.installKey,
        input({ enabled: false, requireSso: true })
      )
    ).toEqual({ ok: true });
    expect(await ssoRequired(s.storage)).toBe(false);
    expect(await read()).toBeDefined();
  });

  test("ends the password session of an owner who hands ownership on while it is required, who is then an admin", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await auth.api.signUpEmail({
      body: { email: "next@example.com", name: "", password: testPassword },
    });
    const owner = await call(auth, "/sign-in/email", {
      body: { email: testEmail, password: testPassword },
    });
    const read = () =>
      readOperator(auth, new Headers({ cookie: cookiesOf(owner) }));
    expect(
      await saveSso(s.storage, s.boot.installKey, input({ requireSso: true }))
    ).toEqual({ ok: true });
    expect(await read()).toBeDefined();
    expect(
      await transferOwnership(
        s.storage,
        {
          id:
            (await s.storage.operatorAccounts.findByEmail(testEmail))?.id ?? "",
          role: "owner",
        },
        {
          id:
            (await s.storage.operatorAccounts.findByEmail("next@example.com"))
              ?.id ?? "",
          password: testPassword,
        },
        () => Promise.resolve("right")
      )
    ).toEqual({ ok: true });
    expect(await read()).toBeUndefined();
  });

  test("counts as required at a hand-over of ownership when its stored setting no longer reads", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s);
    await auth.api.signUpEmail({
      body: { email: "next@example.com", name: "", password: testPassword },
    });
    const owner = await call(auth, "/sign-in/email", {
      body: { email: testEmail, password: testPassword },
    });
    await saveSso(s.storage, s.boot.installKey, input());
    await runSql(
      s.location,
      "UPDATE settings SET value = '{\"enabled\":' WHERE key = 'sso_provider'"
    );
    expect(
      await transferOwnership(
        s.storage,
        {
          id:
            (await s.storage.operatorAccounts.findByEmail(testEmail))?.id ?? "",
          role: "owner",
        },
        {
          id:
            (await s.storage.operatorAccounts.findByEmail("next@example.com"))
              ?.id ?? "",
          password: testPassword,
        },
        () => Promise.resolve("right")
      )
    ).toEqual({ ok: true });
    expect(
      await readOperator(auth, new Headers({ cookie: cookiesOf(owner) }))
    ).toBeUndefined();
  });

  test("is refused to an operator who is not an owner once single sign-on is required, after the password was checked", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s, ssoOf({ requireSso: true }));
    await auth.api.signUpEmail({
      body: { email: "editor@example.com", name: "", password: testPassword },
    });
    const refused = await call(auth, "/sign-in/email", {
      body: { email: "editor@example.com", password: testPassword },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "SSO_REQUIRED" });
    const wrong = await call(auth, "/sign-in/email", {
      body: { email: "editor@example.com", password: "a wrong password" },
    });
    expect(wrong.status).toBe(401);
  });

  test("still signs an owner in, the way back in when the provider is down", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s, ssoOf({ requireSso: true }));
    const signedIn = await call(auth, "/sign-in/email", {
      body: { email: testEmail, password: testPassword },
    });
    expect(signedIn.status).toBe(200);
  });

  test("does not accept an invitation for a role that is not an owner's: it is accepted through the provider", async () => {
    const s = await scratch();
    const auth = await ssoAuth(s, ssoOf({ requireSso: true }));
    const token = newInvitationToken();
    await s.storage.invitations.put({
      createdAt: Date.now(),
      email: "new@example.com",
      expiresAt: Date.now() + 60_000,
      id: "i1",
      invitedBy:
        (await s.storage.operatorAccounts.findByEmail(testEmail))?.id ?? null,
      role: "editor",
      tokenHash: invitationTokenHash(token),
    });
    const refused = await call(auth, "/invitation/accept", {
      body: { name: "Nadia", password: testPassword, token },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "SSO_REQUIRED" });
    expect(await s.storage.invitations.list()).toHaveLength(1);
  });
});

describe("required single sign-on whose provider the install cannot use", () => {
  /** A browser's request to the install's /api/auth, through the entry every request takes. */
  function through(s: Scratch, boot: AuthBoot, path: string, body: unknown) {
    return handleAuth(
      s.storage,
      boot,
      new Request(`${testOrigin}/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: testOrigin,
          [clientAddressHeader]: nextAddress(),
        },
        method: "POST",
      })
    );
  }

  /** The owner and an editor with passwords, and an open invitation for a viewer; single sign-on required with the provider as given. */
  async function requiredInstall(over: Partial<SsoInput>): Promise<{
    readonly s: Scratch;
    readonly token: string;
  }> {
    const s = await scratch();
    const auth = await authFor(s.storage, s.boot);
    for (const email of [testEmail, "editor@example.com"]) {
      // biome-ignore lint/performance/noAwaitInLoops: the first account is the owner
      await auth.api.signUpEmail({
        body: { email, name: operatorName, password: testPassword },
      });
    }
    const token = newInvitationToken();
    await s.storage.invitations.put({
      createdAt: Date.now(),
      email: "new@example.com",
      expiresAt: Date.now() + 60_000,
      id: "i1",
      invitedBy: await accountIdOf(s.storage),
      role: "viewer",
      tokenHash: invitationTokenHash(token),
    });
    await saveSso(
      s.storage,
      s.boot.installKey,
      input({ requireSso: true, ...over })
    );
    return { s, token };
  }

  const cases: readonly [
    string,
    Partial<SsoInput>,
    (s: Scratch) => Promise<AuthBoot>,
  ][] = [
    [
      "whose discovery document does not answer",
      { discoveryUrl: "http://127.0.0.1:1/.well-known/openid-configuration" },
      (s) => Promise.resolve(s.boot),
    ],
    [
      "whose client secret will not open with the install key",
      {},
      async (s) => ({ ...s.boot, installKey: await scratchInstallKey() }),
    ],
    [
      "whose stored setting no longer reads",
      {},
      async (s) => {
        await runSql(
          s.location,
          `UPDATE settings SET value = '{"enabled":true}' WHERE key = 'sso_provider'`
        );
        return s.boot;
      },
    ],
  ];
  test("is lifted once single sign-on is turned off, though the setting still says required", async () => {
    const { s } = await requiredInstall({ enabled: false });
    const editor = await through(s, s.boot, "/sign-in/email", {
      email: "editor@example.com",
      password: testPassword,
    });
    expect(editor.status).toBe(200);
  });

  for (const [why, over, spoil] of cases) {
    test(`${why} still refuses the password to every account but an owner's`, async () => {
      const { s, token } = await requiredInstall(over);
      const at = await spoil(s);
      const editor = await through(s, at, "/sign-in/email", {
        email: "editor@example.com",
        password: testPassword,
      });
      expect(editor.status).toBe(403);
      expect(await editor.json()).toMatchObject({ code: "SSO_REQUIRED" });
      expect(setsSession(editor)).toBe(false);
      const accepted = await through(s, at, "/invitation/accept", {
        name: "Nadia",
        password: testPassword,
        token,
      });
      expect(accepted.status).toBe(403);
      expect(await accepted.json()).toMatchObject({ code: "SSO_REQUIRED" });
      expect(await s.storage.invitations.list()).toHaveLength(1);
      const owner = await through(s, at, "/sign-in/email", {
        email: testEmail,
        password: testPassword,
      });
      expect(owner.status).toBe(200);
    });
  }
});

describe("the provider's callback route", () => {
  test("answers only while single sign-on is on; without it, not found as before", async () => {
    const s = await scratch();
    const callback = new Request(`${testOrigin}${ssoCallbackPath}?code=x`);
    expect((await handleAuth(s.storage, s.boot, callback)).status).toBe(404);
    await saveSso(s.storage, s.boot.installKey, input());
    const answered = await handleAuth(
      s.storage,
      s.boot,
      new Request(`${testOrigin}${ssoCallbackPath}?code=x`)
    );
    expect(answered.status).not.toBe(404);
  });
});

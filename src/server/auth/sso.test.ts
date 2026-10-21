import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { decrypt } from "@/server/boot/installkey.ts";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { SsoInput } from "@/shared/schemas/sso.ts";
import { type Auth, createAuth, handleAuth, operatorName } from "./auth.ts";
import {
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
  readSsoOffer,
  readSsoProvider,
  readSsoView,
  type SsoProvider,
  saveSso,
  ssoCallbackPath,
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
    baseURL: testOrigin,
    database: s.storage.authDatabase,
    invitations: invitationGate(s.storage),
    log: () => undefined,
    mail: silentMail,
    secrets: testSecrets,
    sso,
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
    expect(await readSsoProvider(s.storage, s.boot.installKey)).toMatchObject({
      clientSecret: provider.clientSecret,
      name: "Renamed",
    });
  });

  test("give an instance no provider while it is off, and the sign-in page no button", async () => {
    const s = await scratch();
    expect(await readSsoProvider(s.storage, s.boot.installKey)).toBeUndefined();
    expect(await readSsoOffer(s.storage)).toBeUndefined();
    await saveSso(s.storage, s.boot.installKey, input({ enabled: false }));
    expect(await readSsoProvider(s.storage, s.boot.installKey)).toBeUndefined();
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

describe("the password under single sign-on", () => {
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

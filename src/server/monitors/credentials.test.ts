import { describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import {
  credentialsView,
  mergeCredentials,
  openCredentials,
  sealCredentials,
} from "./credentials.ts";

const stored: Credentials = {
  auth: { kind: "basic", password: "كلمة-سر", user: "operator-account" },
  headers: [
    { name: "X-Api-Key", value: "key-1" },
    { name: "X-Tenant", value: "raaqeb" },
  ],
};

describe("merging the posted credentials with the stored ones", () => {
  test("a left-out password keeps the stored one, even under a new user name", () => {
    expect(
      mergeCredentials(
        { auth: { kind: "basic", user: "operator-two" }, headers: [] },
        stored
      )
    ).toEqual({
      auth: { kind: "basic", password: "كلمة-سر", user: "operator-two" },
      headers: [],
    });
  });

  test("a typed secret replaces the stored one", () => {
    expect(
      mergeCredentials(
        {
          auth: { kind: "basic", password: "new", user: "operator-account" },
          headers: [{ name: "X-Api-Key", value: "key-2" }],
        },
        stored
      )
    ).toEqual({
      auth: { kind: "basic", password: "new", user: "operator-account" },
      headers: [{ name: "X-Api-Key", value: "key-2" }],
    });
  });

  test("a left-out header value keeps the stored value of the header with that name, whatever its case", () => {
    expect(
      mergeCredentials(
        { headers: [{ name: "X-TENANT" }, { name: "X-New", value: "n" }] },
        stored
      )
    ).toEqual({
      auth: undefined,
      headers: [
        { name: "X-TENANT", value: "raaqeb" },
        { name: "X-New", value: "n" },
      ],
    });
  });

  test("a header or an auth the form no longer posts is dropped", () => {
    expect(mergeCredentials({ headers: [] }, stored)).toEqual({
      auth: undefined,
      headers: [],
    });
  });

  test("a typed empty password is a password, not a left-out one", () => {
    expect(
      mergeCredentials(
        {
          auth: { kind: "basic", password: "", user: "operator-account" },
          headers: [],
        },
        stored
      )?.auth
    ).toEqual({ kind: "basic", password: "", user: "operator-account" });
  });

  test("a left-out token keeps the stored bearer token", () => {
    expect(
      mergeCredentials(
        { auth: { kind: "bearer" }, headers: [] },
        { auth: { kind: "bearer", token: "tok" }, headers: [] }
      )
    ).toEqual({ auth: { kind: "bearer", token: "tok" }, headers: [] });
  });

  test("a left-out secret with nothing of its kind stored is refused", () => {
    expect(
      mergeCredentials({ auth: { kind: "bearer" }, headers: [] }, stored)
    ).toBe(undefined);
    expect(
      mergeCredentials(
        { auth: { kind: "basic", user: "operator-account" }, headers: [] },
        {
          auth: { kind: "bearer", token: "tok" },
          headers: [],
        }
      )
    ).toBe(undefined);
    expect(mergeCredentials({ headers: [{ name: "X-Other" }] }, stored)).toBe(
      undefined
    );
    expect(
      mergeCredentials(
        { auth: { kind: "basic", user: "operator-account" }, headers: [] },
        undefined
      )
    ).toBe(undefined);
  });
});

describe("sealing credentials with the install key", () => {
  test("a sealed value opens with the same key to what was sealed", async () => {
    const key = await scratchInstallKey();
    const sealed = await sealCredentials(key, stored);
    expect(sealed).toBeDefined();
    expect(await openCredentials(key, sealed ?? "")).toEqual(stored);
  });

  test("the sealed text holds no secret and no header name in clear", async () => {
    const key = await scratchInstallKey();
    const sealed = (await sealCredentials(key, stored)) ?? "";
    for (const clear of [
      "كلمة-سر",
      "operator-account",
      "key-1",
      "X-Api-Key",
      "raaqeb",
    ]) {
      expect(sealed.includes(clear)).toBe(false);
    }
  });

  test("no auth and no headers seal to nothing, so the column stays empty", async () => {
    const key = await scratchInstallKey();
    expect(await sealCredentials(key, { headers: [] })).toBe(undefined);
  });

  test("a database monitor's connection URL alone seals, holds nothing of the URL in clear, and opens to it", async () => {
    const key = await scratchInstallKey();
    const url = "postgres://watcher:s3cret@db.example.test:5432/app";
    const sealed = (await sealCredentials(key, { headers: [], url })) ?? "";
    expect(sealed).not.toBe("");
    for (const clear of ["s3cret", "watcher", "db.example.test", "postgres"]) {
      expect(sealed.includes(clear)).toBe(false);
    }
    expect(await openCredentials(key, sealed)).toEqual({ headers: [], url });
  });

  test("another install's key, a tampered value, or a value that no longer fits the shape opens to nothing", async () => {
    const key = await scratchInstallKey();
    const other = await scratchInstallKey();
    const sealed = (await sealCredentials(key, stored)) ?? "";
    expect(await openCredentials(other, sealed)).toBe(undefined);
    expect(await openCredentials(key, `${sealed.slice(0, -2)}AA`)).toBe(
      undefined
    );
    expect(
      await openCredentials(key, await encrypt(key, '{"auth":{"kind":"x"}}'))
    ).toBe(undefined);
    expect(await openCredentials(key, await encrypt(key, "not json"))).toBe(
      undefined
    );
  });
});

describe("what the edit form reads of the credentials", () => {
  test("is the auth kind, the user name and the header names, never a password, a token or a value", () => {
    const view = credentialsView(stored);
    expect(view).toEqual({
      auth: { kind: "basic", user: "operator-account" },
      headers: [{ name: "X-Api-Key" }, { name: "X-Tenant" }],
      url: false,
    });
    expect(JSON.stringify(view).includes("كلمة-سر")).toBe(false);
    expect(
      credentialsView({ auth: { kind: "bearer", token: "tok" }, headers: [] })
    ).toEqual({ auth: { kind: "bearer" }, headers: [], url: false });
  });

  test("says a connection URL is stored, never what it is", () => {
    const view = credentialsView({
      headers: [],
      url: "redis://:s3cret@cache.example.test:6379",
    });
    expect(view).toEqual({ auth: undefined, headers: [], url: true });
    expect(JSON.stringify(view)).not.toContain("cache.example.test");
  });

  test("is empty when nothing is stored", () => {
    expect(credentialsView(undefined)).toEqual({
      auth: undefined,
      headers: [],
      url: false,
    });
  });
});

describe("the credentials of an HTTP monitor's own proxy", () => {
  const withProxy: Credentials = {
    headers: [],
    proxyAuth: { password: "pässword", user: "ops" },
  };

  test("a left-out proxy password keeps the stored one, even under a new user name", () => {
    expect(
      mergeCredentials(
        { headers: [], proxyAuth: { user: "ops-two" } },
        withProxy
      )
    ).toEqual({
      auth: undefined,
      headers: [],
      proxyAuth: { password: "pässword", user: "ops-two" },
    });
  });

  test("a typed proxy password replaces the stored one", () => {
    expect(
      mergeCredentials(
        { headers: [], proxyAuth: { password: "new", user: "ops" } },
        withProxy
      )
    ).toEqual({
      auth: undefined,
      headers: [],
      proxyAuth: { password: "new", user: "ops" },
    });
  });

  test("a left-out proxy password with none stored is refused, as a basic auth's is", () => {
    expect(
      mergeCredentials({ headers: [], proxyAuth: { user: "ops" } }, undefined)
    ).toBeUndefined();
    expect(
      mergeCredentials({ headers: [], proxyAuth: { user: "ops" } }, stored)
    ).toBeUndefined();
  });

  test("posting no proxy credentials drops the stored ones", () => {
    expect(mergeCredentials({ headers: [] }, withProxy)).toEqual({
      auth: undefined,
      headers: [],
    });
  });

  test("proxy credentials alone are sealed, and open to the same", async () => {
    const key = await scratchInstallKey();
    const sealed = await sealCredentials(key, withProxy);
    expect(sealed).toBeDefined();
    expect(sealed).not.toContain("pässword");
    expect(await openCredentials(key, sealed ?? "")).toEqual(withProxy);
  });

  test("the form reads the proxy's user name, never its password", () => {
    const view = credentialsView(withProxy);
    expect(view.proxyUser).toBe("ops");
    expect(JSON.stringify(view)).not.toContain("pässword");
    expect(credentialsView(stored).proxyUser).toBeUndefined();
    expect(credentialsView(undefined).proxyUser).toBeUndefined();
  });
});

describe("the credentials of an HTTP monitor's client certificate", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
  const newKey =
    "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n";
  const withKey: Credentials = {
    clientKey: { key, passphrase: "pässphrase" },
    headers: [],
  };

  test("a left-out key keeps the stored key and its passphrase", () => {
    expect(mergeCredentials({ clientKey: {}, headers: [] }, withKey)).toEqual({
      auth: undefined,
      clientKey: { key, passphrase: "pässphrase" },
      headers: [],
    });
  });

  test("a typed passphrase beside a kept key replaces only the passphrase", () => {
    expect(
      mergeCredentials(
        { clientKey: { passphrase: "new" }, headers: [] },
        withKey
      )
    ).toEqual({
      auth: undefined,
      clientKey: { key, passphrase: "new" },
      headers: [],
    });
  });

  test("a typed key replaces the stored key and its passphrase, so a key with none leaves none", () => {
    expect(
      mergeCredentials({ clientKey: { key: newKey }, headers: [] }, withKey)
    ).toEqual({ auth: undefined, clientKey: { key: newKey }, headers: [] });
  });

  test("a typed key with a typed passphrase stores both", () => {
    expect(
      mergeCredentials(
        { clientKey: { key: newKey, passphrase: "typed" }, headers: [] },
        withKey
      )
    ).toEqual({
      auth: undefined,
      clientKey: { key: newKey, passphrase: "typed" },
      headers: [],
    });
  });

  test("a key left out with none stored has nothing to keep, and the certificate is left without one", () => {
    expect(mergeCredentials({ clientKey: {}, headers: [] }, undefined)).toEqual(
      { auth: undefined, headers: [] }
    );
    expect(
      mergeCredentials({ clientKey: { passphrase: "x" }, headers: [] }, stored)
    ).toMatchObject({ headers: [] });
    expect(
      mergeCredentials({ clientKey: { passphrase: "x" }, headers: [] }, stored)
    ).not.toHaveProperty("clientKey");
  });

  test("a post with no key drops the stored one", () => {
    expect(mergeCredentials({ headers: [] }, withKey)).toEqual({
      auth: undefined,
      headers: [],
    });
  });

  test("is sealed with the rest and opens again, and a monitor with only a key has something to seal", async () => {
    const installKey = await scratchInstallKey();
    const sealed = await sealCredentials(installKey, withKey);
    expect(sealed).toBeDefined();
    expect(sealed).not.toContain("AAAA");
    expect(await openCredentials(installKey, sealed ?? "")).toEqual(withKey);
  });

  test("shows the form that a key is stored, never the key or its passphrase", () => {
    const view = credentialsView(withKey);
    expect(view.clientKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain("AAAA");
    expect(JSON.stringify(view)).not.toContain("pässphrase");
    expect(credentialsView(stored).clientKey).toBeUndefined();
  });
});

describe("the credentials of an HTTP monitor's OAuth 2.0 grant", () => {
  const oauth = {
    audience: "https://api.example.test",
    clientId: "raaqeb",
    clientSecret: "pässword-secret",
    kind: "oauth2" as const,
    method: "basic" as const,
    scope: "read",
    tokenUrl: "https://idp.example.test/token",
  };
  const withGrant: Credentials = { auth: oauth, headers: [] };
  const { clientSecret: _, ...postable } = oauth;

  test("a left-out secret keeps the stored one, under a new client ID, scope and method", () => {
    expect(
      mergeCredentials(
        {
          auth: {
            ...postable,
            clientId: "other",
            method: "body",
            scope: "write",
          },
          headers: [],
        },
        withGrant
      )
    ).toEqual({
      auth: { ...oauth, clientId: "other", method: "body", scope: "write" },
      headers: [],
    });
  });

  test("a typed secret replaces the stored one", () => {
    expect(
      mergeCredentials(
        { auth: { ...postable, clientSecret: "new" }, headers: [] },
        withGrant
      )?.auth
    ).toEqual({ ...oauth, clientSecret: "new" });
  });

  test("a left-out secret has nothing to keep when none, or another kind of auth, is stored", () => {
    expect(
      mergeCredentials({ auth: postable, headers: [] }, undefined)
    ).toBeUndefined();
    expect(mergeCredentials({ auth: postable, headers: [] }, stored)).toBe(
      undefined
    );
  });

  test("is sealed with the rest and opens again", async () => {
    const key = await scratchInstallKey();
    const sealed = await sealCredentials(key, withGrant);
    expect(sealed).not.toContain("pässword-secret");
    expect(await openCredentials(key, sealed ?? "")).toEqual(withGrant);
  });

  test("shows the form the endpoint, the client ID, the scope, the audience and the method, never the secret", () => {
    const view = credentialsView(withGrant);
    expect(view.auth).toEqual({
      audience: "https://api.example.test",
      clientId: "raaqeb",
      kind: "oauth2",
      method: "basic",
      scope: "read",
      tokenUrl: "https://idp.example.test/token",
    });
    expect(JSON.stringify(view)).not.toContain("pässword-secret");
  });
});

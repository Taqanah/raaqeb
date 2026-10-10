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

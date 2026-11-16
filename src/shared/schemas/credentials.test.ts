import { describe, expect, test } from "bun:test";
import {
  credentialsInputSchema,
  credentialsSchema,
  headersMax,
} from "./credentials.ts";

describe("an HTTP monitor's credentials", () => {
  test("are basic auth or a bearer token, and custom headers, none by default", () => {
    expect(credentialsSchema.parse({})).toEqual({ headers: [] });
    expect(
      credentialsSchema.parse({
        auth: { kind: "basic", password: "سر", user: "ops" },
        headers: [{ name: "X-Api-Key", value: "k1" }],
      })
    ).toEqual({
      auth: { kind: "basic", password: "سر", user: "ops" },
      headers: [{ name: "X-Api-Key", value: "k1" }],
    });
    expect(
      credentialsSchema.parse({ auth: { kind: "bearer", token: "t" } }).auth
    ).toEqual({ kind: "bearer", token: "t" });
  });

  test("a basic user name is never empty and never holds a colon, which would end it early on the wire (RFC 7617)", () => {
    for (const user of ["", "ops:admin"]) {
      expect(
        credentialsSchema.safeParse({
          auth: { kind: "basic", password: "p", user },
        }).success
      ).toBe(false);
    }
  });

  test("a bearer token is never empty", () => {
    expect(
      credentialsSchema.safeParse({ auth: { kind: "bearer", token: "" } })
        .success
    ).toBe(false);
  });

  test("a header name is a token and a header value is one line", () => {
    const header = (name: string, value: string) =>
      credentialsSchema.safeParse({ headers: [{ name, value }] }).success;
    expect(header("X-Api-Key", "abc")).toBe(true);
    expect(header("X Api", "abc")).toBe(false);
    expect(header("", "abc")).toBe(false);
    expect(header("X-Api-Key", "a\r\nSet-Cookie: x=1")).toBe(false);
    expect(header("X-Api-Key", "a\nb")).toBe(false);
    expect(header("X-Api-Key", "a\u0000b")).toBe(false);
  });

  test("a header is named once, whatever its case, so a kept value is found by its name", () => {
    expect(
      credentialsSchema.safeParse({
        headers: [
          { name: "X-Api-Key", value: "a" },
          { name: "x-api-key", value: "b" },
        ],
      }).success
    ).toBe(false);
    expect(
      credentialsInputSchema.safeParse({
        headers: [{ name: "X-Api-Key" }, { name: "X-API-KEY", value: "b" }],
      }).success
    ).toBe(false);
  });

  test(`holds at most ${headersMax} headers`, () => {
    const headers = Array.from({ length: headersMax + 1 }, (_, index) => ({
      name: `X-H${index}`,
      value: "v",
    }));
    expect(credentialsSchema.safeParse({ headers }).success).toBe(false);
    expect(
      credentialsSchema.safeParse({ headers: headers.slice(1) }).success
    ).toBe(true);
  });
});

describe("the credentials the form posts", () => {
  test("may leave out a password, a token or a header value, which keeps the stored one", () => {
    expect(
      credentialsInputSchema.parse({
        auth: { kind: "basic", user: "ops" },
        headers: [{ name: "X-Api-Key" }],
      })
    ).toEqual({
      auth: { kind: "basic", user: "ops" },
      headers: [{ name: "X-Api-Key" }],
    });
    expect(
      credentialsInputSchema.parse({ auth: { kind: "bearer" } }).auth
    ).toEqual({ kind: "bearer" });
  });

  test("still refuses what the stored shape refuses", () => {
    expect(
      credentialsInputSchema.safeParse({
        auth: { kind: "basic", user: "a:b" },
      }).success
    ).toBe(false);
    expect(
      credentialsInputSchema.safeParse({
        headers: [{ name: "X-Api-Key", value: "a\r\nb" }],
      }).success
    ).toBe(false);
    expect(
      credentialsInputSchema.safeParse({ auth: { kind: "bearer", token: "" } })
        .success
    ).toBe(false);
  });
});

describe("an HTTP monitor's credentials: edge cases", () => {
  test("a header value or a bearer token is Latin-1 only, since the platform refuses anything above U+00FF and names the value in its error", () => {
    const header = (value: string) =>
      credentialsSchema.safeParse({ headers: [{ name: "X-Key", value }] })
        .success;
    expect(header("café\tlatte")).toBe(true);
    expect(header("مفتاح-سري")).toBe(false);
    expect(header("tok€n")).toBe(false);
    const token = (value: string) =>
      credentialsSchema.safeParse({ auth: { kind: "bearer", token: value } })
        .success;
    expect(token("abc.DEF-123")).toBe(true);
    expect(token("رمز")).toBe(false);
    expect(token("a\nb")).toBe(false);
    expect(
      credentialsInputSchema.safeParse({
        auth: { kind: "bearer", token: "رمز" },
      }).success
    ).toBe(false);
  });

  test("a basic password may hold any character: it travels as UTF-8 in base64", () => {
    expect(
      credentialsSchema.safeParse({
        auth: { kind: "basic", password: "كلمة-سر", user: "مشغل" },
      }).success
    ).toBe(true);
  });
});

describe("a basic user name", () => {
  test("a basic user name of spaces only is refused like an empty one", () => {
    expect(
      credentialsSchema.safeParse({
        auth: { kind: "basic", password: "x", user: "   " },
      }).success
    ).toBe(false);
    expect(
      credentialsInputSchema.safeParse({ auth: { kind: "basic", user: " \t" } })
        .success
    ).toBe(false);
  });
});

describe("OAuth 2.0 client credentials", () => {
  const grant = {
    clientId: "raaqeb",
    clientSecret: "s3cret",
    kind: "oauth2",
    tokenUrl: "https://idp.example.test/oauth/token",
  } as const;

  test("are a token URL, a client ID and a secret, with a scope, an audience and a client authentication method that is HTTP basic by default", () => {
    expect(credentialsSchema.parse({ auth: grant }).auth).toEqual({
      ...grant,
      method: "basic",
    });
    expect(
      credentialsSchema.parse({
        auth: {
          ...grant,
          audience: "https://api.example.test",
          method: "body",
          scope: "read write",
        },
      }).auth
    ).toMatchObject({
      audience: "https://api.example.test",
      method: "body",
      scope: "read write",
    });
  });

  test("refuse a token URL that is not http or https or carries a user name or a password, an empty client ID or secret, and a method it does not know", () => {
    for (const bad of [
      { tokenUrl: "ftp://idp.example.test/token" },
      { tokenUrl: "not a url" },
      { tokenUrl: "https://user:pw@idp.example.test/token" },
      { tokenUrl: "https://user@idp.example.test/token" },
      { tokenUrl: "https://:pw@idp.example.test/token" },
      { clientId: "  " },
      { clientSecret: "" },
      { method: "header" },
      { scope: "  " },
    ]) {
      expect(
        credentialsSchema.safeParse({ auth: { ...grant, ...bad } }).success,
        JSON.stringify(bad)
      ).toBe(false);
    }
  });

  test("the form may leave the secret out, which keeps the stored one", () => {
    const { clientSecret: _, ...withoutSecret } = grant;
    expect(
      credentialsInputSchema.safeParse({ auth: withoutSecret }).success
    ).toBe(true);
    expect(
      credentialsInputSchema.safeParse({
        auth: { ...withoutSecret, clientSecret: "" },
      }).success
    ).toBe(false);
  });
});

describe("a client key that must start with its armour", () => {
  test("is refused when anything comes before it", () => {
    const key =
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    expect(
      credentialsSchema.safeParse({ clientKey: { key }, headers: [] }).success
    ).toBe(true);
    for (const before of ["Bag Attributes\n", " ", "text "]) {
      expect(
        credentialsSchema.safeParse({
          clientKey: { key: `${before}${key}` },
          headers: [],
        }).success,
        JSON.stringify(before)
      ).toBe(false);
    }
  });
});

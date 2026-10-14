import { describe, expect, test } from "bun:test";
import { isOrigin, movesSignInAway, publicAddressSchema } from "./address.ts";

describe("an origin", () => {
  test.each([
    "https://status.example.test",
    "http://localhost:3000",
    "http://127.0.0.1:3210",
    "https://[::1]:8443",
  ])("accepts %s", (value) => {
    expect(isOrigin(value)).toBe(true);
    expect(publicAddressSchema.safeParse(value).success).toBe(true);
  });

  test.each([
    ["a trailing slash", "https://status.example.test/"],
    ["a path", "https://status.example.test/status"],
    ["a query", "https://status.example.test?x=1"],
    ["a fragment", "https://status.example.test#top"],
    ["credentials", "https://user:pass@status.example.test"],
    ["a bare host", "status.example.test"],
    ["another scheme", "ftp://status.example.test"],
    ["upper-case scheme or host", "HTTPS://Status.Example.test"],
    ["surrounding space", " https://status.example.test"],
    ["empty", ""],
  ])("refuses %s", (_label, value) => {
    expect(isOrigin(value)).toBe(false);
    expect(publicAddressSchema.safeParse(value).success).toBe(false);
  });
});

describe("a public address that moves sign-in away from this page", () => {
  const here = "http://192.0.2.10:3210";
  const stored = "https://status.example.test";

  test("is a new address that is not where the browser is", () => {
    expect(movesSignInAway("https://other.example.test", stored, here)).toBe(
      true
    );
  });

  test("is not the address the browser is at, which sign-in keeps working from", () => {
    expect(movesSignInAway(here, stored, here)).toBe(false);
  });

  test("is not the stored address, which sign-in already follows", () => {
    expect(movesSignInAway(stored, stored, here)).toBe(false);
  });

  test("is not a text that is no origin, which the field refuses on its own", () => {
    expect(movesSignInAway("https://other.example.test/", stored, here)).toBe(
      false
    );
    expect(movesSignInAway("", stored, here)).toBe(false);
  });

  test("reads the typed address without its surrounding space, as the save does", () => {
    expect(movesSignInAway(" https://other.example.test ", stored, here)).toBe(
      true
    );
  });
});

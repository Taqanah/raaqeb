import { describe, expect, test } from "bun:test";
import { isOrigin, publicAddressSchema } from "./address.ts";

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

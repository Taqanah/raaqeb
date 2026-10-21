import { describe, expect, test } from "bun:test";
import { atDomain, roleOfClaims } from "./sso.ts";

describe("the role a provider's claims give", () => {
  const rules = [
    { role: "viewer", value: "staff" },
    { role: "admin", value: "raaqeb-admins" },
    { role: "editor", value: "sre" },
  ] as const;

  test("is the most powerful role among the rules whose value the claim holds, as a list or a string", () => {
    expect(
      roleOfClaims(rules, "groups", { groups: ["staff", "sre", "other"] })
    ).toBe("editor");
    expect(
      roleOfClaims(rules, "groups", { groups: ["raaqeb-admins", "staff"] })
    ).toBe("admin");
    expect(roleOfClaims(rules, "role", { role: "sre" })).toBe("editor");
  });

  test("is nothing for no claim named, a claim absent, a value matched by no rule, or a claim of another type", () => {
    expect(roleOfClaims(rules, "", { groups: ["sre"] })).toBeUndefined();
    expect(roleOfClaims(rules, "groups", {})).toBeUndefined();
    expect(
      roleOfClaims(rules, "groups", { groups: ["nobody"] })
    ).toBeUndefined();
    expect(roleOfClaims(rules, "groups", { groups: 7 })).toBeUndefined();
    expect(roleOfClaims([], "groups", { groups: ["sre"] })).toBeUndefined();
  });

  test("matches a value as it is written, case and all", () => {
    expect(roleOfClaims(rules, "groups", { groups: ["SRE"] })).toBeUndefined();
  });
});

describe("whether an address is at an allowed domain", () => {
  test("is a whole match of the part after the @, whatever its case", () => {
    expect(atDomain(["example.com"], "ops@example.com")).toBe(true);
    expect(atDomain(["example.com"], "Ops@Example.COM")).toBe(true);
    expect(atDomain(["a.test", "example.com"], "x@example.com")).toBe(true);
  });

  test("lets in neither a longer domain nor a subdomain, nor anything with no domain listed", () => {
    expect(atDomain(["example.com"], "ops@notexample.com")).toBe(false);
    expect(atDomain(["example.com"], "ops@mail.example.com")).toBe(false);
    expect(atDomain(["example.com"], "example.com@evil.test")).toBe(false);
    expect(atDomain([], "ops@example.com")).toBe(false);
    expect(atDomain(["example.com"], "not an address")).toBe(false);
  });
});

/**
 * Single sign-on's pure rules (CONTEXT.md "Single sign-on"): which role a
 * provider's claims give an account signing up, and whether an address is
 * at one of the domains that may sign up. No I/O.
 */
import type { SsoRole, SsoRoleRule } from "@/shared/schemas/sso.ts";
import { roles } from "./roles.ts";

/** The claim's values: a string alone, the strings of a list, or none. */
function valuesOf(claim: unknown): readonly string[] {
  if (typeof claim === "string") {
    return [claim];
  }
  return Array.isArray(claim)
    ? claim.filter((value): value is string => typeof value === "string")
    : [];
}

/**
 * The role the claims give: of the rules whose value the claim holds (a
 * string, or one of a list), the most powerful one's; nothing when the claim
 * is unnamed, absent or matches no rule.
 */
export function roleOfClaims(
  rules: readonly SsoRoleRule[],
  claim: string,
  claims: Readonly<Record<string, unknown>>
): SsoRole | undefined {
  if (claim === "") {
    return;
  }
  const held = new Set(valuesOf(claims[claim]));
  const matched = rules.filter((rule) => held.has(rule.value));
  // Roles run most powerful first, so the earliest matched is the one.
  return matched.toSorted(
    (a, b) => roles.indexOf(a.role) - roles.indexOf(b.role)
  )[0]?.role;
}

/** Whether the address is at one of the domains, matched whole and without regard to case: `example.com` lets in `ops@example.com`, not `ops@notexample.com` nor `ops@mail.example.com`. */
export function atDomain(domains: readonly string[], email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) {
    return false;
  }
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((allowed) => allowed.toLowerCase() === domain);
}

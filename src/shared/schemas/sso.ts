/**
 * Single sign-on's shapes (CONTEXT.md "Single sign-on", "Identity
 * provider"): the one OIDC provider an owner sets up, who may sign up
 * through it, how its claims map to roles, and whether the password is
 * still taken; what the settings page posts; what the sign-in page offers;
 * and the refusals each words through the catalog (ADR-0004).
 */
import { z } from "zod";

/** The roles single sign-on may give: never the owner's, which an owner alone gives. */
export const ssoRoleSchema = z.enum(["admin", "editor", "responder", "viewer"]);
export type SsoRole = z.infer<typeof ssoRoleSchema>;
export const ssoRoles: readonly SsoRole[] = ssoRoleSchema.options;

/** Who may make an account by signing in with the provider: only those invited, or also anyone at the listed email domains. */
export const ssoSignUps = ["invitation", "domains"] as const;
export const ssoSignUpSchema = z.enum(ssoSignUps);
export type SsoSignUp = z.infer<typeof ssoSignUpSchema>;

/** A domain as typed: lower case, no `@`, at least one dot. */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/);

/** One claim value and the role an account signing up with it gets. */
export const ssoRoleRuleSchema = z.object({
  role: ssoRoleSchema,
  value: z.string().trim().min(1).max(200),
});
export type SsoRoleRule = z.infer<typeof ssoRoleRuleSchema>;

/** What the settings page posts; the client secret, left out, keeps the stored one. */
export const ssoInputSchema = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(2000).optional(),
  defaultRole: ssoRoleSchema,
  discoveryUrl: z.url({ protocol: /^https?$/ }).max(2000),
  domains: z.array(domainSchema).max(50),
  enabled: z.boolean(),
  /** The button's words: "Continue with <name>". */
  name: z.string().trim().min(1).max(60),
  requireSso: z.boolean(),
  /** The claim the rules read, such as `groups` or `roles`; empty for none. */
  roleClaim: z.string().trim().max(100),
  roleRules: z.array(ssoRoleRuleSchema).max(50),
  signUp: ssoSignUpSchema,
});
export type SsoInput = z.infer<typeof ssoInputSchema>;

/** What the settings page shows: the stored provider without its secret. */
export type SsoView = Omit<SsoInput, "clientSecret"> & {
  /** The address the provider sends the browser back to, to register with it; nothing until a public address is stored. */
  readonly callbackUrl: string | undefined;
  /** A client secret is stored. */
  readonly secretStored: boolean;
};

/** Why the provider was not saved. */
export type SsoRefusal = "invalid" | "secret_required" | "unavailable";

export type SsoSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SsoRefusal };

/** A discovery document's test: the issuer it names, or why it did not answer as one. */
export type DiscoveryResult =
  | { readonly ok: true; readonly issuer: string }
  | {
      readonly ok: false;
      readonly reason: "unreachable" | "not_discovery" | "no_keys";
    };

/** What the sign-in page offers: the provider's button, and whether the password is taken from owners alone. */
export interface SsoOffer {
  readonly name: string;
  readonly requireSso: boolean;
}

/** Why a sign-in through the provider was refused, as the sign-in page words it. */
export const ssoFailures = [
  "not_invited",
  "account_not_linked",
  "deactivated",
  "failed",
] as const;
export type SsoFailure = (typeof ssoFailures)[number];

/** The failure the sign-in page words for the `?error=` code the provider's callback redirected with; nothing without one. */
export function ssoFailureOf(code: string | undefined): SsoFailure | undefined {
  switch (code) {
    case undefined:
    case "":
      return;
    case "NOT_INVITED":
      return "not_invited";
    // The provider did not say the address is verified: it neither links nor signs up.
    case "account_not_linked":
    case "EMAIL_NOT_VERIFIED":
      return "account_not_linked";
    case "ACCOUNT_DEACTIVATED":
      return "deactivated";
    default:
      return "failed";
  }
}

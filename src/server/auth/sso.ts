/**
 * Single sign-on (CONTEXT.md "Single sign-on", "Identity provider"): the
 * one OIDC provider an owner sets up, stored as a setting with its client
 * secret sealed by the install key, and handed to the Better Auth instance
 * through the generic OAuth plugin (discovery, PKCE, the id token checked
 * against the provider's keys). The instance asks `signUpRole` who may make
 * an account through it: an address with an open invitation takes the
 * invitation's role, one at an allowed domain the role its claims map to or
 * the default; anyone else is refused. An address that has an account is
 * linked when the provider says the address is verified.
 */
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { z } from "zod";
import { decrypt, encrypt, type InstallKey } from "@/server/boot/installkey.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { Role } from "@/shared/domain/roles.ts";
import { atDomain, roleOfClaims } from "@/shared/domain/sso.ts";
import {
  type DiscoveryResult,
  type SsoInput,
  type SsoOffer,
  type SsoRole,
  type SsoRoleRule,
  type SsoSaveResult,
  type SsoSignUp,
  type SsoView,
  ssoInputSchema,
} from "@/shared/schemas/sso.ts";
import type { InvitationGate } from "./invitation.ts";

/** The provider's id in Better Auth: its callback is `/api/auth/callback/oidc`. */
export const ssoProviderId = "oidc";

/** The callback path the provider sends the browser back to. */
export const ssoCallbackPath = `/api/auth/callback/${ssoProviderId}`;

/** The provider as an instance takes it: the client secret in clear, opened with the install key. */
export interface SsoProvider {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly defaultRole: SsoRole;
  readonly discoveryUrl: string;
  readonly domains: readonly string[];
  readonly name: string;
  readonly requireSso: boolean;
  readonly roleClaim: string;
  readonly roleRules: readonly SsoRoleRule[];
  readonly signUp: SsoSignUp;
}

export type SsoStorage = Pick<Storage, "settings">;

/** The provider as stored: the input's shape with the client secret sealed. It holds a secret of this install's, so no export carries it. */
const ssoSetting = defineSetting(
  "sso_provider",
  ssoInputSchema.extend({ clientSecret: z.string() })
);

/** The settings page's read; nothing before a provider is stored. */
export async function readSsoView(
  storage: SsoStorage,
  publicAddress: string | undefined
): Promise<SsoView | undefined> {
  const held = await storage.settings.get(ssoSetting);
  if (!held) {
    return;
  }
  const { clientSecret: _sealed, ...rest } = held;
  return {
    ...rest,
    callbackUrl:
      publicAddress === undefined
        ? undefined
        : `${publicAddress}${ssoCallbackPath}`,
    secretStored: true,
  };
}

/** Stores the provider, sealing a new client secret and keeping the stored one when none is given. */
export async function saveSso(
  storage: Pick<Storage, "bump" | "settings">,
  key: InstallKey,
  input: SsoInput
): Promise<SsoSaveResult> {
  const parsed = ssoInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const { clientSecret, ...rest } = parsed.data;
    const sealed =
      clientSecret === undefined
        ? (await storage.settings.get(ssoSetting))?.clientSecret
        : await encrypt(key, clientSecret);
    if (sealed === undefined) {
      return { ok: false, reason: "secret_required" };
    }
    await storage.settings.set(ssoSetting, { ...rest, clientSecret: sealed });
    // The sign-in page the public memo keeps shows the provider's button, or no longer does.
    await storage.bump();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Single sign-on as an instance is built with it: the provider, and whether the owner required it, which holds even when the provider is not there. */
export interface StoredSso {
  /** Nothing while single sign-on is off, never stored, or its secret will not open with this install key. */
  readonly provider: SsoProvider | undefined;
  readonly required: boolean;
}

/** The stored single sign-on; throws when the setting cannot be read. */
export async function readSso(
  storage: SsoStorage,
  key: InstallKey
): Promise<StoredSso> {
  const held = await storage.settings.get(ssoSetting);
  if (!held?.enabled) {
    return { provider: undefined, required: false };
  }
  const clientSecret = await decrypt(key, held.clientSecret);
  return {
    provider:
      clientSecret === undefined ? undefined : { ...held, clientSecret },
    required: held.requireSso,
  };
}

/** What the sign-in and invitation pages offer: nothing while single sign-on is off or cannot be read. Never throws. */
export async function readSsoOffer(
  storage: SsoStorage | undefined
): Promise<SsoOffer | undefined> {
  const held = await storage?.settings.get(ssoSetting).catch(() => undefined);
  return held?.enabled
    ? { name: held.name, requireSso: held.requireSso }
    : undefined;
}

const discoverySchema = z.object({
  authorization_endpoint: z.url(),
  issuer: z.url(),
  jwks_uri: z.url().optional(),
  token_endpoint: z.url(),
});

/** How long the test waits for the discovery document. */
const discoveryWaitMs = 5000;

/** Fetches the discovery document once, as the instance will, and says whether it is one with signing keys. Never throws. */
export async function testDiscovery(
  url: string,
  fetcher: typeof fetch
): Promise<DiscoveryResult> {
  let body: unknown;
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(discoveryWaitMs),
    });
    body = response.ok
      ? await response.json().catch(() => undefined)
      : undefined;
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const parsed = discoverySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: "not_discovery" };
  }
  // The instance checks every id token against these keys and skips a provider without them.
  return parsed.data.jwks_uri === undefined
    ? { ok: false, reason: "no_keys" }
    : { issuer: parsed.data.issuer, ok: true };
}

/** The code a refused sign-up through the provider redirects with: the address has no open invitation and is at no allowed domain. */
export const notInvitedCode = "NOT_INVITED";

/** The code a sign-up through the provider redirects with when the provider does not say the address is verified. */
export const unverifiedCode = "EMAIL_NOT_VERIFIED";

/** The code a password sign-in or acceptance answers once single sign-on is required of the role. */
export const ssoRequiredCode = "SSO_REQUIRED";

/** Whether the password is refused to an account of the role: once single sign-on is required, only an owner signs in with one, the way back in when the provider is down. */
export function passwordRefused(required: boolean, role: string): boolean {
  return required && role !== "owner";
}

/** The person a sign-up through the provider is for: the address, whether the provider says it is verified, and the raw claims. */
export interface SsoPerson {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly email: string;
  readonly emailVerified: boolean;
}

export type SignUpDecision =
  | { readonly ok: true; readonly role: Role }
  | {
      readonly ok: false;
      readonly code: typeof notInvitedCode | typeof unverifiedCode;
    };

/**
 * The role a person signing up through the provider gets: an open
 * invitation's role, else for an address at an allowed domain the role its
 * claims map to or the default. Refused when the provider does not say the
 * address is verified, since the address is what the invitation or the
 * domain trusts.
 */
export async function signUpRole(
  provider: SsoProvider,
  invitations: InvitationGate,
  person: SsoPerson,
  now: number
): Promise<SignUpDecision> {
  if (!person.emailVerified) {
    return { code: unverifiedCode, ok: false };
  }
  const invitation = await invitations.forEmail(person.email, now);
  if (invitation) {
    return { ok: true, role: invitation.role };
  }
  if (
    provider.signUp === "domains" &&
    atDomain(provider.domains, person.email)
  ) {
    return {
      ok: true,
      role:
        roleOfClaims(provider.roleRules, provider.roleClaim, person.claims) ??
        provider.defaultRole,
    };
  }
  return { code: notInvitedCode, ok: false };
}

/** The generic OAuth plugin for the provider: discovery, PKCE, and every id token checked against the keys and the nonce discovery binds. */
export function ssoPlugin(provider: SsoProvider) {
  return genericOAuth({
    config: [
      {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        discoveryUrl: provider.discoveryUrl,
        pkce: true,
        providerId: ssoProviderId,
        requireIdTokenVerification: true,
        scopes: ["openid", "email", "profile"],
      },
    ],
  });
}

/**
 * An API key's shapes (CONTEXT.md "API key"): the keys page lists them,
 * makes one and revokes one; the secret itself appears once, in the
 * answer that made it. Here, so the admin never imports the server.
 */
import { z } from "zod";
import type { Role } from "@/shared/domain/roles.ts";
import { roleSchema } from "./team.ts";

export const apiKeyNameMaxLength = 60;

/** How long a new key works, in days; none never expires. */
export const apiKeyLifetimes = [7, 30, 90, 365] as const;
export type ApiKeyLifetime = (typeof apiKeyLifetimes)[number];

/** What the keys page posts to make a key. */
export const apiKeyCreateSchema = z.object({
  /** Days from now; null for a key that never expires. */
  expiresInDays: z
    .union(apiKeyLifetimes.map((days) => z.literal(days)))
    .nullable(),
  name: z.string().trim().min(1).max(apiKeyNameMaxLength),
  role: roleSchema,
});
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;

export const apiKeyIdSchema = z.object({ id: z.string().min(1) });

/** One API key as the keys page lists it: never its secret, nor its hash. */
export interface ApiKey {
  /** The account it acts for. */
  readonly account: {
    readonly email: string;
    readonly id: string;
    /** Empty when the operator gave none. */
    readonly name: string;
    readonly role: Role;
  };
  readonly createdAt: number;
  /** Nothing for a key that never expires. */
  readonly expiresAt: number | null;
  readonly id: string;
  /** The client address of its last call, as the entry resolved it behind the trusted proxies. */
  readonly lastUsedAddress: string | null;
  /** Its last call, to within a minute. */
  readonly lastUsedAt: number | null;
  readonly name: string;
  /** No wider than its account's: lowering the account's role lowers it. */
  readonly role: Role;
}

/** The prefix every API key starts with, so a secret scanner can name one. */
export const apiKeyPrefix = "rqk_";

export type ApiKeyCreateResult =
  | {
      readonly key: ApiKey;
      readonly ok: true;
      /** The key itself, shown this once. */
      readonly secret: string;
    }
  /** `role`: wider than the account's own. */
  | { readonly ok: false; readonly reason: "role" | "unavailable" };

export type ApiKeysResult =
  | { readonly keys: readonly ApiKey[]; readonly ok: true }
  | { readonly ok: false; readonly reason: "unavailable" };

/** What the keys page reads: the operator's own keys, and every key of the install to an operator who manages the team. */
export interface ApiKeysView {
  /** Every key of the install, the newest first; nothing to an operator who does not manage the team. */
  readonly all: readonly ApiKey[] | undefined;
  /** The operator's own, the newest first. */
  readonly own: readonly ApiKey[];
  /** The ids of the keys in `all` whose accounts the operator manages, so may revoke. */
  readonly revocable: readonly string[];
  /** The roles a new key of the operator's may carry. */
  readonly roles: readonly Role[];
}

export type ApiKeysViewResult =
  | ({ readonly ok: true } & ApiKeysView)
  | { readonly ok: false; readonly reason: "unavailable" };

/** `not_found`: no such key, or one the operator may not revoke. */
export type ApiKeyRevokeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

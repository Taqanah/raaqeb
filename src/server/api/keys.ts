/**
 * API keys (CONTEXT.md "API key"): an operator makes one for their own
 * account with a role no wider than the account's, sees it once, and
 * revokes it; an operator who manages the team sees every key and revokes
 * those of the accounts they manage. Only the secret's SHA-256 is kept: a
 * secret of 256 random bits needs no slow hash, and the management API
 * finds a key by its hash (server/api/caller.ts).
 */

import { type Operator, refusalOf } from "@/server/auth/session.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { keyRoles, manages } from "@/shared/domain/roles.ts";
import {
  type ApiKey,
  type ApiKeyCreateInput,
  type ApiKeyCreateResult,
  type ApiKeyRevokeResult,
  type ApiKeysViewResult,
  apiKeyPrefix,
} from "@/shared/schemas/api-key.ts";

const day = 86_400_000;
const unavailable = { ok: false, reason: "unavailable" } as const;
const notFound = { ok: false, reason: "not_found" } as const;

/** A fresh secret: 32 random bytes as base64url behind the prefix a secret scanner can name. */
export function newApiKeySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${apiKeyPrefix}${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

/** The SHA-256 of a secret, in hex: what storage keeps and the lookup asks for. */
export function hashApiKey(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

/** Whether the operator sees and judges every key: their role manages the team, and they owe no second step. Throws when the database cannot answer. */
async function managesTeam(
  storage: Storage,
  operator: Operator
): Promise<boolean> {
  return (await refusalOf(storage, operator, "team")) === undefined;
}

/** The keys page: the operator's own keys and the roles a new one may carry, and every key to an operator who manages the team. */
export async function readApiKeys(
  storage: Storage,
  operator: Operator
): Promise<ApiKeysViewResult> {
  try {
    const all = (await managesTeam(storage, operator))
      ? await storage.apiKeys.list()
      : undefined;
    return {
      all,
      ok: true,
      own: all
        ? all.filter((key) => key.account.id === operator.id)
        : await storage.apiKeys.ofAccount(operator.id),
      revocable: (all ?? [])
        .filter((key) => revocableBy(operator, key))
        .map((key) => key.id),
      roles: keyRoles(operator.role),
    };
  } catch {
    return unavailable;
  }
}

/** Whether the operator, who manages the team, may revoke the key: their own, or one of an account they manage. */
function revocableBy(operator: Operator, key: ApiKey): boolean {
  return (
    key.account.id === operator.id || manages(operator.role, key.account.role)
  );
}

/** Makes a key for the operator's own account, its secret answered this once. */
export async function createApiKey(
  storage: Storage,
  operator: Operator,
  input: ApiKeyCreateInput,
  now: number
): Promise<ApiKeyCreateResult> {
  if (!keyRoles(operator.role).includes(input.role)) {
    return { ok: false, reason: "role" };
  }
  const secret = newApiKeySecret();
  const id = crypto.randomUUID();
  try {
    await storage.apiKeys.create({
      accountId: operator.id,
      createdAt: now,
      expiresAt:
        input.expiresInDays === null ? null : now + input.expiresInDays * day,
      id,
      name: input.name,
      role: input.role,
      tokenHash: hashApiKey(secret),
    });
    const key = await storage.apiKeys.find(id);
    return key ? { key, ok: true, secret } : unavailable;
  } catch {
    return unavailable;
  }
}

/** Revokes one of the operator's own keys, or, to an operator who manages the team, a key of an account they manage. */
export async function revokeApiKey(
  storage: Storage,
  operator: Operator,
  id: string
): Promise<ApiKeyRevokeResult> {
  try {
    const key = await storage.apiKeys.find(id);
    const allowed =
      key !== undefined &&
      (key.account.id === operator.id ||
        (revocableBy(operator, key) && (await managesTeam(storage, operator))));
    if (!(allowed && (await storage.apiKeys.revoke(id)))) {
      return notFound;
    }
    return { ok: true };
  } catch {
    return unavailable;
  }
}

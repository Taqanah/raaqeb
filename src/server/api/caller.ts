/**
 * Who a management API call is (CONTEXT.md "API key", "Management API"):
 * the `Authorization: Bearer` header's key, found by its SHA-256 in one
 * indexed read, with its account, then held to the key's rate limit before
 * anything else runs. A call without a live key costs that one read and
 * nothing more. The caller is read once a request, for the API's route and
 * for the permission middleware of each server function it calls, which
 * finds it here by the request (src/routes/-admin.ts).
 */

import { type Auth, type AuthBoot, authFor } from "@/server/auth/auth.ts";
import { type Operator, refusalOf } from "@/server/auth/session.ts";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { lesserRole, type Permission } from "@/shared/domain/roles.ts";
import { refusal } from "./answer.ts";
import { hashApiKey } from "./keys.ts";
import { apiRateLimits, createRateLimit, type RateLimit } from "./limit.ts";

/** Why a call has no caller: no live key, the key's calls are spent for now, or the database cannot answer. */
export type CallerRefusal = "rate_limited" | "unauthenticated" | "unavailable";

export type Caller =
  | { readonly ok: true; readonly operator: Operator }
  | {
      readonly ok: false;
      readonly reason: CallerRefusal;
      /** Set when rate limited: the whole seconds until the key may call again. */
      readonly retryAfterSeconds?: number;
    };

/** How long a key's last use may lag its calls: a call writes it only when the stored one is older, or from another address. */
export const lastUsedEveryMs = 60_000;

/** The limit every key's calls are held to in this process. */
const processLimit: RateLimit = createRateLimit(apiRateLimits);

/** The caller of an API request, read once a request: the route and every server function it calls share the one read. */
export function callerOfRequest(
  storage: Storage | undefined,
  request: Request,
  now: number,
  limit: RateLimit = processLimit
): Promise<Caller> {
  let read = reads.get(request);
  if (!read) {
    read = callerOf(storage, request, now, limit);
    reads.set(request, read);
  }
  return read;
}

/** The caller the API's route read for this request; nothing for any request it did not read, a server function's own call among them. */
export function heldCaller(request: Request): Promise<Caller> | undefined {
  return reads.get(request);
}

/** Each API request's caller read. Held here, in one shared chunk, as the session read is (server/auth/session.ts). */
const reads = new WeakMap<Request, Promise<Caller>>();

const bearer = /^Bearer\s+(\S+)$/i;
const unauthenticated = { ok: false, reason: "unauthenticated" } as const;
const unavailable = { ok: false, reason: "unavailable" } as const;

async function callerOf(
  storage: Storage | undefined,
  request: Request,
  now: number,
  limit: RateLimit
): Promise<Caller> {
  if (!storage) {
    return unavailable;
  }
  const secret = bearer.exec(request.headers.get("authorization") ?? "")?.[1];
  if (secret === undefined) {
    return unauthenticated;
  }
  try {
    const key = await storage.apiKeys.open(hashApiKey(secret), now);
    if (!key) {
      return unauthenticated;
    }
    const wait = limit.take(key.id, now);
    if (wait !== undefined) {
      return { ok: false, reason: "rate_limited", retryAfterSeconds: wait };
    }
    const account = await storage.operatorAccounts.find(key.account.id);
    if (!account || account.deactivatedAt !== null) {
      return unauthenticated;
    }
    const address = request.headers.get(clientAddressHeader);
    if (
      key.lastUsedAt === null ||
      now - key.lastUsedAt >= lastUsedEveryMs ||
      key.lastUsedAddress !== address
    ) {
      // A last use that could not be written leaves the call to go ahead.
      await storage.apiKeys.used(key.id, now, address).catch(() => undefined);
    }
    return {
      ok: true,
      operator: {
        apiKey: { id: key.id, name: key.name },
        email: account.email,
        id: account.id,
        name: account.name,
        preferences: account.preferences,
        role: lesserRole(key.role, account.role),
        secondStep: account.secondStep,
        sessionId: undefined,
        signedInWith: "password",
      },
    };
  } catch {
    return unavailable;
  }
}

/**
 * The permission check of a server function the API's route calls: the
 * caller it read, with the storage and the Better Auth instance a handler
 * gets, or the refusal the route answers, thrown by the middleware as a
 * Response; nothing for a request the route did not read, which is a
 * session's (src/routes/-admin.ts).
 */
export async function permittedCaller(
  request: Request,
  storage: Storage | undefined,
  boot: AuthBoot,
  permission: Permission
): Promise<
  | {
      readonly auth: Auth;
      readonly operator: Operator;
      readonly storage: Storage;
    }
  | Response
  | undefined
> {
  const held = heldCaller(request);
  if (!held) {
    return;
  }
  const caller = await held;
  if (!caller.ok) {
    return refusal({ reason: caller.reason });
  }
  if (!storage) {
    return refusal({ reason: "unavailable" });
  }
  try {
    const refused = await refusalOf(storage, caller.operator, permission);
    if (refused) {
      return refusal({ reason: refused === "role" ? "forbidden" : refused });
    }
    return {
      auth: await authFor(storage, boot),
      operator: caller.operator,
      storage,
    };
  } catch {
    return refusal({ reason: "unavailable" });
  }
}

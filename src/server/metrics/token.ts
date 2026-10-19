/**
 * The metrics token (CONTEXT.md "Metrics endpoint", "Metrics token"): the
 * bearer token that lets Prometheus read `/metrics`. The endpoint is off
 * until the operator turns it on, which makes a token and shows it once;
 * only its SHA-256 is stored, so nothing in the database or a backup can
 * read the endpoint. Turning it on again makes a new token and the old one
 * stops working; turning it off forgets the hash.
 */

import { z } from "zod";
import { readPublicAddress } from "@/server/settings/address.ts";
import {
  defineSetting,
  type Setting,
  SettingShapeError,
} from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  type MetricsTokenResult,
  type MetricsView,
  metricsPath,
} from "@/shared/schemas/metrics.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";

export const metricsTokenHash: Setting<string> = defineSetting(
  "metrics_token_hash",
  z.string().regex(/^[0-9a-f]{64}$/)
);

/** How a scrape's `Authorization` header judged: the endpoint is off, the token is wrong or missing, or it is the token. */
export type Verdict = "granted" | "denied" | "off";

const bearer = /^Bearer\s+(\S+)$/i;

/** A fresh token: 32 random bytes as base64url behind a prefix a secret scanner can name. */
export function newMetricsToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `rqm_${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

/** The SHA-256 of a token, in hex. */
export function hashMetricsToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** The stored hash; nothing when none is held or the stored value is not a hash, so a damaged row reads as off until a new token replaces it. Throws when the database does not answer. */
async function heldHash(
  storage: Pick<Storage, "settings">
): Promise<string | undefined> {
  try {
    return await storage.settings.get(metricsTokenHash);
  } catch (cause) {
    if (cause instanceof SettingShapeError) {
      return;
    }
    throw cause;
  }
}

/** The header judged against the stored hash, in constant time. */
export async function judge(
  storage: Pick<Storage, "settings">,
  authorization: string | null
): Promise<Verdict> {
  const held = await heldHash(storage);
  if (held === undefined) {
    return "off";
  }
  const presented = bearer.exec(authorization ?? "")?.[1];
  if (presented === undefined) {
    return "denied";
  }
  // Two digests of equal length, so the comparison reveals nothing of the token.
  return crypto.timingSafeEqual(
    Uint8Array.fromHex(hashMetricsToken(presented)),
    Uint8Array.fromHex(held)
  )
    ? "granted"
    : "denied";
}

export async function readMetrics(
  storage: Pick<Storage, "settings">
): Promise<MetricsView> {
  const [held, address] = await Promise.all([
    heldHash(storage),
    readPublicAddress(storage),
  ]);
  return {
    address: address === undefined ? undefined : `${address}${metricsPath}`,
    on: held !== undefined,
  };
}

/** Turns the endpoint on or replaces its token. */
export async function makeMetricsToken(
  storage: Pick<Storage, "settings">
): Promise<MetricsTokenResult> {
  const token = newMetricsToken();
  try {
    await storage.settings.set(metricsTokenHash, hashMetricsToken(token));
    return { ok: true, token };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function turnMetricsOff(
  storage: Pick<Storage, "settings">
): Promise<SaveResult> {
  try {
    await storage.settings.remove(metricsTokenHash);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Probes as the operator manages them (CONTEXT.md "Probe", "Probe token";
 * ADR-0012): made with a name, which answers its token once; given a new
 * token, which stops the old one at once; deleted, which drops it from
 * every monitor's locations. Only a token's SHA-256 is stored. Each write
 * moves the change counter, since the scheduler holds the probes' names.
 */
import { readPublicAddress } from "@/server/settings/address.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { probesMax } from "@/shared/schemas/monitor.ts";
import {
  type ProbeRemoveResult,
  type ProbesResult,
  type ProbeTokenResult,
  probeNameSchema,
} from "@/shared/schemas/probe.ts";

type ProbeStorage = Pick<Storage, "bump" | "probes" | "settings">;

const unavailable = { ok: false, reason: "unavailable" } as const;

/** A fresh token: 32 random bytes as base64url behind a prefix a secret scanner can name. */
export function newProbeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `rqp_${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

/** The SHA-256 of a token, in hex. */
export function hashProbeToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export async function readProbes(
  storage: ProbeStorage,
  now: number,
  refusedPush: (probeId: string) => boolean = () => false
): Promise<ProbesResult> {
  try {
    const [probes, address] = await Promise.all([
      storage.probes.list(),
      readPublicAddress(storage),
    ]);
    const refused = probes
      .filter((probe) => refusedPush(probe.id))
      .map((probe) => probe.id);
    return { address, now, ok: true, probes, refused };
  } catch {
    return unavailable;
  }
}

/** Makes a probe and answers its token; `full` once the install has as many as a monitor may name. */
export async function makeProbe(
  storage: ProbeStorage,
  name: string
): Promise<ProbeTokenResult> {
  try {
    if ((await storage.probes.list()).length >= probesMax) {
      return { ok: false, reason: "full" };
    }
    const token = newProbeToken();
    const probe = await storage.probes.create(
      probeNameSchema.parse(name),
      hashProbeToken(token)
    );
    await storage.bump();
    return { ok: true, probe, token };
  } catch {
    return unavailable;
  }
}

/** Gives the probe a new token; the old one stops at once. */
export async function replaceProbeToken(
  storage: ProbeStorage,
  id: string
): Promise<ProbeTokenResult> {
  try {
    const token = newProbeToken();
    const probe = await storage.probes.replaceToken(id, hashProbeToken(token));
    return probe
      ? { ok: true, probe, token }
      : { ok: false, reason: "not_found" };
  } catch {
    return unavailable;
  }
}

export async function removeProbe(
  storage: ProbeStorage,
  id: string
): Promise<ProbeRemoveResult> {
  try {
    if (!(await storage.probes.remove(id))) {
      return { ok: false, reason: "not_found" };
    }
    await storage.bump();
    return { ok: true };
  } catch {
    return unavailable;
  }
}

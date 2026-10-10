/**
 * Better Auth's secret: generated into the settings table in Better
 * Auth's versioned form, `<version>:<secret>` entries separated by commas with
 * the first entry current, so it survives a container recreated without a
 * volume and can be rotated later. `BETTER_AUTH_SECRETS` overrides it and is
 * never written; a stored value stays untouched and unused meanwhile.
 */
import { z } from "zod";
import { versionedSecrets } from "@/server/boot/settings.ts";
import {
  defineSetting,
  type Setting,
  SettingShapeError,
} from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";

/** The versioned form: `1:abc` or `2:def,1:abc`. */
export const versionedSecretsSchema = z.string().regex(versionedSecrets);

export const betterAuthSecrets: Setting<string> = defineSetting(
  "better_auth_secrets",
  versionedSecretsSchema
);

export interface SecretEntry {
  readonly value: string;
  readonly version: number;
}

/** A fresh version 1 secret: 32 random bytes as base64url, in the versioned form. */
export function generateSecrets(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `1:${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

/** The versioned text as the entries Better Auth takes, first entry current. */
export function parseSecrets(text: string): SecretEntry[] {
  return text.split(",").map((entry) => {
    const colon = entry.indexOf(":");
    return {
      value: entry.slice(colon + 1),
      version: Number(entry.slice(0, colon)),
    };
  });
}

export interface ResolvedSecrets {
  /** True when this call generated and stored a new secret. */
  readonly generated: boolean;
  /** True when the boot setting won over the stored value. */
  readonly overridden: boolean;
  readonly secrets: string;
}

/**
 * The secret to use: the boot setting when set, else the stored setting, else
 * a new one generated and stored. A stored value that is not in the versioned
 * form is replaced by a new one, which signs every browser out.
 */
export async function resolveSecrets(
  storage: Pick<Storage, "settings">,
  override: string | undefined
): Promise<ResolvedSecrets> {
  if (override !== undefined) {
    return { generated: false, overridden: true, secrets: override };
  }
  const stored = await readStored(storage);
  if (stored !== undefined) {
    return { generated: false, overridden: false, secrets: stored };
  }
  const secrets = generateSecrets();
  await storage.settings.set(betterAuthSecrets, secrets);
  return { generated: true, overridden: false, secrets };
}

function readStored(
  storage: Pick<Storage, "settings">
): Promise<string | undefined> {
  // Outside the versioned form the repository refuses the row by contract and a new secret replaces it; any other failure is an error, since a new secret would sign everyone out.
  return storage.settings
    .get(betterAuthSecrets)
    .catch((cause: unknown): string | undefined => {
      if (cause instanceof SettingShapeError) {
        return undefined;
      }
      throw cause;
    });
}

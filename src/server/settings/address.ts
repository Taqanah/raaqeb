/**
 * The public address (CONTEXT.md "Public address"): the origin
 * at which visitors and the operator reach the install, stored as a setting.
 * Better Auth's base URL and trusted origin come from it; reset links and
 * subscriber emails later. Onboarding pre-fills and stores it;
 * settings edit it.
 */

import { error as logError } from "@/server/log.ts";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { publicAddressSchema } from "@/shared/schemas/address.ts";

export const publicAddress: Setting<string> = defineSetting(
  "public_address",
  publicAddressSchema
);

/**
 * The stored origin, or nothing when none is stored or no database is open.
 * A stored value that is not an origin is reported by key and answered as
 * nothing, so auth falls back to the request origin and the setting can be
 * repaired.
 */
export async function readPublicAddress(
  storage: Pick<Storage, "settings"> | undefined
): Promise<string | undefined> {
  try {
    return await storage?.settings.get(publicAddress);
  } catch {
    logError(
      `the stored setting ${publicAddress.key} is not an origin; using the request's origin until it is set again`
    );
  }
}

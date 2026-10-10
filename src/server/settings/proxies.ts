/**
 * The trusted proxies: the addresses
 * and CIDR ranges whose forwarded headers are believed, a setting on the
 * general page that `RAAQEB_TRUSTED_PROXIES` overrides when set. The entry
 * holds them in memory and reads the setting again only when the change
 * counter moves, so a request costs no read of its own.
 */

import { z } from "zod";
import { isProxyEntry } from "@/server/boot/proxies.ts";
import { error as logError } from "@/server/log.ts";
import {
  defineSetting,
  type Setting,
  SettingShapeError,
} from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";

export const trustedProxies: Setting<string[]> = defineSetting(
  "trusted_proxies",
  z.array(z.string().refine(isProxyEntry))
);

/**
 * The trusted proxies in force for one request, from the counter the request
 * read (nothing for a request that read none, or whose read failed). The
 * variable's entries when it is set; otherwise the stored ones, read when the
 * counter moved, or once on the first request over an open storage.
 */
export type HeldProxies = (
  storage: Pick<Storage, "settings"> | undefined,
  counter: number | undefined
) => Promise<readonly string[]>;

/** The trusted proxies the entry holds, over the variable's entries (empty when it is unset). */
export function heldTrustedProxies(
  environment: readonly string[]
): HeldProxies {
  let held: readonly string[] = [];
  let loaded = false;
  let readAt: number | undefined;
  return async (storage, counter) => {
    if (environment.length > 0) {
      return environment;
    }
    if (!storage) {
      return [];
    }
    if (loaded && (counter === undefined || counter === readAt)) {
      return held;
    }
    try {
      held = (await storage.settings.get(trustedProxies)) ?? [];
    } catch (error) {
      if (!(error instanceof SettingShapeError)) {
        // The database did not answer: kept as held, and the next request reads again.
        return held;
      }
      // Believing no forwarded header is the safe answer until the setting is saved again.
      logError(
        `the stored setting ${trustedProxies.key} is not a list of addresses and ranges; trusting no proxy until it is set again`
      );
      held = [];
    }
    loaded = true;
    readAt = counter;
    return held;
  };
}

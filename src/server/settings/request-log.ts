/**
 * The request log switch on the general page, off by
 * default. The entry holds it in memory and reads the setting again only when
 * the change counter moves, as it does the trusted proxies, so a request
 * costs no read of its own and a save needs no restart.
 */

import { z } from "zod";
import { error as logError } from "@/server/log.ts";
import {
  defineSetting,
  type Setting,
  SettingShapeError,
} from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";

export const requestLogEnabled: Setting<boolean> = defineSetting(
  "request_log_enabled",
  z.boolean()
);

/** Whether the request log is on for one request, from the counter the request read (nothing for a request that read none, or whose read failed). */
export type HeldSwitch = (
  storage: Pick<Storage, "settings"> | undefined,
  counter: number | undefined
) => Promise<boolean>;

/** The request log switch the entry holds: off before a database is open, else the stored value, read when the counter moved, or once on the first request over an open storage. */
export function heldRequestLog(): HeldSwitch {
  let on = false;
  let loaded = false;
  let readAt: number | undefined;
  return async (storage, counter) => {
    if (!storage) {
      return false;
    }
    if (loaded && (counter === undefined || counter === readAt)) {
      return on;
    }
    try {
      on = (await storage.settings.get(requestLogEnabled)) ?? false;
    } catch (error) {
      if (!(error instanceof SettingShapeError)) {
        // The database did not answer: the switch stays as held, and the next request reads again.
        return on;
      }
      logError(
        `the stored setting ${requestLogEnabled.key} is not one of its values; using the default until it is set again`
      );
      on = false;
    }
    loaded = true;
    readAt = counter;
    return on;
  };
}

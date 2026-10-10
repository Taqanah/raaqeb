/**
 * The getting-started checklist's one stored value (CONTEXT.md
 * "Getting-started checklist"): whether it is closed for good, set when
 * the operator dismisses it or when the list read first finds every step
 * done. Each line reads whether its thing exists, so nothing else is stored.
 * It belongs to the install it was set on and does not travel in an export.
 */
import { z } from "zod";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";

/** True once the checklist is closed, dismissed or done; it never shows again. */
export const gettingStartedClosed: Setting<boolean> = defineSetting(
  "getting_started_closed",
  z.boolean()
);

/** Dismisses the checklist for good; never throws. */
export async function dismissGettingStarted(
  storage: Pick<Storage, "settings">
): Promise<SaveResult> {
  try {
    await storage.settings.set(gettingStartedClosed, true);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

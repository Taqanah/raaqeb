/**
 * The notification hold (CONTEXT.md "Notification hold"): one stored value,
 * when the import that started it ran. While it is set the notification
 * queue drops every operator and subscriber notification; an owner or
 * admin ends it. It belongs to the install it was set on and does not
 * travel in an export.
 */
import { z } from "zod";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";

/** When the hold began, in UTC milliseconds; absent while notifications go. */
export const notificationHold: Setting<number> = defineSetting(
  "notification_hold",
  z.int().nonnegative()
);

/** When the hold began, or nothing while notifications go. Throws when the storage does not answer. */
export function readNotificationHold(
  storage: Pick<Storage, "settings">
): Promise<number | undefined> {
  return storage.settings.get(notificationHold);
}

/** Ends the hold, so notifications go again from now; never throws. */
export async function endNotificationHold(
  storage: Pick<Storage, "settings">
): Promise<SaveResult> {
  try {
    await storage.settings.remove(notificationHold);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

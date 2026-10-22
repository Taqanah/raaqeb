/**
 * The notification hold's server function (CONTEXT.md "Notification
 * hold"), apart from the admin layout's route file, whose top level the
 * public pages' client entry carries for its guard. Not a route file: the
 * leading dash keeps it out of the route tree.
 */
import { createServerFn } from "@tanstack/react-start";
import { endNotificationHold } from "@/server/settings/hold.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";
import { permitted } from "./-admin.ts";

/** Ends the notification hold an import started. */
export const endHoldFn = createServerFn({ method: "POST" })
  .middleware([permitted("channels")])
  .handler(
    ({ context }): Promise<SaveResult> => endNotificationHold(context.storage)
  );

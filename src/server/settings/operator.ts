/**
 * An operator's own overrides (CONTEXT.md "Operator language"): the
 * operator language, zone, clock and calendar, kept on their account
 * (storage/accounts.ts), each falling back to the install's when the
 * account has none.
 */

import type { Storage } from "@/server/storage/storage.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { AccountSettingsInput } from "@/shared/schemas/settings.ts";
import { type ClockSettings, readClock } from "./clock.ts";
import { readInstallLanguage } from "./language.ts";

/** The admin area's paths, which render in the operator language. */
export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/** The operator language of an account's preferences, or the install language when they name none. */
export async function readOperatorLanguage(
  storage: Pick<Storage, "settings"> | undefined,
  preferences: AccountSettingsInput | undefined
): Promise<Locale> {
  return preferences?.operatorLanguage ?? (await readInstallLanguage(storage));
}

/** The zone, clock and calendar of an account's preferences, each falling back to the install's. */
export async function readOperatorClock(
  storage: Pick<Storage, "settings">,
  preferences: AccountSettingsInput
): Promise<ClockSettings> {
  const install = await readClock(storage);
  return {
    calendar: preferences.calendar ?? install.calendar,
    clock: preferences.clock ?? install.clock,
    timeZone: preferences.timeZone ?? install.timeZone,
  };
}

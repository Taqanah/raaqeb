/**
 * The account page's settings: an operator's own language, zone, clock
 * and calendar overrides, kept on their account and read beside the install
 * values they fall back to. The name, email and password changes and the
 * sessions are the auth module's (`server/auth/account.ts`).
 */

import type { Storage } from "@/server/storage/storage.ts";
import { timeZones } from "@/shared/i18n/timezone.ts";
import type {
  AccountSettings,
  AccountSettingsInput,
  SaveResult,
} from "@/shared/schemas/settings.ts";
import { readClock } from "./clock.ts";
import { readInstallLanguage } from "./language.ts";

export async function readAccountSettings(
  storage: Pick<Storage, "settings">,
  preferences: AccountSettingsInput
): Promise<AccountSettings> {
  const [language, install] = await Promise.all([
    readInstallLanguage(storage),
    readClock(storage),
  ]);
  return {
    install: {
      calendar: install.calendar,
      clock: install.clock,
      language,
      timeZone: install.timeZone,
    },
    overrides: preferences,
    timeZones: timeZones(),
  };
}

/** Stores the account's overrides; an absent one follows the install again. */
export async function saveAccountSettings(
  storage: Pick<Storage, "operatorAccounts">,
  accountId: string,
  input: AccountSettingsInput
): Promise<SaveResult> {
  try {
    return (await storage.operatorAccounts.setPreferences(accountId, input))
      ? { ok: true }
      : { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * The account page's settings: the operator language, zone,
 * clock and calendar overrides, read beside the install values they fall back to. The
 * email and password changes are the auth module's (`server/auth/account.ts`).
 */

import type { Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { timeZones } from "@/shared/i18n/timezone.ts";
import type { Calendar, Clock } from "@/shared/schemas/clock.ts";
import type {
  AccountSettings,
  AccountSettingsInput,
  SaveResult,
} from "@/shared/schemas/settings.ts";
import { readClock, readSetting } from "./clock.ts";
import { readInstallLanguage } from "./language.ts";
import {
  operatorCalendar,
  operatorClock,
  operatorLanguage,
  operatorTimeZone,
} from "./operator.ts";

export async function readAccountSettings(
  storage: Pick<Storage, "settings">
): Promise<AccountSettings> {
  const [
    language,
    install,
    overrideLanguage,
    overrideZone,
    overrideClock,
    overrideCalendar,
  ] = await Promise.all([
    readInstallLanguage(storage),
    readClock(storage),
    readSetting(storage, operatorLanguage, undefined),
    readSetting(storage, operatorTimeZone, undefined),
    readSetting(storage, operatorClock, undefined),
    readSetting(storage, operatorCalendar, undefined),
  ]);
  const overrides: {
    calendar?: Calendar;
    clock?: Clock;
    operatorLanguage?: Locale;
    timeZone?: string;
  } = {};
  if (overrideCalendar) {
    overrides.calendar = overrideCalendar;
  }
  if (overrideClock) {
    overrides.clock = overrideClock;
  }
  if (overrideLanguage) {
    overrides.operatorLanguage = overrideLanguage;
  }
  if (overrideZone) {
    overrides.timeZone = overrideZone;
  }
  return {
    install: {
      calendar: install.calendar,
      clock: install.clock,
      language,
      timeZone: install.timeZone,
    },
    overrides,
    timeZones: timeZones(),
  };
}

/** Stores each given override and removes each absent one. */
export async function saveAccountSettings(
  storage: Pick<Storage, "settings">,
  input: AccountSettingsInput
): Promise<SaveResult> {
  try {
    await setOrRemove(storage, operatorLanguage, input.operatorLanguage);
    await setOrRemove(storage, operatorTimeZone, input.timeZone);
    await setOrRemove(storage, operatorClock, input.clock);
    await setOrRemove(storage, operatorCalendar, input.calendar);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

async function setOrRemove<T>(
  storage: Pick<Storage, "settings">,
  setting: Setting<T>,
  value: T | undefined
): Promise<void> {
  if (value === undefined) {
    await storage.settings.remove(setting);
  } else {
    await storage.settings.set(setting, value);
  }
}

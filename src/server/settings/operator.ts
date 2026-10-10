/**
 * The operator's own overrides (CONTEXT.md "Operator language"): the operator language, zone, clock and calendar, each a setting that falls
 * back to the install's. With one operator account these are install-wide
 * rows keyed `operator_*`; more accounts would move them onto the account.
 */

import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { type Locale, localeSchema } from "@/shared/i18n/locale.ts";
import {
  type Calendar,
  type Clock,
  calendarSchema,
  clockSchema,
  timeZoneSchema,
} from "@/shared/schemas/clock.ts";
import { type ClockSettings, readClock, readSetting } from "./clock.ts";
import { readInstallLanguage } from "./language.ts";

export const operatorLanguage: Setting<Locale> = defineSetting(
  "operator_language",
  localeSchema
);
export const operatorTimeZone: Setting<string> = defineSetting(
  "operator_time_zone",
  timeZoneSchema
);
export const operatorClock: Setting<Clock> = defineSetting(
  "operator_clock",
  clockSchema
);
export const operatorCalendar: Setting<Calendar> = defineSetting(
  "operator_calendar",
  calendarSchema
);

/** The admin area's paths, which render in the operator language. */
export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/** The operator language, or the install language when none is stored. */
export async function readOperatorLanguage(
  storage: Pick<Storage, "settings"> | undefined
): Promise<Locale> {
  const install = await readInstallLanguage(storage);
  return readSetting(storage, operatorLanguage, install);
}

/** The operator's zone, clock and calendar, each falling back to the install's. */
export async function readOperatorClock(
  storage: Pick<Storage, "settings">
): Promise<ClockSettings> {
  const install = await readClock(storage);
  const [zone, format, calendar] = await Promise.all([
    readSetting(storage, operatorTimeZone, install.timeZone),
    readSetting(storage, operatorClock, install.clock),
    readSetting(storage, operatorCalendar, install.calendar),
  ]);
  return { calendar, clock: format, timeZone: zone };
}

/**
 * The install time zone, clock format and calendar: three settings, the
 * zone defaulting to the host's, the clock to 12-hour and the calendar to
 * Gregorian. The formatting helpers of `shared/i18n` take them as
 * parameters; this module answers them.
 */

import { error as logError } from "@/server/log.ts";
import {
  defineSetting,
  type Setting,
  SettingShapeError,
} from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { hostTimeZone } from "@/shared/i18n/timezone.ts";
import {
  type Calendar,
  type Clock,
  calendarSchema,
  clockSchema,
  timeZoneSchema,
} from "@/shared/schemas/clock.ts";

export const timeZone: Setting<string> = defineSetting(
  "time_zone",
  timeZoneSchema
);
export const clock: Setting<Clock> = defineSetting("clock", clockSchema);
export const calendar: Setting<Calendar> = defineSetting(
  "calendar",
  calendarSchema
);

export interface ClockSettings {
  readonly calendar: Calendar;
  readonly clock: Clock;
  readonly timeZone: string;
}

export const defaultClock: Clock = "12h";
/** Gregorian, so an install from before the setting reads as it did. */
export const defaultCalendar: Calendar = "gregorian";

/**
 * One setting, or its fallback when nothing is stored, no database is open,
 * or the stored value is outside its rule. That last case is reported by key
 * so the setting can be repaired; the screen must still render.
 */
export async function readSetting<T>(
  storage: Pick<Storage, "settings"> | undefined,
  setting: Setting<T>,
  fallback: T
): Promise<T> {
  try {
    return (await storage?.settings.get(setting)) ?? fallback;
  } catch (error) {
    logError(
      error instanceof SettingShapeError
        ? `the stored setting ${setting.key} is not one of its values; using the default until it is set again`
        : `the setting ${setting.key} could not be read; using the default for this request`
    );
    return fallback;
  }
}

/**
 * The install's zone, clock and calendar, with the host zone, 12-hour and
 * Gregorian where nothing is stored or no database is open.
 */
export async function readClock(
  storage: Pick<Storage, "settings"> | undefined
): Promise<ClockSettings> {
  const [zone, format, installCalendar] = await Promise.all([
    readSetting(storage, timeZone, hostTimeZone()),
    readSetting(storage, clock, defaultClock),
    readSetting(storage, calendar, defaultCalendar),
  ]);
  return { calendar: installCalendar, clock: format, timeZone: zone };
}

/**
 * The clock format, the calendar and the time zone: install-wide settings
 * with a per-operator override, locale-independent. The clock is 12-hour and
 * the calendar Gregorian by default; the zone is any IANA name the runtime
 * knows.
 */
import { z } from "zod";
import { isTimeZone } from "@/shared/i18n/timezone.ts";

export const clocks = ["12h", "24h"] as const;
export const clockSchema = z.enum(clocks);
export type Clock = z.infer<typeof clockSchema>;

/** The calendar dates are shown in: Gregorian, Hijri (Umm al-Qura), or Hijri with the Gregorian date beside it. */
export const calendars = ["gregorian", "hijri", "hijri_gregorian"] as const;
export const calendarSchema = z.enum(calendars);
export type Calendar = z.infer<typeof calendarSchema>;

export const timeZoneSchema = z
  .string()
  .refine(isTimeZone, "an IANA time zone name");

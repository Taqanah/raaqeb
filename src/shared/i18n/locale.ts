/**
 * The two locales Raaqeb ships and what each one decides: the words and the
 * reading direction, nothing else (CONTEXT.md "Locale"). A
 * regional tag is refused everywhere a locale is stored or typed into a URL;
 * nothing in v1 matches a browser's preference (no Accept-Language redirect).
 */
import { z } from "zod";

export const locales = ["ar", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "ar";
export type Direction = "rtl" | "ltr";

/** The exact tags only: `ar` or `en`, for URLs and settings. */
export const localeSchema = z.enum(locales);

/** Whether the value is one of the two exact tags. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && locales.some((l) => l === value);
}

export function directionOf(locale: Locale): Direction {
  return locale === "ar" ? "rtl" : "ltr";
}

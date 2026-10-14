/**
 * Which locale a website address shows: the Arabic page at the bare
 * path, the English one under /en. Any other prefix, /ar among them, names
 * no page, so each page has one address.
 */
import { defaultLocale, type Locale } from "@/shared/i18n/locale.ts";

/** The locale of the page at a path whose optional first segment is `prefix`; undefined when that names no page. */
export function pageLocale(prefix: string | undefined): Locale | undefined {
  if (prefix === undefined) {
    return defaultLocale;
  }
  return prefix === "en" ? "en" : undefined;
}

/** The locale a path is shown in, a path that names no page included: English under /en, Arabic everywhere else. */
export function pathLocale(pathname: string): Locale {
  return pageLocale(pathname.split("/")[1]) ?? defaultLocale;
}

/** Each locale's landing page: Arabic at the bare path, English under /en. */
export const homePath: Readonly<Record<Locale, string>> = {
  ar: "/",
  en: "/en",
};

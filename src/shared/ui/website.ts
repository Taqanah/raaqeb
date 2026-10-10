/**
 * Raaqeb's own website: where a status page's "Powered by
 * Raaqeb" leads and where the website lives. One place, so the domain is
 * written once for the product and the website.
 */
import type { Locale } from "@/shared/i18n/locale.ts";

/** The website's origin. */
export const website = "https://raaqeb.dev";

/** The website's home page in `locale`: Arabic at the bare path, English under /en. */
export function websiteHome(locale: Locale): string {
  return locale === "ar" ? `${website}/` : `${website}/${locale}`;
}

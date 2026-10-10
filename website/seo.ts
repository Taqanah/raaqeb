/**
 * What search engines and link previews read on every page: the
 * preview image of each locale, the tags that point at it, and structured
 * data as JSON-LD.
 */
import type { Locale } from "@/shared/i18n/locale.ts";
import { site } from "~/copy.ts";

/** Each locale's preview image, 1200 by 630, taken from the landing page's hero. */
export const previewImage: Readonly<Record<Locale, string>> = {
  ar: `${site}/og-ar.png`,
  en: `${site}/og-en.png`,
};

/** Open Graph's name for each locale. */
export const ogLocale: Readonly<Record<Locale, string>> = {
  ar: "ar_AR",
  en: "en_US",
};

/** The preview tags a page shares: its image for Open Graph and the large card for X. */
export function previewMeta(
  locale: Locale,
  title: string,
  description: string,
  alt: string
): { content: string; name?: string; property?: string }[] {
  const image = previewImage[locale];
  return [
    { content: "Raaqeb", property: "og:site_name" },
    { content: ogLocale[locale], property: "og:locale" },
    ...(Object.keys(ogLocale) as Locale[])
      .filter((l) => l !== locale)
      .map((l) => ({ content: ogLocale[l], property: "og:locale:alternate" })),
    { content: image, property: "og:image" },
    { content: "1200", property: "og:image:width" },
    { content: "630", property: "og:image:height" },
    { content: alt, property: "og:image:alt" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: title, name: "twitter:title" },
    { content: description, name: "twitter:description" },
    { content: image, name: "twitter:image" },
    { content: alt, name: "twitter:image:alt" },
  ];
}

/** A JSON-LD script for a page's head; `<` is escaped so no text in the data can close the script. */
export function jsonLd(data: Readonly<Record<string, unknown>>): {
  children: string;
  type: string;
} {
  return {
    children: JSON.stringify({
      "@context": "https://schema.org",
      ...data,
    }).replaceAll("<", "\\u003c"),
    type: "application/ld+json",
  };
}

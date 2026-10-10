/**
 * The catalog of a document whose own read failed: it has none, so the
 * error notice takes its words from locales/fallback.ts, which `bun run
 * catalog` writes from the compiled catalogs, three words a locale.
 */
import { fallbackMessages } from "../../../locales/fallback.ts";
import type { Locale } from "./locale.ts";
import type { Catalog } from "./messages.ts";

/** The error notice's words in `locale`. */
export function fallbackCatalog(locale: Locale): Catalog {
  return fallbackMessages[locale];
}

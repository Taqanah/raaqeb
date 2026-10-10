/**
 * Interface messages (CONTEXT.md "Message catalog", ADR-0003): a compiled
 * catalog for one locale becomes a Lingui instance with that locale active.
 * Every user-visible string crosses this folder; the rest of src/ never
 * imports Lingui directly (biome.jsonc).
 */
import { type I18n, type Messages, setupI18n } from "@lingui/core";
import type { Locale } from "./locale.ts";

/** The compiled messages of one locale, as `lingui compile` writes them. */
export type Catalog = Messages;

export type { MessageId } from "@lingui/core";

/**
 * A compiled catalog read back from its JSON text, the form in which it
 * travels inside the server-rendered document. This is the parse boundary:
 * Lingui's own compiled module does the same `JSON.parse` with the same type.
 */
export function catalogFromJson(text: string): Catalog {
  return JSON.parse(text) as Catalog;
}

/**
 * The words of the notice a failed page shows. Every document carries
 * them: the public part of a catalog includes them, and a document whose own
 * read failed, which has no catalog, takes them from locales/fallback.ts,
 * which `bun run catalog` writes from the compiled catalogs.
 */
export const errorNoticeIds = [
  "app_error_title",
  "app_error_description",
  "app_try_again",
] as const;

/** A Lingui instance holding one locale's catalog, with that locale active. */
export function createMessages(locale: Locale, catalog: Catalog): I18n {
  return setupI18n({ locale, messages: { [locale]: catalog } });
}

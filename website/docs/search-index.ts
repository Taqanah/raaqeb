/**
 * The docs' search index per language: a reader searches one language,
 * so the browser downloads that language's index and not both.
 */

/** What a Fumadocs search server gives: its whole export. */
interface Exportable {
  export: () => Promise<unknown>;
}

/**
 * The index of one language's pages as the browser loads it, or undefined for
 * a language with none. Fumadocs exports one index per language only when each
 * has its own database (its deprecated `localeMap`), which is why the server
 * sets it.
 */
export async function languageIndex(
  search: Exportable,
  language: string
): Promise<unknown> {
  const exported = await search.export();
  if (
    typeof exported === "object" &&
    exported !== null &&
    "type" in exported &&
    exported.type === "i18n" &&
    "data" in exported &&
    typeof exported.data === "object" &&
    exported.data !== null &&
    Object.hasOwn(exported.data, language)
  ) {
    return Reflect.get(exported.data, language);
  }
  return undefined;
}

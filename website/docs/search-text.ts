/**
 * Text as the docs' search matches it: Arabic without its diacritics
 * or tatweel, which readers seldom type, and a ta marbuta as the ha it is
 * often typed as, so "التعطل" finds "التعطّل" and "حاله" finds "حالة". The
 * search's tokenizer applies it to every word of the index and the dialog to
 * every query, while the content a result shows stays as written. Alef forms
 * and the alef maqsura need no code: the engine's tokenizer folds them itself.
 */
export function searchText(text: string): string {
  return text.replace(/[\u064B-\u065F\u0670\u0640]/g, "").replaceAll("ة", "ه");
}

/** The search's tokenizer: every word of the index passes through searchText. */
export const searchTokenizer = {
  language: "multilingual",
  stemmer: searchText,
} as const;

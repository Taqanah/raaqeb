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

/**
 * What the reader typed as a pattern over the content as written, for the
 * dialog's highlight: each letter with any diacritics or tatweel after it,
 * every alef form for an alef, a ta marbuta for a ha and an alef maqsura for
 * a ya, so a highlight finds what the search found. Words are alternatives.
 */
export function foldedPattern(typed: string): RegExp | undefined {
  const words = searchText(typed).split(whitespace).filter(Boolean);
  if (words.length === 0) {
    return;
  }
  const letter = (c: string) =>
    (letterForms[c] ?? c.replace(reserved, "\\$&")) + marks;
  return new RegExp(
    words.map((word) => [...word].map(letter).join("")).join("|"),
    "gi"
  );
}

const whitespace = /\s+/;
/** The characters a pattern reserves, matched as themselves. */
const reserved = /[.*+?^${}()|[\]\\]/g;
/** Diacritics and tatweel, which may follow any letter of the content. */
const marks = "[\\u064B-\\u065F\\u0670\\u0640]*";
const alef = "[اأإآ]";
const ha = "[هة]";
const ya = "[يى]";
const letterForms: Readonly<Record<string, string>> = {
  ا: alef,
  أ: alef,
  إ: alef,
  آ: alef,
  ه: ha,
  ي: ya,
  ى: ya,
};

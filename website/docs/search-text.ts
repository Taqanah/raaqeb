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

/**
 * Each word as the docs' search indexes it: searchText's folding, then the
 * article and a feminine plural's ending cut off an Arabic word, so
 * "التنبيه", "تنبيه" and "تنبيهات" are one word to the search. The index
 * holds stems, and the dialog stems each query once before it searches.
 */
export function searchStem(text: string): string {
  return searchText(text).split(whitespace).filter(Boolean).map(stem).join(" ");
}

/** A folded word without its article and its ending; a cut never leaves fewer than two letters. */
function stem(word: string): string {
  return word.replace(article, "").replace(plural, "").replace(finalHa, "");
}

/** The article, with a conjunction or preposition joined before it. */
const article = /^(?:[وفبك]?ال|لل)(?=\p{L}{2})/u;
/** A feminine plural's ending. */
const plural = /(?<=\p{L}{2})ات$/u;
/** A ta marbuta, folded to ha, or a ha: "حالة" and "حالات" share "حال". */
const finalHa = /(?<=\p{L}{2})ه$/u;

/** The search's tokenizer: every word of the index passes through searchStem. */
export const searchTokenizer = {
  language: "multilingual",
  stemmer: searchStem,
} as const;

/**
 * What the reader typed as a pattern over the content as written, for the
 * dialog's highlight: each letter with any diacritics or tatweel after it,
 * every alef form for an alef, a ta marbuta for a ha and an alef maqsura for
 * a ya, so a highlight finds what the search found. Each word is its stem,
 * then the rest of an Arabic word, and the article when the reader typed one.
 * Words are alternatives.
 */
export function foldedPattern(typed: string): RegExp | undefined {
  const words = searchText(typed).split(whitespace).filter(Boolean);
  if (words.length === 0) {
    return;
  }
  const letter = (c: string) =>
    (letterForms[c] ?? c.replace(reserved, "\\$&")) + marks;
  const pattern = (word: string) => {
    const lead = article.test(word) ? articleForms : "";
    const tail = arabic.test(word) ? arabicTail : "";
    return lead + [...stem(word)].map(letter).join("") + tail;
  };
  return new RegExp(words.map(pattern).join("|"), "gi");
}

const whitespace = /\s+/;
/** The characters a pattern reserves, matched as themselves. */
const reserved = /[.*+?^${}()|[\]\\]/g;
/** Diacritics and tatweel, which may follow any letter of the content. */
const marks = "[\\u064B-\\u065F\\u0670\\u0640]*";
const alef = "[اأإآ]";
const ha = "[هة]";
const ya = "[يى]";
const arabic = /[\u0621-\u064A]/;
/** The article in the content, which may be there or not. */
const articleForms = `(?:[وفبك]?${alef}ل${marks}|لل${marks})?`;
/** The rest of an Arabic word after its stem: an ending the search cut off. */
const arabicTail = "[\\u0621-\\u064A\\u064B-\\u065F\\u0670\\u0640]*";
const letterForms: Readonly<Record<string, string>> = {
  ا: alef,
  أ: alef,
  إ: alef,
  آ: alef,
  ه: ha,
  ي: ya,
  ى: ya,
};

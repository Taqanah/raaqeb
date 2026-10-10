/**
 * Content (CONTEXT.md "Content"): the prose an operator writes for
 * visitors, one text per locale. A page's content needs the page
 * language's text and an install-wide one (a component, an incident, a
 * maintenance window) the install language's; any other locale's is
 * optional. A reader sees their locale's text, else the page language's,
 * else whichever locale has one, so a view is never blank. Stored as JSON
 * text in the column the single text used to hold.
 */
import { z } from "zod";
import { type Locale, localeSchema, locales } from "@/shared/i18n/locale.ts";

/** One text per locale; a locale without text has no key. */
export type Content = Readonly<Partial<Record<Locale, string>>>;

/** What a form holds of content: each locale's text as typed, empty where there is none. */
export type ContentDraft = Readonly<Record<Locale, string>>;

/** Content as storage and a view's document carry it: each locale's text, its shape alone checked. */
export const contentShapeSchema = z
  .partialRecord(localeSchema, z.string())
  .describe(
    "The operator's text in each locale it is written in; a locale left empty has no key. A reader sees their locale's text, else the page language's, else the one there is."
  );

/** Content an operator writes: each locale's text trimmed and at most `max` characters, an empty one dropped; one locale at least holds text. */
export function contentSchema(max: number) {
  return typedSchema(max).refine((content) => hasAny(content));
}

/** The same, where no text in any locale is no content. */
export function optionalContentSchema(max: number) {
  return typedSchema(max)
    .transform((content) => (hasAny(content) ? content : undefined))
    .optional();
}

/** Each locale's text trimmed, at most `max` characters, an empty one dropped. */
function typedSchema(max: number) {
  return z
    .partialRecord(localeSchema, z.string().trim().max(max))
    .transform(
      (typed): Content =>
        Object.fromEntries(
          Object.entries(typed).filter(([, text]) => text !== "")
        )
    );
}

function hasAny(content: Content): boolean {
  return locales.some((locale) => hasText(content, locale));
}

/** Whether the content holds the locale's text. */
export function hasText(content: Content | undefined, locale: Locale): boolean {
  return (content?.[locale] ?? "") !== "";
}

/** Whether each piece of content holds the locale's text, the one a save requires; optional content left out holds nothing to check. */
export function writtenIn(
  locale: Locale,
  ...contents: readonly (Content | undefined)[]
): boolean {
  return contents.every(
    (content) => content === undefined || hasText(content, locale)
  );
}

/** Whether a form's content holds the locale's text, as a save requires; optional content left empty in every locale holds nothing to check. */
export function draftWrittenIn(
  draft: ContentDraft,
  locale: Locale,
  required: boolean
): boolean {
  const typed = (each: Locale) => draft[each].trim() !== "";
  return typed(locale) || !(required || locales.some(typed));
}

/** What a form shows for each locale: the content's text, empty where it has none. */
export function contentDraftOf(content: Content | undefined): ContentDraft {
  return { ar: content?.ar ?? "", en: content?.en ?? "" };
}

/** What a reader in `locale` sees: its own text, else the fallback locale's, else the first locale's that has one; empty with none. */
export function contentIn(
  content: Content | undefined,
  locale: Locale,
  fallback?: Locale
): string {
  const shown = shownLocale(content, locale, fallback);
  return shown ? (content?.[shown] ?? "") : "";
}

/** The locale whose text `contentIn` shows; nothing when the content has none. */
export function shownLocale(
  content: Content | undefined,
  locale: Locale,
  fallback?: Locale
): Locale | undefined {
  const order = fallback
    ? [locale, fallback, ...locales]
    : [locale, ...locales];
  return order.find((each) => hasText(content, each));
}

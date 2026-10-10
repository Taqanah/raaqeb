/**
 * The operator's content on a status page (CONTEXT.md "Content"): a visitor reads each name, description, title and link label in
 * the view's locale, else in the page language, else in the one locale it
 * is written in, never a blank. It takes the direction of the locale it is
 * written in through `dir`, whatever letter it starts with, and that
 * locale's `lang`. A `<bdi>` would let a leading brand name ("Raaqeb.
 * ...") turn an Arabic line left to right; it stays for machine tokens. An
 * incident's and a window's text keeps its own rule, each paragraph by its
 * first letter.
 */
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
} from "react";
import {
  type Direction,
  defaultLocale,
  directionOf,
  type Locale,
} from "@/shared/i18n/locale.ts";
import { type Content, shownLocale } from "@/shared/schemas/content.ts";

interface Languages {
  readonly page: Locale;
  readonly view: Locale;
}

const PageLanguages = createContext<Languages | undefined>(undefined);

/** Gives the frame's content the page language and the view's locale; the page's frame wraps every view in it. */
export function PageProse({
  children,
  locale,
  view,
}: {
  readonly children: ReactNode;
  /** The page language. */
  readonly locale: Locale;
  /** The locale the view is read in. */
  readonly view: Locale;
}): ReactNode {
  return (
    <PageLanguages value={{ page: locale, view }}>{children}</PageLanguages>
  );
}

/** What a visitor reads of one piece of content: its text, and the direction and `lang` of the locale it is written in; neither outside a page, so the document's hold. */
export interface Shown {
  readonly dir: Direction | undefined;
  readonly lang: Locale | undefined;
  readonly text: string;
}

/** Reads content as the view shows it. */
export function useContent(): (content: Content | undefined) => Shown {
  const languages = useContext(PageLanguages);
  return (content) => {
    const written = shownLocale(
      content,
      languages?.view ?? defaultLocale,
      languages?.page
    );
    const text = written ? (content?.[written] ?? "") : "";
    return languages && written
      ? { dir: directionOf(written), lang: written, text }
      : { dir: undefined, lang: undefined, text };
  };
}

/** One piece of the operator's inline content as a span in its own direction; a `dir` isolates it from the text around it as a `<bdi>` would. */
export function Prose({
  content,
  ...props
}: Omit<ComponentProps<"span">, "children" | "content" | "dir" | "lang"> & {
  readonly content: Content | undefined;
}): ReactNode {
  const shown = useContent()(content);
  return (
    <span {...props} dir={shown.dir} lang={shown.lang}>
      {shown.text}
    </span>
  );
}

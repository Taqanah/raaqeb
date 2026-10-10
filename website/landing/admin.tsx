/**
 * The admin in real screenshots of a seeded install: the monitors
 * list, and the monitor's detail over its corner.
 * One image per theme and locale under ./shots, named
 * <locale>-<theme>-<screen>.webp; the stylesheet shows the one the page's theme calls for.
 */
import type { ReactNode } from "react";
import type { Copy } from "~/copy.ts";
import { Section } from "./section.tsx";

const shots: Readonly<Record<string, string>> = import.meta.glob(
  "./shots/*.webp",
  { eager: true, import: "default", query: "?url" }
);

/** The screenshot of a screen in a locale and theme, if it exists. */
export function shot(
  locale: string,
  theme: "light" | "dark",
  screen: string
): string | undefined {
  return shots[`./shots/${locale}-${theme}-${screen}.webp`];
}

export function Admin({ copy }: { readonly copy: Copy }): ReactNode {
  return (
    <Section id="admin" lead={copy.admin.lead} title={copy.admin.title}>
      <div className="relative mt-16 pb-[22%] max-lg:space-y-6 max-lg:pb-0">
        <div className="edge w-[76%] overflow-hidden rounded-xl bg-surface shadow-[0_24px_48px_-28px_oklch(0%_0_0/0.3)] max-lg:w-auto">
          <Shot alt={copy.admin.alt} locale={copy.locale} screen="monitors" />
        </div>
        <div className="edge absolute end-0 bottom-0 w-[62%] overflow-hidden rounded-xl bg-surface shadow-[0_40px_80px_-32px_oklch(0%_0_0/0.5)] max-lg:static max-lg:w-auto">
          <Shot alt={copy.admin.alt} locale={copy.locale} screen="detail" />
        </div>
      </div>
    </Section>
  );
}

/** A screen in both themes; the stylesheet shows one. */
export function Shot({
  alt,
  className = "aspect-[16/10]",
  locale,
  screen,
}: {
  readonly alt: string;
  /** The picture's box; a 16 by 10 window by default. */
  readonly className?: string;
  readonly locale: string;
  readonly screen: string;
}): ReactNode {
  const light = shot(locale, "light", screen);
  const dark = shot(locale, "dark", screen);
  return (
    <div className={`overflow-hidden ${className}`}>
      {light ? (
        <img
          alt={alt}
          className="shot-light size-full object-cover object-top"
          height={900}
          loading="lazy"
          src={light}
          width={1440}
        />
      ) : null}
      {dark ? (
        <img
          alt={alt}
          className="shot-dark size-full object-cover object-top"
          height={900}
          loading="lazy"
          src={dark}
          width={1440}
        />
      ) : null}
    </div>
  );
}

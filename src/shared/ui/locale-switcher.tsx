/**
 * The language switcher of the sign-in and onboarding pages:
 * one plain link per locale to the same path with `?locale=`, a full document
 * load because each rendered locale inlines its own catalog. Each language is
 * named in itself, so the labels never cross the catalog.
 */
import type { ReactNode } from "react";
import { directionOf, type Locale, locales } from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { cn } from "./cn.ts";

export const localeNames: Readonly<Record<Locale, string>> = {
  ar: "العربية",
  en: "English",
};

export interface LocaleSwitcherProps {
  /** The locale the document is in; its link is marked current. */
  readonly current: Locale;
}

export function LocaleSwitcher({ current }: LocaleSwitcherProps): ReactNode {
  const { t } = useMessages();
  return (
    <nav
      aria-label={t("app_language")}
      className="flex items-center justify-center gap-4 text-sm"
    >
      {locales.map((locale) => (
        <a
          aria-current={locale === current ? "page" : undefined}
          className={cn(
            "rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring-soft",
            locale === current ? "text-foreground" : "text-muted-foreground"
          )}
          dir={directionOf(locale)}
          href={`?locale=${locale}`}
          key={locale}
          lang={locale}
        >
          {localeNames[locale]}
        </a>
      ))}
    </nav>
  );
}

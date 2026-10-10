/**
 * A visitor's theme (ADR-0006): system, light or dark, kept in
 * the browser's local storage and never sent to the server, so each locale
 * is one rendered document. An inline script sets it on `<html>` before the
 * first paint, falling back to the page's own default; the switch in the
 * footer changes it after mount.
 */
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { type Theme, themes } from "@/shared/schemas/appearance.ts";
import { cn } from "@/shared/ui/cn.ts";

/** Where the browser keeps the visitor's choice. */
export const themeStorageKey = "raaqeb-theme";

/** The script that sets the stored theme, or the page's default, on `<html>` before first paint. */
export function themeScript(fallback: Theme): string {
  const known = JSON.stringify(themes);
  return `(function(){var t;try{t=localStorage.getItem(${JSON.stringify(themeStorageKey)})}catch(e){}if(${known}.indexOf(t)<0)t=${JSON.stringify(fallback)};document.documentElement.setAttribute("data-theme",t)})()`;
}

const themeWords: Readonly<Record<Theme, MessageId>> = {
  dark: "setting_theme_dark",
  light: "setting_theme_light",
  system: "setting_theme_system",
};

function storedTheme(): Theme | undefined {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return themes.find((theme) => theme === stored);
  } catch {
    // Storage refused (a private window): the page's default stands.
    return undefined;
  }
}

/** The three themes as one choice; the page's default shows chosen until the browser's own choice is read after mount. */
export function ThemeSwitch({
  fallback,
}: {
  readonly fallback: Theme;
}): ReactNode {
  const { t } = useMessages();
  const [chosen, setChosen] = useState<Theme>(fallback);
  useEffect(() => {
    setChosen(storedTheme() ?? fallback);
  }, [fallback]);
  const choose = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const theme = themes.find((each) => each === event.currentTarget.value);
    if (!theme) {
      return;
    }
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Not kept past this visit; the page still changes.
    }
    document.documentElement.setAttribute("data-theme", theme);
    setChosen(theme);
  }, []);
  return (
    <fieldset
      className="inline-flex rounded-lg bg-subtle p-0.5"
      data-slot="page-theme"
    >
      <legend className="sr-only">{t("public_theme")}</legend>
      {themes.map((theme) => (
        <label
          className={cn(
            "inline-flex h-control cursor-pointer items-center rounded-md px-3 text-muted-foreground text-xs transition-colors has-focus-visible:ring-4 has-focus-visible:ring-ring-soft",
            chosen === theme && "bg-segment text-foreground shadow-xs"
          )}
          key={theme}
        >
          <input
            checked={chosen === theme}
            className="sr-only"
            name="page-theme"
            onChange={choose}
            type="radio"
            value={theme}
          />
          {t(themeWords[theme])}
        </label>
      ))}
    </fieldset>
  );
}

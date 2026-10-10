import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { LocaleSwitcher, localeNames } from "./locale-switcher.tsx";

function render(locale: "ar" | "en", node: ReactNode): string {
  return renderToStaticMarkup(
    <MessagesProvider i18n={createMessages(locale, locale === "ar" ? ar : en)}>
      {node}
    </MessagesProvider>
  );
}

/** The anchors of the rendered switcher, one string each, so attribute order does not matter. */
function anchors(html: string): string[] {
  return html.split("<a ").slice(1);
}

describe("the language switcher", () => {
  test("is one plain link per locale to the same path with ?locale=, a full document load", () => {
    const html = render("ar", <LocaleSwitcher current="ar" />);
    expect(html).toContain('href="?locale=ar"');
    expect(html).toContain('href="?locale=en"');
    expect(html).not.toContain("data-router");
  });

  test("names each language in itself, so the labels are the same in every document", () => {
    expect(localeNames).toEqual({ ar: "العربية", en: "English" });
    const html = render("en", <LocaleSwitcher current="en" />);
    expect(html).toContain("العربية");
    expect(html).toContain("English");
  });

  test("marks the current locale's link as current and gives each link its own language and direction", () => {
    const [arabic, english] = anchors(
      render("en", <LocaleSwitcher current="en" />)
    );
    expect(english).toContain('href="?locale=en"');
    expect(english).toContain('aria-current="page"');
    expect(arabic).toContain('href="?locale=ar"');
    expect(arabic).not.toContain("aria-current");
    expect(arabic).toContain('lang="ar"');
    expect(arabic).toContain('dir="rtl"');
    expect(english).toContain('lang="en"');
    expect(english).toContain('dir="ltr"');
  });

  test("is named through the catalog for assistive technology", () => {
    expect(render("ar", <LocaleSwitcher current="ar" />)).toContain(
      'aria-label="اللغة"'
    );
    expect(render("en", <LocaleSwitcher current="en" />)).toContain(
      'aria-label="Language"'
    );
  });
});

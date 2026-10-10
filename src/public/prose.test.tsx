import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Content } from "@/shared/schemas/content.ts";
import { PageProse, Prose, useContent } from "./prose.tsx";

/** A link that reads content itself, as a footer link does. */
function Chip({ content }: { readonly content: Content }): ReactNode {
  const { dir, lang, text } = useContent()(content);
  return (
    <b dir={dir} lang={lang}>
      {text}
    </b>
  );
}

describe("the operator's content on a status page", () => {
  const name = { ar: "الموقع", en: "Website" };

  test("each locale's view shows the text written in it, in its direction", () => {
    expect(
      renderToStaticMarkup(
        <PageProse locale="ar" view="en">
          <Prose content={name} />
        </PageProse>
      )
    ).toBe('<span dir="ltr" lang="en">Website</span>');
    expect(
      renderToStaticMarkup(
        <PageProse locale="ar" view="ar">
          <Prose content={name} />
        </PageProse>
      )
    ).toBe('<span dir="rtl" lang="ar">الموقع</span>');
  });

  test("an empty translation shows the page language's text, in the page language's direction", () => {
    expect(
      renderToStaticMarkup(
        <PageProse locale="ar" view="en">
          <Prose content={{ ar: "الموقع" }} />
          <Chip content={{ ar: "الخصوصية" }} />
        </PageProse>
      )
    ).toBe(
      '<span dir="rtl" lang="ar">الموقع</span><b dir="rtl" lang="ar">الخصوصية</b>'
    );
  });

  test("content written only in the other locale still shows, never a blank", () => {
    expect(
      renderToStaticMarkup(
        <PageProse locale="ar" view="ar">
          <Prose content={{ en: "Website" }} />
        </PageProse>
      )
    ).toBe('<span dir="ltr" lang="en">Website</span>');
  });
});

describe("the direction of the operator's prose", () => {
  test("an Arabic text is right to left, even when it starts with a Latin brand name", () => {
    const html = renderToStaticMarkup(
      <PageProse locale="ar" view="ar">
        <Prose
          content={{
            ar: "Raaqeb. لا مراقبات؛ الحالة مضبوطة يدويا للاختبار.",
          }}
        />
        <Chip content={{ ar: "raaqeb.dev وwww" }} />
      </PageProse>
    );
    expect(html).toBe(
      '<span dir="rtl" lang="ar">Raaqeb. لا مراقبات؛ الحالة مضبوطة يدويا للاختبار.</span><b dir="rtl" lang="ar">raaqeb.dev وwww</b>'
    );
  });

  test("an English text is left to right, even when it starts with an Arabic word", () => {
    const html = renderToStaticMarkup(
      <PageProse locale="en" view="en">
        <Prose content={{ en: "راقب status" }} />
        <Chip content={{ en: "راقب docs" }} />
      </PageProse>
    );
    expect(html).toBe(
      '<span dir="ltr" lang="en">راقب status</span><b dir="ltr" lang="en">راقب docs</b>'
    );
  });

  test("outside a page the content names no direction, so the document's holds", () => {
    expect(renderToStaticMarkup(<Chip content={{ en: "Shop" }} />)).toBe(
      "<b>Shop</b>"
    );
  });
});

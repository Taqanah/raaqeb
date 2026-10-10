/**
 * The docs' content: MDX under website/content/docs, a page's Arabic
 * as `name.mdx` and its English as `name.en.mdx`, at /docs and /en/docs as
 * the landing page's two addresses. A language with no page yet has no docs.
 */
import { defineI18n } from "fumadocs-core/i18n";
import { renderPlaceholder } from "fumadocs-core/mdx-plugins/remark-llms.runtime";
import { llms, loader } from "fumadocs-core/source";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";
import { defaultLocale, locales } from "@/shared/i18n/locale.ts";
import { site } from "~/copy.ts";

/** A language's search index, written once at build time; the browser downloads it on the first search and searches it alone. */
export const searchIndexOf = (language: string) =>
  `/docs/search/${language}.json`;

export const i18n = defineI18n({
  defaultLanguage: defaultLocale,
  // A page missing in one language is missing, never shown in the other.
  fallbackLanguage: null,
  hideLocale: "default-locale",
  languages: [...locales],
});

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    mdxOptions: applyMdxPreset({
      // light-dark() follows the page's color-scheme: the device's, or the reader's pick in the theme switch.
      rehypeCodeOptions: {
        // The code element names its language, which the code block's bar shows.
        addLanguageClass: true,
        defaultColor: "light-dark()",
        themes: { dark: "github-dark", light: "github-light" },
      },
    }),
    // The Markdown copy reads as plain Markdown, without Fumadocs' `[#id]` heading syntax; the API reference's tags stay placeholders that renderPage fills.
    postprocess: {
      includeProcessedMarkdown: {
        headingIds: false,
        mdxAsPlaceholder: ["ApiOperation", "ApiWebhook"],
      },
    },
  },
});

export const source = loader({
  baseUrl: "/docs",
  i18n,
  source: docs.toFumadocsSource(),
});

/** The pages as Markdown for agents: /llms.txt, /llms-full.txt and each page's .md copy. */
export const docsLlms = llms(source, {
  renderPage: async (page) => {
    // Imported here, so the OpenAPI document's schemas stay out of every docs page's browser bundle.
    const { apiMarkdownFor } = await import("./api/markdown.ts");
    const text = await renderPlaceholder(
      await page.data.getText("processed"),
      apiMarkdownFor(page.locale)
    );
    const lead = page.data.description ? `> ${page.data.description}\n\n` : "";
    return withSite(
      `# ${page.data.title} (${site}${page.url})\n\n${lead}${text.trim()}\n`
    );
  },
});

/** The languages the docs have pages in; until a language's pages are written, it has no docs. */
export function writtenLanguages(): string[] {
  return source
    .getLanguages()
    .filter((l) => l.pages.length > 0)
    .map((l) => l.language);
}

/** Markdown whose site-relative links name the website, so a copy read away from it still points home. */
export function withSite(markdown: string): string {
  return markdown.replaceAll("](/", `](${site}/`);
}

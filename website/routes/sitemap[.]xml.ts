import { createFileRoute } from "@tanstack/react-router";
import { locales } from "@/shared/i18n/locale.ts";
import { site } from "~/copy.ts";
import { source } from "~/docs/source.ts";
import { homePath } from "~/locale.ts";
import { languageLinks, type Version } from "~/seo.ts";

/** One address and its versions in each language, as the sitemap's hreflang links. */
function entry(url: string, versions: readonly Version[]): string {
  const links = languageLinks(versions)
    .map(
      ({ href, hrefLang }) =>
        `<xhtml:link rel="alternate" hreflang="${hrefLang}" href="${href}"/>`
    )
    .join("");
  return `<url><loc>${site}${url}</loc>${links}</url>`;
}

// The landing page in both languages, then every docs page with its twin in the other language.
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const home = locales.map((l) => ({ locale: l, url: homePath[l] }));
        const pages = [
          ...home.map(({ url }) => entry(url, home)),
          ...source.getLanguages().flatMap(({ pages: written }) =>
            written.map((page) =>
              entry(
                page.url,
                locales.flatMap((l) => {
                  const twin = source.getPage(page.slugs, l);
                  return twin ? [{ locale: l, url: twin.url }] : [];
                })
              )
            )
          ),
        ];
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${pages.join("\n")}\n</urlset>\n`,
          { headers: { "Content-Type": "application/xml; charset=utf-8" } }
        );
      },
    },
  },
});

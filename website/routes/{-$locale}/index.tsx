import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { defaultLocale, locales } from "@/shared/i18n/locale.ts";
import { copies, installCommand, repository, site } from "~/copy.ts";
import { Landing } from "~/landing/page.tsx";
import { homePath, pageLocale } from "~/locale.ts";
import { jsonLd, languageLinks, previewImage, previewMeta } from "~/seo.ts";

// The landing page: Arabic at the bare path, English under /en, each naming the other for search engines.
export const Route = createFileRoute("/{-$locale}/")({
  beforeLoad: ({ params }) => {
    if (!pageLocale(params.locale)) {
      throw notFound();
    }
  },
  component: Page,
  head: ({ params }) => {
    const locale = pageLocale(params.locale) ?? defaultLocale;
    const { brand, description, preview, title } = copies[locale];
    const url = `${site}${homePath[locale]}`;
    return {
      links: [
        { href: url, rel: "canonical" },
        ...languageLinks(
          locales.map((l) => ({ locale: l, url: homePath[l] }))
        ).map((link) => ({ ...link, rel: "alternate" })),
      ],
      meta: [
        { title },
        { content: description, name: "description" },
        { content: title, property: "og:title" },
        { content: description, property: "og:description" },
        { content: url, property: "og:url" },
        { content: "website", property: "og:type" },
        ...previewMeta(locale, title, description, preview),
      ],
      // What the page is about, for search engines: the site, and the software it offers for free.
      scripts: [
        jsonLd({
          "@graph": [
            {
              "@id": `${site}/#website`,
              "@type": "WebSite",
              inLanguage: locale,
              name: brand,
              url: `${site}/`,
            },
            {
              "@type": "SoftwareApplication",
              alternateName: locale === "ar" ? "Raaqeb" : "راقب",
              applicationCategory: "DeveloperApplication",
              applicationSubCategory: "Uptime monitoring",
              description,
              downloadUrl: installCommand
                .split(" ")
                .find((w) => w.startsWith("https://")),
              image: previewImage[locale],
              inLanguage: ["ar", "en"],
              isPartOf: { "@id": `${site}/#website` },
              name: brand,
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
              operatingSystem: "Linux, macOS, Windows",
              sameAs: [repository],
              url,
            },
          ],
        }),
      ],
    };
  },
});

function Page(): ReactNode {
  const { locale } = Route.useParams();
  return <Landing locale={pageLocale(locale) ?? defaultLocale} />;
}

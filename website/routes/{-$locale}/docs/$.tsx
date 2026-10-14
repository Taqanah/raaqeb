import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import type { ReactNode } from "react";
import { type Locale, locales } from "@/shared/i18n/locale.ts";
import { copies, docsPath, site } from "~/copy.ts";
import { markdownUrl } from "~/docs/markdown.ts";
import { DocsView } from "~/docs/page.tsx";
import { docs, source } from "~/docs/source.ts";
import { pageLocale } from "~/locale.ts";
import { jsonLd, languageLinks, previewMeta } from "~/seo.ts";

// A docs page and the sidebar's tree; prerender writes each answer to a JSON file, so following a link needs no server.
const loadPage = createServerFn({ method: "GET" })
  // Typed, not parsed: it answers only the prerender, never a visitor, since the built site has no server.
  .validator((input: { locale: Locale; slugs: string[] }) => input)
  .middleware([staticFunctionMiddleware])
  .handler(async ({ data: { locale, slugs } }) => {
    const page = source.getPage(slugs, locale);
    if (!page) {
      return null;
    }
    // The same page in each language that has it: the language switch offers these alone, and search engines read them as alternates.
    const alternates = locales.flatMap((l) => {
      const twin = source.getPage(page.slugs, l);
      return twin ? [{ locale: l, url: twin.url }] : [];
    });
    return {
      alternates,
      description: page.data.description,
      locale,
      markdownUrl: markdownUrl(page),
      path: page.path,
      title: page.data.title,
      tree: await source.serializePageTree(source.getPageTree(locale)),
      url: page.url,
    };
  });

export const Route = createFileRoute("/{-$locale}/docs/$")({
  // The loader in a chunk of its own, so the landing page never downloads the docs' source.
  codeSplitGroupings: [["loader"], ["component"]],
  component: Page,
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {};
    }
    const title = `${loaderData.title} | ${copies[loaderData.locale].brand}`;
    return {
      links: [
        { href: `${site}${loaderData.url}`, rel: "canonical" },
        ...languageLinks(loaderData.alternates).map((link) => ({
          ...link,
          rel: "alternate",
        })),
      ],
      meta: [
        { title },
        { content: loaderData.description, name: "description" },
        { content: title, property: "og:title" },
        { content: loaderData.description, property: "og:description" },
        { content: `${site}${loaderData.url}`, property: "og:url" },
        { content: "article", property: "og:type" },
        ...previewMeta(
          loaderData.locale,
          title,
          loaderData.description ?? "",
          copies[loaderData.locale].preview
        ),
      ],
      scripts: [
        jsonLd({
          "@type": "TechArticle",
          description: loaderData.description,
          headline: loaderData.title,
          inLanguage: loaderData.locale,
          isPartOf: { "@id": `${site}/#website` },
          url: `${site}${loaderData.url}`,
        }),
      ],
    };
  },
  // The parameter is annotated by hand, as the product's routes do: inferred,
  // it makes the loader's type depend on this route, and TypeScript then
  // infers the loader as nothing (src/routes/__root.tsx).
  loader: async ({
    params,
  }: {
    params: { locale?: string; _splat?: string };
  }) => {
    const locale = pageLocale(params.locale);
    const page = locale
      ? await loadPage({
          data: {
            locale,
            slugs: params._splat?.split("/").filter(Boolean) ?? [],
          },
        })
      : null;
    if (!page) {
      throw notFound();
    }
    await docs.getPage(page.path)?.preload();
    return page;
  },
});

function Page(): ReactNode {
  const data = useFumadocsLoader(Route.useLoaderData());
  const other = data.locale === "ar" ? "en" : "ar";
  return (
    <DocsView
      locale={data.locale}
      markdownUrl={data.markdownUrl}
      // The same page in the other language, or that language's docs when this one has no twin.
      otherUrl={
        data.alternates.find((a) => a.locale === other)?.url ?? docsPath[other]
      }
      path={data.path}
      tree={data.tree}
    />
  );
}

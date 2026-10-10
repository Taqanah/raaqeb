import { createFileRoute, notFound } from "@tanstack/react-router";
import { slugsOfMarkdown } from "~/docs/markdown.ts";
import { docsLlms, source } from "~/docs/source.ts";
import { pageLocale } from "~/locale.ts";

// A docs page as Markdown, for an agent or a reader who wants the source.
export const Route = createFileRoute("/{-$locale}/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const locale = pageLocale(params.locale);
        const page =
          locale && source.getPage(slugsOfMarkdown(params._splat), locale);
        if (!page) {
          throw notFound();
        }
        return new Response(await docsLlms.page(page), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});

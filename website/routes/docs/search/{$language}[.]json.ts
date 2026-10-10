import { createFileRoute, notFound } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";
import { languageIndex } from "~/docs/search-index.ts";
import { searchTokenizer } from "~/docs/search-text.ts";
import { source } from "~/docs/source.ts";

const search = createFromSource(source, {
  // One database per language (Fumadocs' deprecated option), so each language exports its own index.
  localeMap: { ar: "multilingual", en: "multilingual" },
  // No sort index: results rank by relevance alone, and the index is a quarter smaller.
  sort: { enabled: false },
  tokenizer: searchTokenizer,
});

// One language's search index, written at build time for the browser to search alone.
export const Route = createFileRoute("/docs/search/{$language}.json")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const index = await languageIndex(search, params.language);
        if (!index) {
          throw notFound();
        }
        return Response.json(index);
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { docsLlms, withSite, writtenLanguages } from "~/docs/source.ts";

// The docs' index for agents (llmstxt.org): every page's title, address and description.
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(
          withSite(
            (
              await Promise.all(
                writtenLanguages().map((l) => docsLlms.index(l))
              )
            ).join("\n\n")
          ),
          {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        ),
    },
  },
});

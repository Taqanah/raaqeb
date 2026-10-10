import { createFileRoute } from "@tanstack/react-router";
import { docsLlms, writtenLanguages } from "~/docs/source.ts";

// Every docs page as Markdown in one file, for an agent that reads the whole.
export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(
          (
            await Promise.all(writtenLanguages().map((l) => docsLlms.full(l)))
          ).join("\n\n"),
          {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        ),
    },
  },
});

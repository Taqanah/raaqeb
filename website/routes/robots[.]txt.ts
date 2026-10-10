import { createFileRoute } from "@tanstack/react-router";
import { site } from "~/copy.ts";

// Every page is open to crawlers; the sitemap names them all, with each page's other language.
export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`,
          {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        ),
    },
  },
});

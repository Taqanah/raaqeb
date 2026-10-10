import { createFileRoute } from "@tanstack/react-router";
import { resourceAnswer } from "@/routes/-resources.ts";

// A page's feed at /status/<slug>, the other locale under its prefix.
export const Route = createFileRoute("/{-$locale}/status/$slug/feed.atom")({
  server: {
    handlers: {
      GET: ({ context }) => resourceAnswer(context),
      HEAD: ({ context }) => resourceAnswer(context),
    },
  },
});

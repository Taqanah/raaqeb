import { createFileRoute } from "@tanstack/react-router";
import { resourceAnswer } from "@/routes/-resources.ts";

// A page's badge at /status/<slug>, the other locale under its prefix.
export const Route = createFileRoute("/{-$locale}/status/$slug/badge.svg")({
  server: {
    handlers: {
      GET: ({ context }) => resourceAnswer(context),
      HEAD: ({ context }) => resourceAnswer(context),
    },
  },
});

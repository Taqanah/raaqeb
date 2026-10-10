import { createFileRoute } from "@tanstack/react-router";
import { resourceAnswer } from "@/routes/-resources.ts";

// A page's Statuspage-compatible summary at /status/<slug>, with no locale prefix.
export const Route = createFileRoute("/status/$slug/api/v2/summary.json")({
  server: {
    handlers: {
      GET: ({ context }) => resourceAnswer(context),
      HEAD: ({ context }) => resourceAnswer(context),
    },
  },
});

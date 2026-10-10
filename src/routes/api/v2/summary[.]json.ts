import { createFileRoute } from "@tanstack/react-router";
import { resourceAnswer } from "@/routes/-resources.ts";

// The Statuspage-compatible summary of the page at the bare host: the default page, or a custom domain's.
export const Route = createFileRoute("/api/v2/summary.json")({
  server: {
    handlers: {
      GET: ({ context }) => resourceAnswer(context),
      HEAD: ({ context }) => resourceAnswer(context),
    },
  },
});

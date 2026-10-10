import { createFileRoute } from "@tanstack/react-router";
import { resourceAnswer } from "@/routes/-resources.ts";

// The page's badge at its plain address, the other locale under its prefix.
export const Route = createFileRoute("/{-$locale}/badge.svg")({
  server: {
    handlers: {
      GET: ({ context }) => resourceAnswer(context),
      HEAD: ({ context }) => resourceAnswer(context),
    },
  },
});

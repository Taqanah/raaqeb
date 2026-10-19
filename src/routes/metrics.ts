import { createFileRoute } from "@tanstack/react-router";
import { scrape } from "@/server/metrics/scrape.ts";

// GET /metrics: a plain server route like /health, behind the metrics
// token instead of a session. Nothing before an install has a database.
export const Route = createFileRoute("/metrics")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        context.storage
          ? scrape(context.storage, request.headers.get("authorization"))
          : new Response(null, { status: 404 }),
    },
  },
});

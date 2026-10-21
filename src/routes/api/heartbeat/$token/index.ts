import { createFileRoute } from "@tanstack/react-router";
import { ingest } from "@/routes/-heartbeat.ts";

// Heartbeat ingest: public, the token is the only key.
export const Route = createFileRoute("/api/heartbeat/$token/")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        ingest(context.storage, params.token, request, false),
      HEAD: ({ context, params, request }) =>
        ingest(context.storage, params.token, request, false),
      POST: ({ context, params, request }) =>
        ingest(context.storage, params.token, request, false),
    },
  },
});

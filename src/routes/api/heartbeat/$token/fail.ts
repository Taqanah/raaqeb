import { createFileRoute } from "@tanstack/react-router";
import { ingest } from "@/routes/-heartbeat.ts";

// The same heartbeat ingest, at the address that says the job failed.
export const Route = createFileRoute("/api/heartbeat/$token/fail")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        ingest(context.storage, params.token, request, true),
      HEAD: ({ context, params, request }) =>
        ingest(context.storage, params.token, request, true),
      POST: ({ context, params, request }) =>
        ingest(context.storage, params.token, request, true),
    },
  },
});

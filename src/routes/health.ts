import { createFileRoute } from "@tanstack/react-router";
import { healthReport, healthResponse } from "@/server/scheduler/health.ts";

// GET /health: unauthenticated, part of the public API. The
// scheduler arrives with the storage as Start's request context.
export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async ({ context }) =>
        healthResponse(
          await healthReport(context.storage, context.scheduler, Date.now())
        ),
    },
  },
});

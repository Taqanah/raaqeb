import { createFileRoute } from "@tanstack/react-router";
import { answerResults, probeGate } from "@/server/probes/api.ts";

// POST /api/probe/v1/results: a probe's latest results, behind its probe
// token; no cookie is read, so no CSRF check applies.
export const Route = createFileRoute("/api/probe/v1/results")({
  server: {
    handlers: {
      POST: ({ context, request }) =>
        answerResults(
          {
            gate: probeGate,
            now: Date.now(),
            scheduler: context.scheduler,
            storage: context.storage,
          },
          request
        ),
    },
  },
});

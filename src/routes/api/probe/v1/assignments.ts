import { createFileRoute } from "@tanstack/react-router";
import { answerAssignments, probeGate } from "@/server/probes/api.ts";

// GET /api/probe/v1/assignments: a probe's own monitors, behind its probe
// token instead of a session; a plain server route like /metrics.
export const Route = createFileRoute("/api/probe/v1/assignments")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        answerAssignments(
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

import { createFileRoute } from "@tanstack/react-router";
import type { RequestContext } from "@/handler.ts";
import { documentAnswer } from "@/routes/-resources.ts";
import { readIncidentView, viewResponse } from "@/server/pages/views.ts";

// One incident as a status page shows it: public on
// any host; an incident on no component the page shows is not found.
function answer(
  context: RequestContext,
  pageId: string,
  incidentId: string
): Promise<Response> {
  return documentAnswer(context, async () =>
    viewResponse(
      context.storage &&
        (await readIncidentView(context.storage, pageId, incidentId))
    )
  );
}

export const Route = createFileRoute("/api/pages/$id/incidents/$incidentId")({
  server: {
    handlers: {
      GET: ({ context, params }) =>
        answer(context, params.id, params.incidentId),
      HEAD: ({ context, params }) =>
        answer(context, params.id, params.incidentId),
    },
  },
});

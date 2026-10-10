import { createFileRoute } from "@tanstack/react-router";
import type { RequestContext } from "@/handler.ts";
import { documentAnswer } from "@/routes/-resources.ts";
import { readMaintenanceView, viewResponse } from "@/server/pages/views.ts";

// One maintenance window as a status page shows it:
// public on any host; a window on no component the page shows is not found.
function answer(
  context: RequestContext,
  pageId: string,
  windowId: string
): Promise<Response> {
  return documentAnswer(context, async () =>
    viewResponse(
      context.storage &&
        (await readMaintenanceView(context.storage, pageId, windowId))
    )
  );
}

export const Route = createFileRoute("/api/pages/$id/maintenance/$windowId")({
  server: {
    handlers: {
      GET: ({ context, params }) => answer(context, params.id, params.windowId),
      HEAD: ({ context, params }) =>
        answer(context, params.id, params.windowId),
    },
  },
});

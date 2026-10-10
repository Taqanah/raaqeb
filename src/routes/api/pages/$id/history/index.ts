import { createFileRoute } from "@tanstack/react-router";
import type { RequestContext } from "@/handler.ts";
import { documentAnswer } from "@/routes/-resources.ts";
import { readHistory, viewResponse } from "@/server/pages/views.ts";

// A status page's history for the current month:
// public on any host; the entry's memo keeps it and answers 304 while
// nothing changed.
function answer(context: RequestContext, pageId: string): Promise<Response> {
  return documentAnswer(context, async () =>
    viewResponse(
      context.storage &&
        (await readHistory(context.storage, pageId, undefined, Date.now()))
    )
  );
}

export const Route = createFileRoute("/api/pages/$id/history/")({
  server: {
    handlers: {
      GET: ({ context, params }) => answer(context, params.id),
      HEAD: ({ context, params }) => answer(context, params.id),
    },
  },
});

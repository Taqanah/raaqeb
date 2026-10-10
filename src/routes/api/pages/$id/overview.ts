import { createFileRoute } from "@tanstack/react-router";
import { documentAnswer } from "@/routes/-resources.ts";
import { overviewResponse } from "@/server/pages/overview.ts";

// A status page's overview document: public
// on any host, the one source its overview renders from; the entry's memo
// keeps it and answers 304 while nothing changed.
export const Route = createFileRoute("/api/pages/$id/overview")({
  server: {
    handlers: {
      GET: ({ context, params }) =>
        documentAnswer(context, () =>
          overviewResponse(context.storage, params.id, Date.now())
        ),
      HEAD: ({ context, params }) =>
        documentAnswer(context, () =>
          overviewResponse(context.storage, params.id, Date.now())
        ),
    },
  },
});

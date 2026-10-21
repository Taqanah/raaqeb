import { createFileRoute } from "@tanstack/react-router";
import { documentAnswer } from "@/routes/-resources.ts";
import { overviewResponse } from "@/server/pages/overview.ts";

// A status page's overview document on any host, to whoever the page's
// access lets in (everyone, for a public page), the one source its overview
// renders from; the entry's memo keeps it and answers 304 while nothing
// changed, a private page's to a request with access alone.
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

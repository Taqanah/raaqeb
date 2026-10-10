import { createFileRoute } from "@tanstack/react-router";
import { documentAnswer } from "@/routes/-resources.ts";
import { readHistory, viewResponse } from "@/server/pages/views.ts";
import { monthSchema } from "@/shared/schemas/views.ts";

// A status page's history for one month, yyyy-mm:
// public on any host; a month that is not one is not found.
async function answer(
  storage: Parameters<typeof readHistory>[0] | undefined,
  pageId: string,
  text: string
): Promise<Response> {
  const month = monthSchema.safeParse(text);
  if (!month.success) {
    return viewResponse({ ok: false, reason: "not_found" });
  }
  return viewResponse(
    storage && (await readHistory(storage, pageId, month.data, Date.now()))
  );
}

export const Route = createFileRoute("/api/pages/$id/history/$month")({
  server: {
    handlers: {
      GET: ({ context, params }) =>
        documentAnswer(context, () =>
          answer(context.storage, params.id, params.month)
        ),
      HEAD: ({ context, params }) =>
        documentAnswer(context, () =>
          answer(context.storage, params.id, params.month)
        ),
    },
  },
});

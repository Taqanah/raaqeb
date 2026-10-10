import { createFileRoute } from "@tanstack/react-router";
import { originChecked, signedIn } from "@/routes/-transfer.ts";
import { importInstall } from "@/server/export/import.ts";

/** Bun closes a quiet connection after about ten seconds; sealing the last monitor's days may take longer before the answer. */
const answerWithinSeconds = 255;

// The import's upload: the file streams in as the request's body,
// under the session check and the origin check, and the
// answer is the import's result as JSON.
export const Route = createFileRoute("/admin/import")({
  server: {
    middleware: [originChecked],
    handlers: {
      POST: async ({ context, request }) => {
        const operator = await signedIn(context, request);
        if (!operator) {
          return new Response(null, { status: 401 });
        }
        context.holdOpen(answerWithinSeconds);
        const answer = await importInstall(
          context.storage,
          context.boot.installKey,
          request.body ?? new Blob([]).stream(),
          Date.now()
        );
        const headers = new Headers({ "cache-control": "no-store" });
        if (operator.setCookie) {
          headers.set("set-cookie", operator.setCookie);
        }
        return Response.json(answer, { headers });
      },
    },
  },
});

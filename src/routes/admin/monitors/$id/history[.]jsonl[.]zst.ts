import { createFileRoute } from "@tanstack/react-router";
import { downloadHeaders, signedIn } from "@/routes/-transfer.ts";
import { historyDownload } from "@/server/export/export.ts";
import { historyDownloadSearchSchema } from "@/shared/schemas/export.ts";

// One monitor's history over the chart's range, or the span zoomed into
//: the export's records of that monitor,
// the same JSON Lines under zstd.
/** A zoomed span's edge in a file name, to the UTC minute: `20261002T1413`. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replaceAll(/[-:]/g, "");
}

/** How long a download may take before its first byte. */
const downloadStartsWithinSeconds = 60;

export const Route = createFileRoute("/admin/monitors/$id/history.jsonl.zst")({
  server: {
    handlers: {
      GET: async ({ context, params, request }) => {
        const operator = await signedIn(context, request);
        if (!operator) {
          return Response.redirect(new URL("/sign-in", request.url), 303);
        }
        // The configuration is read, opened and written before the first byte, which Bun's idle timer would otherwise cut at about ten seconds.
        context.holdOpen(downloadStartsWithinSeconds);
        const { from, range, to } = historyDownloadSearchSchema.parse(
          Object.fromEntries(new URL(request.url).searchParams)
        );
        const span =
          from === undefined || to === undefined ? undefined : { from, to };
        const download = await historyDownload(
          context.storage,
          params.id,
          range,
          Date.now(),
          span
        );
        if (!download.ok) {
          return new Response(null, {
            status: download.reason === "not_found" ? 404 : 503,
          });
        }
        return new Response(download.body, {
          headers: downloadHeaders(
            `raaqeb-${params.id}-${span ? `${stamp(span.from)}-${stamp(span.to)}` : range}.jsonl.zst`,
            operator.setCookie
          ),
        });
      },
    },
  },
});

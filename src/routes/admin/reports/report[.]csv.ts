import { createFileRoute } from "@tanstack/react-router";
import { downloadHeaders, signedIn } from "@/routes/-transfer.ts";
import { reportDownload } from "@/server/reports/download.ts";
import { reportDownloadSchema } from "@/shared/schemas/report.ts";

// A report as a CSV file: the page's link asks for it by a plain GET, so the
// browser saves it. A query that is not a report's is a 400, a subject that
// is gone a 404.
const refusals = {
  corrupt: 500,
  invalid: 400,
  not_found: 404,
  unavailable: 503,
} as const;

/** How long a download may take before its first byte. */
const downloadStartsWithinSeconds = 60;

export const Route = createFileRoute("/admin/reports/report.csv")({
  server: {
    handlers: {
      GET: async ({ context, request }) => {
        const operator = await signedIn(context, request, "read");
        if (!operator) {
          return Response.redirect(new URL("/sign-in", request.url), 303);
        }
        // A quarter of many monitors reads a few at a time, which Bun's idle timer would cut at about ten seconds.
        context.holdOpen(downloadStartsWithinSeconds);
        const query = reportDownloadSchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams)
        );
        if (!query.success) {
          return new Response(null, { status: refusals.invalid });
        }
        const { storage } = context;
        if (!storage) {
          return new Response(null, { status: refusals.unavailable });
        }
        const download = await reportDownload(
          storage,
          query.data,
          Date.now(),
          operator.operator.preferences
        );
        if (!download.ok) {
          return new Response(null, { status: refusals[download.reason] });
        }
        return new Response(download.body, {
          headers: downloadHeaders(
            download.name,
            operator.setCookie,
            "text/csv; charset=utf-8"
          ),
        });
      },
    },
  },
});

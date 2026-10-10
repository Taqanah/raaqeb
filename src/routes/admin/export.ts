import { createFileRoute } from "@tanstack/react-router";
import { downloadHeaders, signedIn } from "@/routes/-transfer.ts";
import { exportInstall } from "@/server/export/export.ts";
import { exportFileName, exportModeSchema } from "@/shared/schemas/export.ts";

// The export's download: the settings page's form asks for it by
// a plain GET, so the browser saves the stream as it arrives. A refusal
// before the first byte goes back to the page, which words it.
const settingsPage = "/admin/settings/export";

/** How long a download may take before its first byte. */
const downloadStartsWithinSeconds = 60;

export const Route = createFileRoute("/admin/export")({
  server: {
    handlers: {
      GET: async ({ context, request }) => {
        const operator = await signedIn(context, request);
        if (!operator) {
          return Response.redirect(new URL("/sign-in", request.url), 303);
        }
        // The configuration is read, opened and written before the first byte, which Bun's idle timer would otherwise cut at about ten seconds.
        context.holdOpen(downloadStartsWithinSeconds);
        const mode = exportModeSchema
          .catch("full")
          .parse(new URL(request.url).searchParams.get("mode"));
        const started = await exportInstall(
          context.storage,
          context.boot.installKey,
          mode,
          Date.now()
        );
        if (!started.ok) {
          const back = new URL(settingsPage, request.url);
          back.searchParams.set("refused", started.reason);
          if (started.record) {
            back.searchParams.set("record", started.record);
          }
          return Response.redirect(back, 303);
        }
        return new Response(started.body, {
          headers: downloadHeaders(exportFileName, operator.setCookie),
        });
      },
    },
  },
});

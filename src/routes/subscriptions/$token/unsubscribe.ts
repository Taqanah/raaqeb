import { createFileRoute } from "@tanstack/react-router";
import {
  actionResponse,
  unsubscribe,
} from "@/server/subscriptions/subscriptions.ts";
import { subscriptionPath } from "@/shared/schemas/subscription.ts";

/** Whether a POST is an email client's one-click unsubscribe (RFC 8058): its body is `List-Unsubscribe=One-Click`. */
async function oneClick(request: Request): Promise<boolean> {
  try {
    return (await request.formData()).get("List-Unsubscribe") === "One-Click";
  } catch {
    // A body that is no form is the page's own button.
    return false;
  }
}

// A subscription's unsubscribe: the page's
// button posts here and lands back on the page; an email client's
// List-Unsubscribe-Post posts here too. A GET changes nothing and leads to
// the page, so a mail scanner that opens links unsubscribes no one.
export const Route = createFileRoute("/subscriptions/$token/unsubscribe")({
  server: {
    handlers: {
      GET: ({ params }) =>
        new Response(null, {
          headers: { location: subscriptionPath(params.token) },
          status: 303,
        }),
      POST: async ({ context, params, request }) =>
        actionResponse(
          context.storage
            ? await unsubscribe(context.storage, params.token, Date.now())
            : { ok: false, reason: "unavailable" },
          params.token,
          await oneClick(request)
        ),
    },
  },
});

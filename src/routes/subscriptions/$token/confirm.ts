import { createFileRoute } from "@tanstack/react-router";
import {
  actionResponse,
  confirmSubscription,
} from "@/server/subscriptions/subscriptions.ts";
import { subscriptionPath } from "@/shared/schemas/subscription.ts";

// A subscription's confirm: the button on
// its page posts here and lands back on the page. A GET changes nothing and
// leads to the page, so a mail scanner that opens links confirms no one.
export const Route = createFileRoute("/subscriptions/$token/confirm")({
  server: {
    handlers: {
      GET: ({ params }) =>
        new Response(null, {
          headers: { location: subscriptionPath(params.token) },
          status: 303,
        }),
      POST: async ({ context, params }) =>
        actionResponse(
          context.storage
            ? await confirmSubscription(
                context.storage,
                params.token,
                Date.now()
              )
            : { ok: false, reason: "unavailable" },
          params.token,
          false
        ),
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { answerApi } from "@/routes/-api.ts";

// The management API: every path under /api/v1/, behind an API key
// instead of a session, answered by -api.ts. Every method, so a method no
// operation takes is the API's 405 and never falls through to a render.
export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      ANY: ({ context, request }) => answerApi(context, request),
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { handleAuth } from "@/server/auth/auth.ts";

// Better Auth's handler, mounted at its default base path. Only the
// allowed endpoints answer; the rest are 404 by the disabled-paths list.
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        handleAuth(context.storage, context.boot, request),
      POST: ({ context, request }) =>
        handleAuth(context.storage, context.boot, request),
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { openApiDocument } from "@/shared/api/openapi.ts";

// The OpenAPI document of the public API,
// on any host. It changes only with the binary, so it is built once.
const body = JSON.stringify(openApiDocument());

export const Route = createFileRoute("/api/openapi.json")({
  server: {
    handlers: {
      GET: () =>
        new Response(body, {
          headers: {
            "cache-control": "public, max-age=3600",
            "content-type": "application/json; charset=utf-8",
          },
        }),
    },
  },
});

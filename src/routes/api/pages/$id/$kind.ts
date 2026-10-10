import { createFileRoute } from "@tanstack/react-router";
import type { RequestContext } from "@/handler.ts";
import { isOperator } from "@/server/auth/session.ts";
import { pageImageResponse } from "@/server/pages/images.ts";

// A status page's logo, favicon or cover image: public, on any
// host that serves the page; the URL carries the image's hash, so a new
// image is a new URL and the old one may be cached for a year. An
// unpublished page's is the signed-in operator's alone.
function answer(
  context: RequestContext,
  params: { readonly id: string; readonly kind: string },
  request: Request
): Promise<Response> {
  return pageImageResponse(
    context.storage,
    params.id,
    params.kind,
    request,
    () => isOperator(context.storage, context.boot, request.headers)
  );
}

export const Route = createFileRoute("/api/pages/$id/$kind")({
  server: {
    handlers: {
      GET: ({ context, params, request }) => answer(context, params, request),
      HEAD: ({ context, params, request }) => answer(context, params, request),
    },
  },
});

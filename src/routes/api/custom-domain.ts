import { createFileRoute } from "@tanstack/react-router";
import {
  customDomainResponse,
  customDomainServed,
} from "@/server/pages/custom-domain.ts";
import type { Storage } from "@/server/storage/storage.ts";

// The reverse proxy's question before it issues a certificate on demand:
// public, since a published page's domain is public anyway.
async function answer(
  storage: Storage | undefined,
  request: Request
): Promise<Response> {
  const domain = new URL(request.url).searchParams.get("domain");
  return customDomainResponse(
    await customDomainServed(storage, domain),
    request.method
  );
}

export const Route = createFileRoute("/api/custom-domain")({
  server: {
    handlers: {
      GET: ({ context, request }) => answer(context.storage, request),
      HEAD: ({ context, request }) => answer(context.storage, request),
    },
  },
});

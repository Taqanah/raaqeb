import { createFileRoute } from "@tanstack/react-router";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import {
  heartbeatResponse,
  receiveHeartbeat,
} from "@/server/monitors/heartbeat.ts";
import type { Storage } from "@/server/storage/storage.ts";

// Heartbeat ingest: public, the token is the only key. The
// entry wrote the caller's address behind the trusted proxies into one
// header, overwriting whatever the client sent.
async function ingest(
  storage: Storage | undefined,
  token: string,
  request: Request
): Promise<Response> {
  const receipt = await receiveHeartbeat(
    storage,
    token,
    request.headers.get(clientAddressHeader) ?? undefined,
    Date.now()
  );
  return heartbeatResponse(receipt, request.method);
}

export const Route = createFileRoute("/api/heartbeat/$token")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        ingest(context.storage, params.token, request),
      HEAD: ({ context, params, request }) =>
        ingest(context.storage, params.token, request),
      POST: ({ context, params, request }) =>
        ingest(context.storage, params.token, request),
    },
  },
});

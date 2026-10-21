import { clientAddressHeader } from "@/server/boot/proxies.ts";
import {
  heartbeatResponse,
  readHeartbeatCall,
  receiveHeartbeat,
} from "@/server/monitors/heartbeat.ts";
import type { Storage } from "@/server/storage/storage.ts";

/**
 * One call to a heartbeat URL, whichever route took it: reads what it says of
 * the job, stores it with the caller's address and answers the job. `failAddress`
 * is whether the call came to the address that ends in `/fail`.
 */
export async function ingest(
  storage: Pick<Storage, "heartbeats"> | undefined,
  token: string,
  request: Request,
  failAddress: boolean
): Promise<Response> {
  // Before the body is read, which a slow job may keep waiting.
  const arrivedAt = Date.now();
  const call = await readHeartbeatCall(request, failAddress);
  // The entry wrote the caller's address behind the trusted proxies into one header, overwriting whatever the client sent.
  const receipt = await receiveHeartbeat(
    storage,
    token,
    request.headers.get(clientAddressHeader) ?? undefined,
    arrivedAt,
    call.failure
  );
  return heartbeatResponse(receipt, request.method);
}

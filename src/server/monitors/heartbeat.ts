/**
 * Heartbeat ingest (CONTEXT.md "Heartbeat"): `GET`, `HEAD` or `POST /api/heartbeat/<token>`, unauthenticated
 * beyond the token. A known token stores the heartbeat with its arrival time
 * and source address, even while the monitor is paused, and answers 200
 * `OK`; an unknown one answers 404; no open database answers 503. Nothing
 * is cached and no body is kept.
 */

import type { Storage } from "@/server/storage/storage.ts";
import { heartbeatTokenSchema } from "@/shared/schemas/heartbeat.ts";

/** What one call to a heartbeat URL came to. */
export type HeartbeatReceipt = "recorded" | "unknown" | "unavailable";

/** Stores the heartbeat for the monitor with this token. Text that is not a token never reaches the database. */
export async function receiveHeartbeat(
  storage: Pick<Storage, "heartbeats"> | undefined,
  token: string,
  sourceIp: string | undefined,
  now: number
): Promise<HeartbeatReceipt> {
  if (!storage) {
    return "unavailable";
  }
  if (!heartbeatTokenSchema.safeParse(token).success) {
    return "unknown";
  }
  try {
    const monitorId = await storage.heartbeats.record(token, now, sourceIp);
    return monitorId === undefined ? "unknown" : "recorded";
  } catch {
    return "unavailable";
  }
}

const answers: Readonly<
  Record<HeartbeatReceipt, { status: number; text: string }>
> = {
  recorded: { status: 200, text: "OK" },
  unavailable: { status: 503, text: "Service Unavailable" },
  unknown: { status: 404, text: "Not Found" },
};

/** The answer to the job: 200 `OK`, 404 or 503, plain text, never cached; a `HEAD` gets no body. */
export function heartbeatResponse(
  receipt: HeartbeatReceipt,
  method: string
): Response {
  const { status, text } = answers[receipt];
  return new Response(method === "HEAD" ? null : text, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
    status,
  });
}

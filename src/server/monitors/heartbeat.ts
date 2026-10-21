/**
 * Heartbeat ingest (CONTEXT.md "Heartbeat"): `GET`, `HEAD` or `POST /api/heartbeat/<token>`, unauthenticated
 * beyond the token. A known token stores the heartbeat with its arrival time
 * and source address, even while the monitor is paused, and answers 200
 * `OK`; an unknown one answers 404; no open database answers 503. Nothing
 * is cached.
 *
 * A call may say the job failed: the address `/api/heartbeat/<token>/fail`,
 * `status=fail` (or `down`), or a nonzero `exit` code in the query. It may
 * carry the exit code (0 to 255) and a short message, from the `message` (or
 * `msg`) query or, on a `POST`, the first kilobyte of its body. The message is
 * cleaned and cut; the rest of the body is never read, and a call that says
 * the job ran has its message dropped. Only the words `fail` and `down`, in
 * any case, say the job failed; any other `status`, or an `exit` that is not
 * a whole number from 0 to 255, is ignored, as every query was before. Each
 * call leaves the monitor's latest hundred heartbeats and no more.
 */

import { heartbeatsKept } from "@/server/checks/heartbeat.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  cleanHeartbeatMessage,
  type HeartbeatFailure,
  heartbeatExitCodeMax,
  heartbeatTokenSchema,
} from "@/shared/schemas/heartbeat.ts";

/** What one call to a heartbeat URL came to. */
export type HeartbeatReceipt = "recorded" | "unknown" | "unavailable";

/** The most of a `POST` body that is read for the message, in bytes: a message of the longest kept length, at four bytes a character. */
export const heartbeatBodyReadBytes = 1024;

/** What a call says of the job: nothing when it ran, its failure when it did not. */
export interface HeartbeatCall {
  readonly failure: HeartbeatFailure | undefined;
}

/** The `status` words that say the job failed, in lower case; `down` is the word Uptime Kuma's push URLs use. Any other word says nothing. */
const failedWords: ReadonlySet<string> = new Set(["down", "fail"]);

/** ASCII digits only, so a number written in other digits is refused. */
const exitCodePattern = /^\d{1,3}$/;

/** At most `bytes` of the request's body, cut chunk by chunk so a chunk larger than the limit is never kept whole; the stream is cancelled there, so the rest is never pulled. Nothing for a request with no body. */
export async function readBodyHead(
  request: Request,
  bytes: number
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < bytes) {
      // biome-ignore lint/performance/noAwaitInLoops: each chunk waits for the one before
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const kept = value.subarray(0, bytes - size);
      chunks.push(kept);
      size += kept.length;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** The head of the body as text, UTF-8 whatever the first bytes look like: `Blob.text()` takes a UTF-16 byte order mark for one. */
async function readMessageBody(request: Request): Promise<string> {
  return new TextDecoder().decode(
    await readBodyHead(request, heartbeatBodyReadBytes)
  );
}

/** Reads what a request to a heartbeat URL says of the job; `failAddress` is whether it came to the address that ends in `/fail`. */
export async function readHeartbeatCall(
  request: Request,
  failAddress: boolean
): Promise<HeartbeatCall> {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const exit = searchParams.get("exit");
  // An exit code that is not a whole number from 0 to 255 is ignored.
  const exitCode =
    exit !== null &&
    exitCodePattern.test(exit) &&
    Number(exit) <= heartbeatExitCodeMax
      ? Number(exit)
      : undefined;
  const failed =
    failAddress ||
    (status !== null && failedWords.has(status.toLowerCase())) ||
    (exitCode ?? 0) > 0;
  if (!failed) {
    return { failure: undefined };
  }
  const text =
    searchParams.get("message") ??
    searchParams.get("msg") ??
    (request.method === "POST" ? await readMessageBody(request) : "");
  return { failure: { exitCode, message: cleanHeartbeatMessage(text) } };
}

/** Stores the heartbeat for the monitor with this token. Text that is not a token never reaches the database. */
export async function receiveHeartbeat(
  storage: Pick<Storage, "heartbeats"> | undefined,
  token: string,
  sourceIp: string | undefined,
  now: number,
  failure?: HeartbeatFailure
): Promise<HeartbeatReceipt> {
  if (!storage) {
    return "unavailable";
  }
  if (!heartbeatTokenSchema.safeParse(token).success) {
    return "unknown";
  }
  try {
    const monitorId = await storage.heartbeats.record(
      token,
      now,
      sourceIp,
      failure
    );
    if (monitorId === undefined) {
      return "unknown";
    }
    // Every call keeps the latest hundred and no more: a job calling in a loop, or a monitor that stays down and is not evaluated, adds no rows past them.
    await storage.heartbeats
      .prune(monitorId, heartbeatsKept)
      .catch(() => undefined);
    return "recorded";
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

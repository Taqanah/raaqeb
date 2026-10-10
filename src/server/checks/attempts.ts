/**
 * What every check type shares: attempts until one succeeds
 * or the retries are spent, the pause between two, the result of the
 * attempt that ended the check against the degraded threshold, the check's
 * row, the failure detail when it is down and the capture when the capture
 * mode keeps one. The HTTP, TCP, DNS, database and Docker checks each
 * supply only their one attempt; nothing here does I/O beyond the injected
 * clock and pause.
 */
import { retryDelayMs } from "@/shared/domain/checks.ts";
import type { CheckOutcome, CheckResult } from "@/shared/schemas/check.ts";
import type {
  Assertion,
  CaptureMode,
  Monitor,
} from "@/shared/schemas/monitor.ts";
import {
  type ReasonName,
  type ReasonParams,
  reasons,
} from "@/shared/schemas/reason.ts";
import { type CredentialPatterns, captureOf, keepsCapture } from "./capture.ts";

/** The I/O the attempt loop borrows: the clock and the pause between two attempts. */
export interface AttemptIo {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** What one attempt saw; a field its check type never sees is left out. */
export interface Attempt {
  /** The assertion of the success rules that failed, when one did. */
  readonly assertion?: Assertion | undefined;
  /** Bytes of body read, up to the read cap. */
  readonly bytes?: number;
  /** The raw runtime error text, when the attempt threw. */
  readonly error?: string | undefined;
  readonly params: ReasonParams;
  readonly reason: ReasonName;
  /** The response, when one arrived, for the capture, with the credentials the request sent for the capture to mask. */
  readonly response?:
    | {
        readonly body: Uint8Array;
        readonly credentials?: CredentialPatterns;
        readonly headers: Headers;
      }
    | undefined;
  readonly responseMs: number;
  readonly statusCode?: number | undefined;
  /** Up or degraded; down otherwise. */
  readonly succeeded: boolean;
}

/** Runs one check of the monitor now: attempts until one succeeds or the retries are spent, judged by the attempt that ended it. Only an HTTP monitor has a capture mode; without one no capture is kept. */
export async function runAttempts(
  monitor: Pick<Monitor, "id" | "retries" | "degradedMs">,
  io: AttemptIo,
  attemptOnce: () => Promise<Attempt>,
  captureMode: CaptureMode = "off"
): Promise<CheckOutcome> {
  const key = { monitorId: monitor.id, startedAt: io.now() };
  const { attempt, attempts } = await attemptUntil(
    monitor.retries,
    io.sleep,
    attemptOnce
  );
  const result = resultOf(monitor.degradedMs, attempt);
  return {
    capture:
      attempt.response && keepsCapture(captureMode, result)
        ? captureOf(
            key,
            attempt.response.headers,
            attempt.response.body,
            attempt.response.credentials
          )
        : undefined,
    check: {
      ...key,
      attempts,
      bytes: attempt.bytes ?? 0,
      reason: reasons[attempt.reason],
      responseMs: attempt.responseMs,
      result,
      statusCode: attempt.statusCode,
    },
    detail:
      result === "down"
        ? {
            ...key,
            assertion: attempt.assertion,
            error: attempt.error,
            params: attempt.params,
          }
        : undefined,
  };
}

/** Runs attempts until one succeeds or the retries are spent, pausing between two; answers the last attempt and how many it took. */
async function attemptUntil(
  retries: number,
  sleep: (ms: number) => Promise<void>,
  attemptOnce: () => Promise<Attempt>,
  attempts = 1
): Promise<{ attempt: Attempt; attempts: number }> {
  const attempt = await attemptOnce();
  if (attempt.succeeded || attempts > retries) {
    return { attempt, attempts };
  }
  await sleep(retryDelayMs);
  return attemptUntil(retries, sleep, attemptOnce, attempts + 1);
}

/** Down when the attempt failed; degraded when it succeeded over the threshold; up otherwise. A monitor without a threshold is never degraded. */
function resultOf(
  degradedMs: number | undefined,
  attempt: Attempt
): CheckResult {
  if (!attempt.succeeded) {
    return "down";
  }
  return degradedMs !== undefined && attempt.responseMs > degradedMs
    ? "degraded"
    : "up";
}

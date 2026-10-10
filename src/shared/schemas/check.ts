/**
 * What one check stores (CONTEXT.md "Check", "Failure detail", "Capture"):
 * the row of the head table on every check, the failure detail
 * beside a down check, the capture when the monitor's capture mode says so.
 * Rows are keyed by monitor and started-at millisecond.
 */
import { z } from "zod";
import { type Assertion, assertionSchema } from "./monitor.ts";
import {
  type ReasonCode,
  type ReasonParams,
  reasonParamsSchema,
} from "./reason.ts";

export const checkResults = ["up", "degraded", "down"] as const;
export type CheckResult = (typeof checkResults)[number];

/** The result as the head table and the sealed day store it: one small integer. */
export function resultCode(result: CheckResult): number {
  return checkResults.indexOf(result);
}

/** The result a stored code stands for, or nothing for a code this version does not know. */
export function resultOf(code: number): CheckResult | undefined {
  return checkResults[code];
}

export interface Check {
  /** How many tries the run took, so "up after a retry" is visible. */
  readonly attempts: number;
  /** Bytes of body read, up to the read cap; catches an empty page. */
  readonly bytes: number;
  readonly monitorId: string;
  readonly reason: ReasonCode;
  /** The last attempt's time from the start of the request to the end of the body, capped by the timeout; none for a heartbeat check. */
  readonly responseMs: number | undefined;
  readonly result: CheckResult;
  /** UTC milliseconds. */
  readonly startedAt: number;
  /** HTTP monitors only, when a response arrived. */
  readonly statusCode: number | undefined;
}

/** The raw runtime error string kept beside a down check is cut to this length. */
export const errorMaxLength = 256;

/** The record beside a down check, deleted with its day's sealed row. */
export interface FailureDetail {
  /** The assertion that failed, when one did. */
  readonly assertion: Assertion | undefined;
  /** The driver's raw error text, a machine token. */
  readonly error: string | undefined;
  readonly monitorId: string;
  readonly params: ReasonParams;
  readonly startedAt: number;
}

/** The failure detail's two JSON columns, parsed at the edge. */
export const failureDetailAssertionSchema = assertionSchema;
export const failureDetailParamsSchema = reasonParamsSchema;

/** A capture keeps the response headers and the first 4 KB of the body; the cap is fixed. */
export const captureBodyBytes = 4096;

/** A header as a capture keeps it; a redacted header keeps its name and no value. */
export interface CaptureHeader {
  readonly name: string;
  readonly value: string | undefined;
}
export const captureHeadersSchema = z.array(
  z
    .object({ name: z.string(), value: z.string().optional() })
    .transform(
      (header): CaptureHeader => ({ name: header.name, value: header.value })
    )
);

export interface Capture {
  readonly body: Uint8Array;
  readonly headers: readonly CaptureHeader[];
  readonly monitorId: string;
  readonly startedAt: number;
}

/** What one run of a monitor produced; the repository stores the three as one write. */
export interface CheckOutcome {
  readonly capture: Capture | undefined;
  readonly check: Check;
  readonly detail: FailureDetail | undefined;
}

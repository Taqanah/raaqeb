/**
 * The DNS check (CONTEXT.md "Check", "Check type"; DNS):
 * the name resolves to a record of the chosen type, and, when the monitor
 * names an expected value, one of the answers is that value. One call is
 * one check with its retries and the degraded threshold over the query
 * time. It does no I/O beyond the injected `resolve`, takes `now` and
 * `sleep` as parameters, and never throws. A DNS check has no status code,
 * reads no bytes and keeps no capture.
 */
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type {
  DnsConfig,
  DnsRecordType,
  Monitor,
} from "@/shared/schemas/monitor.ts";
import {
  observedMaxLength,
  type ReasonName,
  type ReasonParams,
} from "@/shared/schemas/reason.ts";
import { type Attempt, type AttemptIo, runAttempts } from "./attempts.ts";
import { reasonForDnsError } from "./errors.ts";

/** One query as the resolver runs it; `resolver` absent means the system's. */
export interface DnsQuery {
  readonly name: string;
  readonly recordType: DnsRecordType;
  readonly resolver: string | undefined;
  readonly timeoutMs: number;
}

/** The answers of a query, each record as one line of text (`textOfRecords`). */
export type Resolve = (query: DnsQuery) => Promise<readonly string[]>;

/** The I/O a DNS check borrows; tests hand in fakes. */
export interface DnsIo extends AttemptIo {
  readonly resolve: Resolve;
}

/** What the DNS check needs of a monitor. */
export type DnsMonitor = Pick<
  Monitor,
  "id" | "timeoutMs" | "retries" | "degradedMs"
> & { readonly config: DnsConfig };

/** A mail exchange record as the resolver answers it. */
export interface MxRecord {
  readonly exchange: string;
  readonly priority: number;
}

/** What the resolver answers per record type: addresses and names as text, MX as records, TXT as chunk lists. */
export type DnsRecords =
  | readonly string[]
  | readonly MxRecord[]
  | readonly (readonly string[])[];

/** Each record as one line of text: the address or name as is, an MX as its exchange, a TXT as its chunks joined. */
export function textOfRecords(
  recordType: DnsRecordType,
  records: DnsRecords
): string[] {
  const lines: string[] = [];
  for (const record of records) {
    if (typeof record === "string") {
      lines.push(record);
    } else if (recordType === "TXT" && Array.isArray(record)) {
      lines.push(record.join(""));
    } else if ("exchange" in record) {
      lines.push(record.exchange);
    }
  }
  return lines;
}

/** Runs one check of the monitor now: attempts until one succeeds or the retries are spent. */
export function runDnsCheck(
  monitor: DnsMonitor,
  io: DnsIo
): Promise<CheckOutcome> {
  return runAttempts(monitor, io, () => attemptOnce(monitor, io));
}

/** One query judged against the expected value, or the error it met. */
async function attemptOnce(monitor: DnsMonitor, io: DnsIo): Promise<Attempt> {
  const { expected, name, recordType, resolver } = monitor.config;
  const start = io.now();
  const elapsed = () => Math.min(io.now() - start, monitor.timeoutMs);
  const failed = (
    reason: ReasonName,
    params: ReasonParams,
    error?: string
  ): Attempt => ({
    error,
    params,
    reason,
    responseMs: elapsed(),
    succeeded: false,
  });
  try {
    const records = await io.resolve({
      name,
      recordType,
      resolver,
      timeoutMs: monitor.timeoutMs,
    });
    if (records.length === 0) {
      return failed("dns_failed", { host: name, reason: "dns_failed" });
    }
    if (
      expected !== undefined &&
      !records.some((r) => sameRecord(recordType, r, expected))
    ) {
      return failed("dns_mismatch", {
        expected: expected.slice(0, observedMaxLength),
        observed: records.join(", ").slice(0, observedMaxLength),
        reason: "dns_mismatch",
      });
    }
    return {
      error: undefined,
      params: { reason: "ok" },
      reason: "ok",
      responseMs: elapsed(),
      succeeded: true,
    };
  } catch (error) {
    const mapped = reasonForDnsError(error, {
      name,
      timeoutMs: monitor.timeoutMs,
    });
    return failed(mapped.reason, mapped.params, mapped.error);
  }
}

/** Names and addresses compare without case, and a trailing dot on either side is not a difference; a TXT record is compared as written. */
function sameRecord(
  recordType: DnsRecordType,
  record: string,
  expected: string
): boolean {
  return recordType === "TXT"
    ? record === expected
    : canonical(record) === canonical(expected);
}

const trailingDot = /\.$/;

function canonical(text: string): string {
  return text.trim().toLowerCase().replace(trailingDot, "");
}

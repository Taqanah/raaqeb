/**
 * The TCP check (CONTEXT.md "Check", "Check type"; TCP):
 * the host and port accept a connection. One call is one check with its
 * retries and the degraded threshold over the time to an open connection.
 * It does no I/O beyond the injected `connect`, takes `now` and `sleep` as
 * parameters, and never throws: every runtime error is a reason. A TCP
 * check has no status code, reads no bytes and keeps no capture.
 */
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { Monitor, TcpConfig } from "@/shared/schemas/monitor.ts";
import { type Attempt, type AttemptIo, runAttempts } from "./attempts.ts";
import { reasonForError } from "./errors.ts";

/** What a connection attempt needs; `timeoutMs` bounds the attempt and is reported as a timeout. */
export interface ConnectTarget {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

/** Opens a connection and closes it again; resolves once the connection is open with the address it reached, which "test now" shows; rejects with the runtime error. */
export type Connect = (target: ConnectTarget) => Promise<string>;

/** The I/O a TCP check borrows; tests hand in fakes. */
export interface TcpIo extends AttemptIo {
  readonly connect: Connect;
}

/** What the TCP check needs of a monitor. */
export type TcpMonitor = Pick<
  Monitor,
  "id" | "timeoutMs" | "retries" | "degradedMs"
> & { readonly config: TcpConfig };

/** Runs one check of the monitor now: attempts until one succeeds or the retries are spent. */
export function runTcpCheck(
  monitor: TcpMonitor,
  io: TcpIo
): Promise<CheckOutcome> {
  return runAttempts(monitor, io, () => attemptOnce(monitor, io));
}

/** One connection opened and closed, or the error it met. */
async function attemptOnce(monitor: TcpMonitor, io: TcpIo): Promise<Attempt> {
  const { host, port } = monitor.config;
  const target = { host, port, timeoutMs: monitor.timeoutMs };
  const start = io.now();
  const elapsed = () => Math.min(io.now() - start, monitor.timeoutMs);
  try {
    await io.connect(target);
    return {
      error: undefined,
      params: { reason: "ok" },
      reason: "ok",
      responseMs: elapsed(),
      succeeded: true,
    };
  } catch (error) {
    const mapped = reasonForError(error, target);
    return { ...mapped, responseMs: elapsed(), succeeded: false };
  }
}

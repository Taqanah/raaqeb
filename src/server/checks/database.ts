/**
 * The database check (CONTEXT.md "Database monitor"):
 * a Postgres, MySQL or Redis server signs in with the monitor's
 * connection URL and answers `SELECT 1`, `PING` or the operator's query,
 * and when the monitor names an expected value, the first value the query
 * answered is that text. One call is one check with its retries and the
 * degraded threshold over the time from connecting to the answer. It does
 * no I/O beyond the injected `queryDatabase`, takes `now` and `sleep` as
 * parameters, and never throws. A database check has no status code, reads
 * no bytes and keeps no capture.
 */
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import {
  type DatabaseCheckType,
  type DatabaseConfig,
  databasePorts,
  defaultQueries,
  type Monitor,
} from "@/shared/schemas/monitor.ts";
import { observedMaxLength } from "@/shared/schemas/reason.ts";
import { type Attempt, type AttemptIo, runAttempts } from "./attempts.ts";
import {
  type CredentialPatterns,
  credentialPatterns,
  maskCredentialText,
} from "./capture.ts";
import { reasonForDatabaseError } from "./errors.ts";

/** One query as the driver runs it: a fresh connection to the URL, signed in, closed after the answer. */
export interface DatabaseQuery {
  /** SQL, or a Redis command and its arguments separated by spaces. */
  readonly query: string;
  readonly timeoutMs: number;
  readonly type: DatabaseCheckType;
  readonly url: string;
}

/** Answers the first value the query answered: the first column of the first row, or Redis's reply; rejects with the driver's error, or a `TimeoutError` past the timeout. */
export type QueryDatabase = (query: DatabaseQuery) => Promise<unknown>;

/** The I/O a database check borrows; tests hand in fakes. */
export interface DatabaseIo extends AttemptIo {
  readonly queryDatabase: QueryDatabase;
}

/** What the database check needs of a monitor: its connection URL is among its credentials. */
export type DatabaseMonitor = Pick<
  Monitor,
  "id" | "timeoutMs" | "retries" | "degradedMs"
> & { readonly config: DatabaseConfig; readonly credentials?: Credentials };

/** Runs one check of the monitor now: attempts until one succeeds or the retries are spent. */
export function runDatabaseCheck(
  monitor: DatabaseMonitor,
  io: DatabaseIo
): Promise<CheckOutcome> {
  return runAttempts(monitor, io, () => attemptOnce(monitor, io));
}

/** One connection signed in, asked and closed, or the error it met. */
async function attemptOnce(
  monitor: DatabaseMonitor,
  io: DatabaseIo
): Promise<Attempt> {
  const { config, timeoutMs } = monitor;
  const url = monitor.credentials?.url;
  if (url === undefined) {
    // The install key could not open it (the scheduler logs which monitor); without a URL there is nothing to reach.
    return {
      error: "no connection URL: the install key cannot open the stored one",
      params: { reason: "unknown" },
      reason: "unknown",
      responseMs: 0,
      succeeded: false,
    };
  }
  const start = io.now();
  const elapsed = () => Math.min(io.now() - start, timeoutMs);
  try {
    const answer = await io.queryDatabase({
      query: config.query ?? defaultQueries[config.type],
      timeoutMs,
      type: config.type,
      url,
    });
    return {
      ...judged(config.expected, answer, secretsOf(url)),
      responseMs: elapsed(),
    };
  } catch (error) {
    // The URL parsed when it was saved; a stored one that no longer does still maps its error, never throws.
    const { hostname, port } = URL.parse(url) ?? { hostname: "", port: "" };
    const target = {
      host: hostname,
      port: Number(port) || databasePorts[config.type],
      timeoutMs,
    };
    const secrets = secretsOf(url);
    return {
      ...reasonForDatabaseError(error, target, secrets),
      responseMs: elapsed(),
      succeeded: false,
    };
  }
}

/** Up when no value is expected or the answer is it as text; otherwise a failed assertion with both, the URL and its password masked before the cut, as an HTTP assertion's values are. */
function judged(
  expected: string | undefined,
  answer: unknown,
  secrets: CredentialPatterns
): Omit<Attempt, "responseMs"> {
  const observed = answerText(answer);
  if (expected === undefined || observed === expected) {
    return { params: { reason: "ok" }, reason: "ok", succeeded: true };
  }
  const shown = (text: string) =>
    maskCredentialText(text, secrets).slice(0, observedMaxLength);
  return {
    params: {
      expected: shown(expected),
      observed: shown(observed),
      reason: "assertion_failed",
    },
    reason: "assertion_failed",
    succeeded: false,
  };
}

/** The URL's password as the server sees it, percent-decoding undone; one that does not decode as written, and none as empty text. */
export function passwordOf(url: string): string {
  const password = URL.parse(url)?.password ?? "";
  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}

/** What a database check masks wherever it shows text: the URL, and its password as written and as the server sees it. */
export function secretsOf(url: string): CredentialPatterns {
  return credentialPatterns([
    url,
    URL.parse(url)?.password ?? "",
    passwordOf(url),
  ]);
}

/** A value the driver answered as the text an expected value is compared with: a string as it is, a date in ISO 8601, bytes as UTF-8, no row as empty text, anything else as JSON with a big integer in full. */
export function answerText(answer: unknown): string {
  if (answer === undefined) {
    return "";
  }
  if (typeof answer === "string") {
    return answer;
  }
  if (typeof answer === "bigint") {
    return String(answer);
  }
  if (answer instanceof Date) {
    return answer.toISOString();
  }
  if (answer instanceof Uint8Array) {
    return new TextDecoder().decode(answer);
  }
  return JSON.stringify(answer, (_, value: unknown) =>
    typeof value === "bigint" ? String(value) : value
  );
}

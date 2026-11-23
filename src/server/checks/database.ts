/**
 * The database check (CONTEXT.md "Database monitor"):
 * a Postgres, MySQL, Redis or MongoDB server signs in with the monitor's
 * connection URL and answers `SELECT 1`, `PING`, `{"ping": 1}` or the
 * operator's query or command,
 * and when the monitor names an expected value, the first value the query
 * answered is that text. One call is one check with its retries and the
 * degraded threshold over the time from connecting to the answer. It does
 * no I/O beyond the injected `queryDatabase`, takes `now` and `sleep` as
 * parameters, and never throws. A database check has no status code, reads
 * no bytes and keeps no capture.
 */
import { mongoPort, parseConnectionString } from "@/shared/domain/mongodb.ts";
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import {
  connectionUrlFits,
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
  /** SQL, a Redis command and its arguments separated by spaces, or a MongoDB command as JSON. */
  readonly query: string;
  readonly timeoutMs: number;
  readonly type: DatabaseCheckType;
  readonly url: string;
}

/** Answers the first value the query answered: the first column of the first row, Redis's reply, or the first field of MongoDB's reply; rejects with the driver's error, or a `TimeoutError` past the timeout. */
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

/** An attempt that reached nothing, and why. */
const unreached = (error: string): Attempt => ({
  error,
  params: { reason: "unknown" },
  reason: "unknown",
  responseMs: 0,
  succeeded: false,
});

/** One connection signed in, asked and closed, or the error it met. */
async function attemptOnce(
  monitor: DatabaseMonitor,
  io: DatabaseIo
): Promise<Attempt> {
  const { config, timeoutMs } = monitor;
  const url = monitor.credentials?.url;
  // The install key could not open it (the scheduler logs which monitor); without a URL there is nothing to reach.
  if (url === undefined) {
    return unreached(
      "no connection URL: the install key cannot open the stored one"
    );
  }
  // A URL saved before the rule that now refuses it on save never reaches Bun's driver either; Raaqeb's own MongoDB client reads no file or socket.
  if (config.type !== "mongodb" && !connectionUrlFits(config.type, url)) {
    return unreached(
      "a connection URL this check type cannot read: edit the monitor and save a URL that names no Unix socket, certificate file, or other host or port in its query"
    );
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
    const target = { ...addressOf(config.type, url), timeoutMs };
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

/** The host and port a check's error names: the URL's, or a MongoDB seed list's first, the check type's port when it names none. */
function addressOf(
  type: DatabaseCheckType,
  url: string
): { host: string; port: number } {
  // The URL parsed when it was saved; a stored one that no longer does still maps its error, never throws.
  if (type === "mongodb") {
    try {
      const [first] = parseConnectionString(url).hosts;
      return first ?? { host: "", port: mongoPort };
    } catch {
      return { host: "", port: mongoPort };
    }
  }
  const { hostname, port } = URL.parse(url) ?? { hostname: "", port: "" };
  return { host: hostname, port: Number(port) || databasePorts[type] };
}

/** The password as the URL writes it: after the first colon of the user information, which ends at the last @ before the host list. A MongoDB seed list is no WHATWG URL, so it is read by hand. */
function writtenPasswordOf(url: string): string {
  if (!url.startsWith("mongodb")) {
    return URL.parse(url)?.password ?? "";
  }
  const authority =
    url.slice(url.indexOf("//") + 2).split(hostInfoEnd)[0] ?? "";
  const at = authority.lastIndexOf("@");
  const userInfo = at < 0 ? "" : authority.slice(0, at);
  const colon = userInfo.indexOf(":");
  return colon < 0 ? "" : userInfo.slice(colon + 1);
}

const hostInfoEnd = /[/?]/;

/** The URL's password as the server sees it, percent-decoding undone; one that does not decode as written, and none as empty text. */
export function passwordOf(url: string): string {
  const password = writtenPasswordOf(url);
  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}

/** What a database check masks wherever it shows text: the URL, and its password as written and as the server sees it. */
export function secretsOf(url: string): CredentialPatterns {
  return credentialPatterns([url, writtenPasswordOf(url), passwordOf(url)]);
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

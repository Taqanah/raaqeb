/**
 * Maps the runtime errors of Bun's `fetch` onto the reason dictionary
 * (ADR-0004): a timeout, a DNS failure, a refused or failed
 * connection (a TLS handshake that ended before any certificate among them),
 * an expired or invalid certificate, too many redirects (thrown by the HTTP
 * check's own redirect loop with Bun's code and text). An unmapped error
 * becomes "unknown" with its raw text beside it. The codes were read from
 * Bun 1.4.3.
 */
import { errorMaxLength } from "@/shared/schemas/check.ts";
import { isSocketPath } from "@/shared/schemas/monitor.ts";
import type { ReasonName, ReasonParams } from "@/shared/schemas/reason.ts";
import { type CredentialPatterns, maskCredentialText } from "./capture.ts";

export interface MappedError {
  /** The driver's raw text, cut to the failure detail's cap. */
  readonly error: string;
  readonly params: ReasonParams;
  readonly reason: ReasonName;
}

const dnsCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_FAIL",
  "DNSResolutionFailed",
]);
const refusedCodes = new Set(["ConnectionRefused", "ECONNREFUSED"]);
const failedCodes = new Set([
  "ECONNRESET",
  "ConnectionClosed",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "FailedToOpenSocket",
  "ECONNABORTED",
  "ETIMEDOUT",
  // A TLS handshake the server answered without TLS.
  "EPROTO",
]);
/** OpenSSL's verification codes and Bun's own, apart from the expired one. */
const certificateCodeShape =
  /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HOSTNAME_MISMATCH/;

/** The reason a thrown fetch error stands for; `target` supplies the host and port the reason names. The credentials sent are masked in the raw text before its cut, so one straddling the cut leaves no prefix. */
export function reasonForError(
  error: unknown,
  target: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
  },
  credentials: CredentialPatterns = []
): MappedError {
  const text = maskCredentialText(messageOf(error), credentials).slice(
    0,
    errorMaxLength
  );
  const code = codeOf(error);
  const mapped = (reason: ReasonName, params: ReasonParams): MappedError => ({
    error: text,
    params,
    reason,
  });
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return mapped("timeout", {
      reason: "timeout",
      timeoutMs: target.timeoutMs,
    });
  }
  if (code === undefined) {
    return mapped("unknown", { reason: "unknown" });
  }
  if (dnsCodes.has(code)) {
    return mapped("dns_failed", { host: target.host, reason: "dns_failed" });
  }
  if (refusedCodes.has(code)) {
    return mapped("connection_refused", {
      host: target.host,
      port: target.port,
      reason: "connection_refused",
    });
  }
  if (failedCodes.has(code)) {
    return mapped("connection_failed", { code, reason: "connection_failed" });
  }
  if (code === "CERT_HAS_EXPIRED") {
    return mapped("certificate_expired", { reason: "certificate_expired" });
  }
  if (certificateCodeShape.test(code)) {
    return mapped("certificate_invalid", {
      code,
      reason: "certificate_invalid",
    });
  }
  if (code === "TooManyRedirects") {
    return mapped("too_many_redirects", { reason: "too_many_redirects" });
  }
  return mapped("unknown", { reason: "unknown" });
}

/** Bun's advice to whoever calls fetch(), appended to several of its errors (read from Bun 1.4.3). */
const verboseHint =
  " For more information, pass `verbose: true` in the second argument to fetch()";

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // Bun 1.4.3's fetch writes its code before the sentence; the reason names the code already.
    const code = codeOf(error);
    const message =
      code && error.message.startsWith(`${code}: `)
        ? error.message.slice(code.length + 2)
        : error.message;
    return message.replace(verboseHint, "");
  }
  return typeof error === "string" ? error : String(error);
}

/** The error's string code, as Bun and Node name one. */
export function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
}

/**
 * The reason a resolver error stands for: a query that ran
 * out of time is a timeout, any other coded error (no such name, no record
 * of that type, a server failure, a refused query) is DNS failed with the
 * name, and an error without a code is unknown.
 */
export function reasonForDnsError(
  error: unknown,
  query: { readonly name: string; readonly timeoutMs: number }
): MappedError {
  const text = messageOf(error).slice(0, errorMaxLength);
  const code = codeOf(error);
  const timedOut =
    (error instanceof DOMException && error.name === "TimeoutError") ||
    code === "ETIMEOUT";
  if (timedOut) {
    return {
      error: text,
      params: { reason: "timeout", timeoutMs: query.timeoutMs },
      reason: "timeout",
    };
  }
  // c-ares names its answers `E...`; the platform's own errors (a bad resolver address) are `ERR_...` and are not about the name.
  if (code === undefined || code.startsWith("ERR_")) {
    return { error: text, params: { reason: "unknown" }, reason: "unknown" };
  }
  return {
    error: text,
    params: { host: query.name, reason: "dns_failed" },
    reason: "dns_failed",
  };
}

/**
 * The reason a database driver's error stands for: a connection that
 * ran out of time is a timeout, a refused one is connection refused with the
 * URL's host and port, a sign-in that needs an encrypted connection the URL
 * did not ask for is TLS required, a sign-in the server refused is
 * auth failed, a query it refused is query failed with its own code, a
 * certificate is expired or invalid, and any other coded error is
 * connection failed. The credentials (the URL and its password) are masked
 * in the raw text before its cut.
 */
export function reasonForDatabaseError(
  error: unknown,
  target: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
  },
  credentials: CredentialPatterns = []
): MappedError {
  const code = codeOf(error);
  // Postgres and MySQL name the server's own code in `errno`: an SQLSTATE, or MySQL's number.
  const errno =
    typeof error === "object" && error !== null && "errno" in error
      ? String(error.errno)
      : undefined;
  const mapped = (reason: ReasonName, params: ReasonParams): MappedError => ({
    error: maskCredentialText(messageOf(error), credentials).slice(
      0,
      errorMaxLength
    ),
    params,
    reason,
  });
  if (code !== undefined && databaseTimeoutCodes.has(code)) {
    return mapped("timeout", {
      reason: "timeout",
      timeoutMs: target.timeoutMs,
    });
  }
  if (code !== undefined && databaseRefusedCodes.has(code)) {
    return mapped("connection_refused", {
      host: target.host,
      port: target.port,
      reason: "connection_refused",
    });
  }
  const serverCode =
    code === "ERR_POSTGRES_SERVER_ERROR" || code === "ERR_MYSQL_SERVER_ERROR"
      ? errno
      : code;
  // MySQL 8 asks for its RSA key to sign in over a plain connection and Bun refuses, so the password was never tried.
  if (code === "ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED") {
    return mapped("tls_required", { reason: "tls_required" });
  }
  if (serverCode !== undefined && signInRefusals.has(serverCode)) {
    return mapped("auth_failed", { code: serverCode, reason: "auth_failed" });
  }
  if (code !== undefined && queryRefusalCodes.has(code)) {
    return mapped("query_failed", {
      code: serverCode ?? code,
      reason: "query_failed",
    });
  }
  // Bun's Postgres driver reports a certificate for another name as an empty error, as storage's connection test reads it.
  if (code === undefined && messageOf(error) === "" && errno === "0") {
    return mapped("certificate_invalid", {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      reason: "certificate_invalid",
    });
  }
  if (
    code?.startsWith("ERR_POSTGRES_") ||
    code?.startsWith("ERR_MYSQL_") ||
    code?.startsWith("ERR_REDIS_")
  ) {
    return mapped("connection_failed", { code, reason: "connection_failed" });
  }
  return reasonForError(error, target, credentials);
}

/** A connection Bun's drivers gave up on in their own time. */
const databaseTimeoutCodes = new Set([
  "ERR_MYSQL_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_REDIS_CONNECTION_TIMEOUT",
]);
/** A refused connection; Bun 1.4.3 reports a name that does not resolve the same way. */
const databaseRefusedCodes = new Set([
  "ERR_MYSQL_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_REFUSED",
]);
/** An error the server sent back, which is about the query once the sign-in is past. */
const queryRefusalCodes = new Set([
  "ERR_MYSQL_SERVER_ERROR",
  "ERR_POSTGRES_SERVER_ERROR",
  "ERR_REDIS_SERVER_ERROR",
]);
/**
 * A sign-in the server refused: Postgres's SQLSTATE class 28 and a database
 * that does not exist; MySQL's access denied, unknown database and the
 * authentication plugins it would not use; and Bun's own codes for a
 * password exchange that failed or a Redis password it refused.
 */
const signInRefusals = new Set([
  "28000",
  "28P01",
  "3D000",
  "1044",
  "1045",
  "1049",
  "1251",
  "1698",
  "ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF2",
  "ERR_POSTGRES_INVALID_SERVER_KEY",
  "ERR_POSTGRES_INVALID_SERVER_SIGNATURE",
  "ERR_POSTGRES_SASL_SIGNATURE_INVALID_BASE64",
  "ERR_POSTGRES_SASL_SIGNATURE_MISMATCH",
  "ERR_POSTGRES_UNKNOWN_AUTHENTICATION_METHOD",
  "ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD",
  "ERR_REDIS_AUTHENTICATION_FAILED",
]);

/**
 * The reason a Docker endpoint's transport error stands for: over a
 * Unix socket, a socket that is missing (`ENOENT`), refused (`ECONNREFUSED`)
 * or not this process's to open (`EACCES`) is connection failed with that
 * code, since a socket has no host or port to name; over a URL, as fetch's
 * errors map. A timeout is a timeout either way.
 */
export function reasonForDockerError(
  error: unknown,
  endpoint: string,
  timeoutMs: number
): MappedError {
  const code = codeOf(error);
  if (!isSocketPath(endpoint) || code === undefined) {
    // A socket's path has no host or port; only a timeout or an uncoded error reach the map with it, and neither names them.
    return reasonForError(
      error,
      isSocketPath(endpoint)
        ? { host: endpoint, port: 0, timeoutMs }
        : urlTarget(endpoint, timeoutMs)
    );
  }
  return {
    error: messageOf(error).slice(0, errorMaxLength),
    params: { code, reason: "connection_failed" },
    reason: "connection_failed",
  };
}

/** The host and port a URL reaches, the scheme's port when it names none, as an error's reason names them. */
export function urlTarget(
  url: string,
  timeoutMs: number
): { host: string; port: number; timeoutMs: number } {
  const parsed = new URL(url);
  const defaultPort = parsed.protocol === "https:" ? 443 : 80;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : defaultPort,
    timeoutMs,
  };
}

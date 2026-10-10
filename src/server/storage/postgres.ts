/**
 * The Postgres backend: reached by URL, connected through
 * Bun's driver inside a bounded window, with the options that keep a transaction pooler and the driver's idle
 * timers from failing a query applied.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import type { PostgresConnection } from "./connection.ts";

/** Why a connection did not happen. A code, never the driver's text. */
export type ConnectFailure =
  | "refused"
  | "timeout"
  | "authentication"
  | "tls"
  | "database"
  /** The text is not a postgres:// or postgresql:// URL; decided before any connection is tried. */
  | "malformed"
  | "unknown";

export type PostgresOpenResult =
  | { ok: true; connection: PostgresConnection }
  | { ok: false; failure: ConnectFailure };

export interface PostgresOpenOptions {
  /** The retry window in milliseconds; the default is about 30 seconds. */
  windowMs?: number;
}

/** The window's default: 30 seconds. */
export const defaultConnectWindowMs = 30_000;

/** One attempt's bound, in the driver's seconds; three fit inside the window. */
const connectionTimeoutSeconds = 10;
const retryPauseMs = 1000;
/** Supavisor's transaction port, and PgBouncer's own (PlanetScale's). */
const poolerPorts = new Set(["6543", "6432"]);

/** Failures worth another attempt inside the window: the server may still be starting. */
const transient: ReadonlySet<ConnectFailure> = new Set(["refused", "timeout"]);

const failureByCode: Readonly<Record<string, ConnectFailure>> = {
  "28000": "authentication",
  "28P01": "authentication",
  "3D000": "database",
  ECONNREFUSED: "refused",
  ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF2: "authentication",
  ERR_POSTGRES_CONNECTION_CLOSED: "refused",
  ERR_POSTGRES_CONNECTION_FAILED: "refused",
  ERR_POSTGRES_CONNECTION_REFUSED: "refused",
  ERR_POSTGRES_CONNECTION_TIMEOUT: "timeout",
  ERR_POSTGRES_INVALID_SERVER_KEY: "authentication",
  ERR_POSTGRES_INVALID_SERVER_SIGNATURE: "authentication",
  ERR_POSTGRES_SASL_SIGNATURE_INVALID_BASE64: "authentication",
  ERR_POSTGRES_SASL_SIGNATURE_MISMATCH: "authentication",
  ERR_POSTGRES_TLS_NOT_AVAILABLE: "tls",
  ERR_POSTGRES_TLS_UPGRADE_FAILED: "tls",
  ERR_POSTGRES_UNKNOWN_AUTHENTICATION_METHOD: "authentication",
  ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD: "authentication",
};

/**
 * The driver options for a URL: named prepared statements off when the URL
 * points at a transaction pooler, idle and lifetime timers off so no timer can
 * cancel a query, one pool per process.
 */
export function postgresOptions(url: string): {
  connectionTimeout: number;
  idleTimeout: number;
  max: number;
  maxLifetime: number;
  prepare: boolean;
} {
  return {
    connectionTimeout: connectionTimeoutSeconds,
    idleTimeout: 0,
    // The scheduler, a request and the nightly job; the floor is 240 MB.
    max: 4,
    maxLifetime: 0,
    prepare: !isTransactionPooler(url),
  };
}

/**
 * Whether the URL is a transaction pooler: port 6543 (Supavisor) or 6432
 * (PgBouncer, PlanetScale's), a host with `-pooler` (Neon), or
 * `pgbouncer=true` in the query (Supabase's own URLs).
 */
export function isTransactionPooler(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }
  return (
    poolerPorts.has(parsed.port) ||
    parsed.hostname.includes("-pooler") ||
    parsed.searchParams.get("pgbouncer") === "true"
  );
}

/**
 * The URL the driver is given: the operator's, without `pgbouncer`, which is
 * Raaqeb's own marker of a pooler. The driver sends every query parameter it
 * does not know to the server as a setting, and the server refuses the
 * connection over an unknown one.
 */
export function driverUrl(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed?.searchParams.has("pgbouncer")) {
    return url;
  }
  parsed.searchParams.delete("pgbouncer");
  return parsed.toString();
}

/**
 * Connects and proves it with one round trip, retrying a refused or dropped
 * connection until the window closes. Each attempt is bounded by the driver's
 * `connectionTimeout`, so a hang never outlives the window by much.
 */
export async function openPostgres(
  url: string,
  options: PostgresOpenOptions = {}
): Promise<PostgresOpenResult> {
  if (!parseUrl(url)) {
    return { failure: "malformed", ok: false };
  }
  const deadline = Date.now() + (options.windowMs ?? defaultConnectWindowMs);
  let failure: ConnectFailure = "unknown";
  do {
    // biome-ignore lint/performance/noAwaitInLoops: attempts are one after another by design
    const attempt = await connectOnce(url);
    if (attempt.ok) {
      return attempt;
    }
    ({ failure } = attempt);
    if (!transient.has(failure)) {
      break;
    }
    // The last pause ends at the deadline, so the window is not overshot.
    await Bun.sleep(Math.min(retryPauseMs, deadline - Date.now()));
  } while (Date.now() < deadline);
  return { failure, ok: false };
}

/** The failure code for a driver error; the text is never relayed. */
export function classifyConnectError(error: unknown): ConnectFailure {
  if (typeof error !== "object" || error === null) {
    return "unknown";
  }
  const { code, errno, message } = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  for (const key of [code, errno]) {
    if (typeof key === "string" && key in failureByCode) {
      return failureByCode[key] ?? "unknown";
    }
  }
  // A TLS hostname mismatch arrives as an empty message with errno 0.
  if (message === "" && errno === 0) {
    return "tls";
  }
  return "unknown";
}

async function connectOnce(url: string): Promise<PostgresOpenResult> {
  // The URL is passed whole; an options object loses the TLS host check.
  const client = new SQL({ url: driverUrl(url), ...postgresOptions(url) });
  try {
    await client.unsafe("SELECT 1");
  } catch (error) {
    await client.close().catch(() => undefined);
    return { failure: classifyConnectError(error), ok: false };
  }
  return {
    connection: { backend: "postgres", client, db: drizzle({ client }) },
    ok: true,
  };
}

function parseUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

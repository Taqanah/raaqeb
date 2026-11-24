/**
 * The database check's live I/O: one connection per check over Bun's
 * own drivers, `Bun.SQL` for Postgres and MySQL and `Bun.RedisClient` for
 * Redis, or Raaqeb's own MongoDB client (mongodb.ts), opened with the
 * connection URL, asked one query, closed. The one
 * file outside `server/storage` that opens `Bun.SQL`: here it reaches a
 * monitored server, never Raaqeb's own database (scripts/import-rules.test.ts).
 * Each driver is a parameter, so a test can hand in a fake.
 */
import { type DatabaseQuery, passwordOf } from "./database.ts";
import { liveMongoPlatform, type MongoQuery, openMongo } from "./mongodb.ts";

/** A query the driver started: awaited for its rows, or cancelled when the check gives up on it. */
export interface SqlQuery extends PromiseLike<unknown> {
  cancel: () => unknown;
}

/** What the adapter asks of a SQL client: one query, then a close. */
export interface SqlClient {
  close: (options?: { readonly timeout?: number }) => Promise<void>;
  unsafe: (query: string) => SqlQuery;
}

/** What the adapter asks of a Redis client: one command, then a close. */
export interface RedisConnection {
  close: () => void;
  send: (command: string, args: string[]) => Promise<unknown>;
}

/** The options the adapter opens a SQL client with. */
export interface SqlOptions {
  /** Seconds, as Bun's driver counts them. */
  readonly connectionTimeout: number;
  readonly idleTimeout: number;
  readonly max: number;
  readonly maxLifetime: number;
  /** The URL's own password, as a function: Bun then never fills a missing one from `PGPASSWORD` or `MYSQL_PASSWORD`. */
  readonly password: () => string;
  /** Postgres only: Bun's MySQL driver refuses the option. */
  readonly prepare?: boolean;
  readonly url: string;
}

/** The options the adapter opens a Redis client with. */
export interface RedisOptions {
  readonly autoReconnect: boolean;
  /** Milliseconds, as Bun's Redis client counts them. */
  readonly connectionTimeout: number;
  readonly enableAutoPipelining: boolean;
}

export interface DatabaseDrivers {
  /** Raaqeb's own MongoDB client (mongodb.ts): a connection that answers one command and closes. */
  readonly mongodb: (query: MongoQuery) => {
    readonly ask: () => Promise<unknown>;
    readonly close: () => void;
  };
  readonly redis: (url: string, options: RedisOptions) => RedisConnection;
  readonly sql: (options: SqlOptions) => SqlClient;
}

/** Opens a connection to the URL, runs the query, closes the connection and answers the first value; rejects with the driver's error, or a `TimeoutError` past the timeout. */
export async function queryOnce(
  query: DatabaseQuery,
  drivers: DatabaseDrivers
): Promise<unknown> {
  const connection =
    query.type === "mongodb"
      ? drivers.mongodb({
          command: query.query,
          timeoutMs: query.timeoutMs,
          url: query.url,
        })
      : open(query, drivers);
  let timer: Timer | undefined;
  // The drivers bound the connect alone; one timer bounds the sign-in and the query too.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new DOMException("The operation timed out.", "TimeoutError")),
      query.timeoutMs
    );
  });
  try {
    return await Promise.race([connection.ask(), timeout]);
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}

/** A connection that answers one query and closes; the close never waits on the server. */
function open(
  query: DatabaseQuery,
  drivers: DatabaseDrivers
): { ask: () => Promise<unknown>; close: () => void } {
  if (query.type === "redis") {
    const redis = drivers.redis(query.url, {
      autoReconnect: false,
      connectionTimeout: query.timeoutMs,
      enableAutoPipelining: false,
    });
    const [command = "", ...args] = query.query.trim().split(spaces);
    return { ask: () => redis.send(command, args), close: () => redis.close() };
  }
  const sql = drivers.sql({
    connectionTimeout: Math.ceil(query.timeoutMs / 1000),
    idleTimeout: 0,
    max: 1,
    maxLifetime: 0,
    password: () => passwordOf(query.url),
    url: query.url,
    // Named statements break behind a transaction pooler; Bun's MySQL driver refuses the option outright.
    ...(query.type === "postgres" && { prepare: false }),
  });
  // The query in flight, if any: the one a close has to stop.
  let running: SqlQuery | undefined;
  const ask = async (text: string): Promise<unknown> => {
    running = sql.unsafe(text);
    try {
      return await running;
    } finally {
      running = undefined;
    }
  };
  return {
    // One row is all the check reads, and Bun's drivers hold a whole result set: MySQL caps every SELECT on the connection, Postgres wraps a SELECT in a LIMIT.
    ask: async () => {
      if (query.type === "mysql") {
        await ask("SET SESSION sql_select_limit = 1");
        return firstValue(await ask(query.query));
      }
      return firstValue(await ask(firstRowOf(query.query)));
    },
    // Postgres stops a cancelled statement on the server; MySQL runs one already sent to its end (Bun 1.4.5).
    close: () => {
      running?.cancel();
      sql.close({ timeout: 0 }).catch(() => undefined);
    },
  };
}

const spaces = /\s+/;
const readsRows = /^\s*(select|with)\b/i;
const trailingSemicolons = /[\s;]+$/;

/** A Postgres SELECT or WITH query asked for its first row alone; any other statement, such as SHOW, as it came. A subquery keeps duplicate column names on Postgres, which MySQL would refuse. */
function firstRowOf(query: string): string {
  const statement = query.trim().replace(trailingSemicolons, "");
  // A semicolon left inside could end the statement before the wrapper's parenthesis; the line breaks keep a trailing comment off it.
  return readsRows.test(statement) && !statement.includes(";")
    ? `SELECT * FROM (\n${statement}\n) AS raaqeb_check LIMIT 1`
    : query;
}

/** The first value of a SQL answer: the first column of the first row, or nothing when no row came back. */
export function firstValue(rows: unknown): unknown {
  const [row] = Array.isArray(rows) ? rows : [];
  return typeof row === "object" && row !== null
    ? Object.values(row)[0]
    : undefined;
}

/** Bun's drivers. */
export const liveDrivers: DatabaseDrivers = {
  mongodb: (query) => openMongo(query, liveMongoPlatform),
  redis: (url, options) => new Bun.RedisClient(url, options),
  sql: (options) => new Bun.SQL(options),
};

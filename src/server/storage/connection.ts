/**
 * The open database behind the storage module: Drizzle over `bun:sqlite` or
 * over Bun's Postgres driver. Repositories run dialect-neutral SQL
 * through an executor so each is written once; Drizzle renders identifiers and
 * placeholders for the dialect at hand. Only this folder sees these types.
 */

import type { Database as SqliteClient } from "bun:sqlite";
import type { SQL as PostgresClient } from "bun";
import { type SQL, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import type { PgTable } from "drizzle-orm/pg-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
// biome-ignore lint/performance/noNamespaceImport: the table map is every table the schema file exports
import * as postgresSchema from "./schema/postgres.ts";
// biome-ignore lint/performance/noNamespaceImport: the table map is every table the schema file exports
import * as sqliteSchema from "./schema/sqlite.ts";

export type Backend = "sqlite" | "postgres";

export type Connection =
  | {
      backend: "sqlite";
      client: SqliteClient;
      db: SQLiteBunDatabase;
      file: string;
    }
  | { backend: "postgres"; client: PostgresClient; db: BunSQLDatabase };

export type SqliteConnection = Extract<Connection, { backend: "sqlite" }>;
export type PostgresConnection = Extract<Connection, { backend: "postgres" }>;

/** The tables of the connection's dialect, so a query can name them. */
export type Tables = typeof sqliteSchema | typeof postgresSchema;

/** A schema file as the map takes it: only tables, under the other file's names. */
type Schema<Table, Other> = Record<string, Table> & Record<keyof Other, Table>;

// A non-table export, or a table only one schema file declares, fails to compile here.
export const tables = {
  postgres: postgresSchema satisfies Schema<PgTable, typeof sqliteSchema>,
  sqlite: sqliteSchema satisfies Schema<SQLiteTable, typeof postgresSchema>,
} satisfies Record<Backend, Tables>;

/** Runs one dialect-neutral statement on the connection. */
export interface Executor {
  readonly backend: Backend;
  /** Runs work that must never land inside a transaction (a SQLite checkpoint): on SQLite in the queue after every transaction asked for before it, on Postgres at once, since each transaction there holds its own connection. */
  exclusive: <T>(work: () => T | Promise<T>) => Promise<T>;
  /** The rows a query answers. */
  rows: <T>(query: SQL) => Promise<T[]>;
  /** Runs a statement for its effect and answers how many rows it changed. */
  run: (query: SQL) => Promise<number>;
  readonly tables: Tables;
  /** Runs the work as one transaction: every statement lands or none does. A throw rolls back and is rethrown. */
  transaction: <T>(work: (tx: Executor) => Promise<T>) => Promise<T>;
}

/** What a Postgres query runs on: the pool or a transaction inside it. */
interface PostgresRunner {
  execute: <T extends Record<string, unknown>>(
    query: SQL
  ) => Promise<Iterable<T>>;
}

export function executor(connection: Connection): Executor {
  if (connection.backend === "sqlite") {
    return sqliteExecutor(connection.db);
  }
  return postgresExecutor(connection.db);
}

/**
 * bun:sqlite is synchronous and the file has one connection, so a
 * transaction is BEGIN and COMMIT around work whose awaits all resolve at
 * once; no other queued work runs in between, though a bare statement from
 * another async chain can land inside it, so work that must not (a
 * checkpoint) goes through `exclusive`. Two transactions asked
 * for at once (checks of several monitors landing together) run one after
 * the other through a queue, since SQLite refuses a BEGIN inside a
 * transaction. The lock is taken up front so a reader in the same process
 * never turns into a deadlock.
 */
function sqliteExecutor(db: SQLiteBunDatabase): Executor {
  let queue: Promise<unknown> = Promise.resolve();
  const self: Executor = {
    backend: "sqlite",
    exclusive: (work) => {
      const turn = queue.then(work);
      queue = turn.catch(() => undefined);
      return turn;
    },
    rows: <T>(query: SQL) => Promise.resolve(db.all<T>(query)),
    run: (query) => Promise.resolve(db.run(query).changes),
    tables: tables.sqlite,
    transaction: (work) => {
      const turn = queue.then(async () => {
        db.run(sql`BEGIN IMMEDIATE`);
        try {
          const result = await work(self);
          db.run(sql`COMMIT`);
          return result;
        } catch (error) {
          db.run(sql`ROLLBACK`);
          throw error;
        }
      });
      // The next transaction waits for this one to end either way.
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
  return self;
}

function postgresExecutor(
  db: BunSQLDatabase,
  runner: PostgresRunner = db
): Executor {
  return {
    backend: "postgres",
    exclusive: async (work) => await work(),
    rows: async <T>(query: SQL) => {
      const result = await runner.execute<Record<string, unknown>>(query);
      return Array.from(result, (row) => plainNumbers(row) as T);
    },
    run: async (query) => {
      const result = await runner.execute(query);
      // Bun's driver answers the changed rows as `count` beside the rows; Drizzle's type names only the rows.
      return "count" in result && typeof result.count === "number"
        ? result.count
        : 0;
    },
    tables: tables.postgres,
    // Drizzle holds one pool connection for the whole callback; a nested transaction is a savepoint.
    transaction: (work) =>
      db.transaction((tx) => work(postgresExecutor(db, tx))),
  };
}

/**
 * The Postgres driver answers a 64-bit column as a BigInt. Every 64-bit
 * column Raaqeb has is a millisecond timestamp, which fits a number, so a raw
 * row reads the same on both backends. In place, by `for...in`: the driver's
 * row is new for this read, and `Object.entries` on it took half of a long
 * read's time.
 */
function plainNumbers(row: Record<string, unknown>): Record<string, unknown> {
  for (const key in row) {
    if (!Object.hasOwn(row, key)) {
      continue;
    }
    const value = row[key];
    if (typeof value === "bigint" && Number.isSafeInteger(Number(value))) {
      row[key] = Number(value);
    }
  }
  return row;
}

/** Closes the driver; the SQLite write-ahead log is checkpointed by the close. */
export async function closeConnection(connection: Connection): Promise<void> {
  if (connection.backend === "sqlite") {
    connection.client.close(true);
    return;
  }
  await connection.client.close();
}

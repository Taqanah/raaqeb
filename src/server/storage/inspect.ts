/**
 * The connection test: classifies what a database holds
 * without changing it. Used at every boot and by the onboarding database
 * screen. Connecting never deletes anything.
 */
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  type Connection,
  closeConnection,
  executor,
  tables,
} from "./connection.ts";
import { localMigrations } from "./migrationfiles.ts";
import {
  type ConnectFailure,
  openPostgres,
  type PostgresOpenOptions,
} from "./postgres.ts";

/** What the test found. */
export type Verdict =
  /** No tables at all: migrations create Raaqeb's. */
  | { kind: "empty" }
  /** Raaqeb tables with a migration record at version N: adopted and migrated forward. */
  | { kind: "raaqeb"; version: number }
  /** Raaqeb tables with a record naming migrations this binary does not carry: refused, a newer Raaqeb wrote it. */
  | { kind: "newer"; version: number }
  /** A record that is not Raaqeb's and no Raaqeb tables: another application's database, refused. */
  | { kind: "foreign-record" }
  /** Only tables Raaqeb does not know: Raaqeb proceeds and touches only its own. */
  | { kind: "foreign"; tables: number }
  /** Raaqeb table names with no migration record: refused. */
  | { kind: "unrecorded" };

export type UrlVerdict =
  | Verdict
  | { kind: "unreachable"; failure: ConnectFailure };

/** The migration record's table; on Postgres it sits in the public schema with the rest. */
export const migrationsTable = "__drizzle_migrations";

/** The tables Raaqeb owns: the schema's, sorted, plus the migration record. */
export const raaqebTables: readonly string[] = [
  ...Object.values(tables.sqlite)
    .map((table) => getTableConfig(table).name)
    .toSorted((a, b) => a.localeCompare(b)),
  migrationsTable,
];

/** Classifies an open database against the migrations under `migrations`, the source tree's by default. */
export async function inspectDatabase(
  connection: Connection,
  migrations?: string
): Promise<Verdict> {
  const present = await listTables(connection);
  if (present.length === 0) {
    return { kind: "empty" };
  }
  const ours = present.some(
    (name) => name !== migrationsTable && raaqebTables.includes(name)
  );
  if (present.includes(migrationsTable)) {
    const recorded = await recordedMigrations(connection);
    const known = new Set(
      await localMigrations(connection.backend, migrations)
    );
    if (recorded.every((name) => known.has(name))) {
      return { kind: "raaqeb", version: recorded.length };
    }
    // A name this binary does not carry: a newer raaqeb wrote it when Raaqeb
    // tables are there, another application otherwise. The stock migrator
    // selects by name too, so adopting either would apply every local
    // migration on top and the next boot would refuse the result.
    return ours
      ? { kind: "newer", version: recorded.length }
      : { kind: "foreign-record" };
  }
  if (ours) {
    return { kind: "unrecorded" };
  }
  return { kind: "foreign", tables: present.length };
}

/** Connects to a Postgres URL, classifies it and disconnects; for the onboarding screen. */
export async function inspectPostgresUrl(
  url: string,
  options?: PostgresOpenOptions & { readonly migrations?: string }
): Promise<UrlVerdict> {
  const opened = await openPostgres(url, options);
  if (!opened.ok) {
    return { failure: opened.failure, kind: "unreachable" };
  }
  try {
    return await inspectDatabase(opened.connection, options?.migrations);
  } finally {
    await closeConnection(opened.connection);
  }
}

/** The user tables present, sorted; `sqlite_%` and system schemas excluded. */
export async function listTables(connection: Connection): Promise<string[]> {
  const run = executor(connection);
  const rows =
    connection.backend === "sqlite"
      ? await run.rows<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
        )
      : await run.rows<{ name: string }>(
          sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        );
  return rows.map((row) => row.name).toSorted((a, b) => a.localeCompare(b));
}

/** The names in the migration record, in the order they were written. */
export async function recordedMigrations(
  connection: Connection
): Promise<string[]> {
  const rows = await executor(connection).rows<{ name: string | null }>(
    sql`SELECT name FROM ${sql.identifier(migrationsTable)} ORDER BY id`
  );
  return rows.map((row) => row.name ?? "");
}

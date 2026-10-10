/**
 * Test support: one location per test file, a temp SQLite file by default and
 * the compose Postgres when `RAAQEB_TEST_DATABASE_URL` is set
 * (scripts/test-postgres.ts), so the same test files run on both backends.
 * The boot setting `DATABASE_URL` is never read here: a test run
 * drops every table in the database it targets. Not product code.
 */
import { SQL } from "bun";
import type { Connection } from "./connection.ts";
import { openPostgres } from "./postgres.ts";
import { openSqlite, sqliteFileName } from "./sqlite.ts";
import type { DatabaseLocation } from "./storage.ts";

/** The Postgres the run targets, or nothing in the SQLite run. */
export function fixtureUrl(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  return env.RAAQEB_TEST_DATABASE_URL;
}

/** Which backend this run targets. */
export function fixtureBackend(
  env: Readonly<Record<string, string | undefined>> = process.env
): "sqlite" | "postgres" {
  return fixtureUrl(env) ? "postgres" : "sqlite";
}

/**
 * A database with nothing in it: a fresh temp SQLite file, or the Postgres
 * database with its public schema dropped and recreated. Call `cleanup`
 * when done.
 */
export async function scratchDatabase(): Promise<{
  location: DatabaseLocation;
  cleanup: () => Promise<void>;
}> {
  const url = fixtureUrl();
  if (url) {
    await resetPostgres(url);
    return {
      cleanup: () => Promise.resolve(),
      location: { backend: "postgres", url },
    };
  }
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  return {
    cleanup: async () => {
      await Bun.$`rm -rf ${dir}`.quiet();
    },
    location: { backend: "sqlite", file: `${dir}/${sqliteFileName}` },
  };
}

/** Drops everything in the public schema of the test database. */
async function resetPostgres(url: string): Promise<void> {
  const client = new SQL(url);
  try {
    await client.unsafe("DROP SCHEMA public CASCADE");
    await client.unsafe("CREATE SCHEMA public");
  } finally {
    await client.close();
  }
}

/**
 * Runs one SQL statement as text on a location, with `?` placeholders on both
 * backends, and answers its rows with 64-bit values as numbers. For tests
 * that reach into a table another module owns (a session row's expiry).
 */
export async function runSql(
  location: DatabaseLocation,
  text: string,
  params: readonly (string | number)[] = []
): Promise<Record<string, unknown>[]> {
  if (location.backend === "sqlite") {
    const connection = openSqlite(location.file);
    try {
      return connection.client
        .query<Record<string, unknown>, (string | number)[]>(text)
        .all(...params);
    } finally {
      connection.client.close();
    }
  }
  const client = new SQL(location.url);
  try {
    let index = 0;
    const numbered = text.replace(/\?/g, () => {
      index += 1;
      return `$${index}`;
    });
    const rows: Record<string, unknown>[] = await client.unsafe(numbered, [
      ...params,
    ]);
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "bigint" ? Number(value) : value,
        ])
      )
    );
  } finally {
    await client.close();
  }
}

/** A raw connection to a scratch location, for tests that prepare tables by hand. */
export async function connectTo(
  location: DatabaseLocation
): Promise<Connection> {
  if (location.backend === "sqlite") {
    return openSqlite(location.file);
  }
  const opened = await openPostgres(location.url, { windowMs: 5000 });
  if (!opened.ok) {
    throw new Error(`cannot reach the test Postgres: ${opened.failure}`);
  }
  return opened.connection;
}

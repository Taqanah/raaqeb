import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { type Connection, closeConnection, executor } from "./connection.ts";
import {
  connectTo,
  fixtureBackend,
  fixtureUrl,
  scratchDatabase,
} from "./fixture.ts";
import {
  inspectDatabase,
  inspectPostgresUrl,
  listTables,
  migrationsTable,
  raaqebTables,
} from "./inspect.ts";
import { migrateDatabase } from "./migrate.ts";
import { localMigrations } from "./migrationfiles.ts";

const onPostgres = fixtureBackend() === "postgres";
let open: { connection: Connection; cleanup: () => Promise<void> } | undefined;

async function fresh(): Promise<Connection> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  return connection;
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

/** A migration record with the given names, written the way the migrator writes it. */
async function recordMigrations(
  connection: Connection,
  names: string[]
): Promise<void> {
  const run = executor(connection);
  await run.run(
    sql.raw(
      `CREATE TABLE ${migrationsTable} (id integer PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at text)`
    )
  );
  await Promise.all(
    names.map((name, index) =>
      run.run(
        sql`INSERT INTO ${sql.identifier(migrationsTable)} (id, hash, created_at, name) VALUES (${index + 1}, 'x', 0, ${name})`
      )
    )
  );
}

describe("what Raaqeb owns", () => {
  test("the expected tables are the schema's tables and the migration record", () => {
    expect(raaqebTables).toEqual([
      "auth_account",
      "auth_session",
      "auth_two_factor",
      "auth_user",
      "auth_verification",
      "captures",
      "certificate_records",
      "change_counter",
      "channels",
      "checks",
      "component_groups",
      "component_monitors",
      "components",
      "daily_rollups",
      "failure_details",
      "groups",
      "heartbeats",
      "hourly_rollups",
      "incident_statuses",
      "incident_updates",
      "incidents",
      "maintenance_components",
      "maintenance_windows",
      "monitor_channels",
      "monitor_tags",
      "monitors",
      "notifications",
      "outages",
      "page_components",
      "page_images",
      "sealed_days",
      "settings",
      "status_pages",
      "subscriptions",
      "tags",
      migrationsTable,
    ]);
  });
});

describe("the connection test classifies without changing anything", () => {
  test("a database with no tables is empty, and stays so", async () => {
    const connection = await fresh();
    expect(await inspectDatabase(connection)).toEqual({ kind: "empty" });
    expect(await listTables(connection)).toEqual([]);
  });

  test("a migrated database is Raaqeb at the version the record shows", async () => {
    const connection = await fresh();
    await migrateDatabase(connection);
    const version = (await localMigrations(connection.backend)).length;
    expect(version).toBeGreaterThan(0);
    expect(await inspectDatabase(connection)).toEqual({
      kind: "raaqeb",
      version,
    });
  });

  test("a record ahead of this binary is newer, and refused by the caller", async () => {
    const connection = await fresh();
    await migrateDatabase(connection);
    await executor(connection).run(
      sql`INSERT INTO ${sql.identifier(migrationsTable)} (hash, created_at, name) VALUES ('x', 0, '99991231235959_from_the_future')`
    );
    const version = (await localMigrations(connection.backend)).length + 1;
    expect(await inspectDatabase(connection)).toEqual({
      kind: "newer",
      version,
    });
  });

  test("only tables Raaqeb does not know are foreign, counted not named", async () => {
    const connection = await fresh();
    const run = executor(connection);
    await run.run(sql`CREATE TABLE customers (id integer PRIMARY KEY)`);
    await run.run(sql`CREATE TABLE orders (id integer PRIMARY KEY)`);
    expect(await inspectDatabase(connection)).toEqual({
      kind: "foreign",
      tables: 2,
    });
  });

  test("Raaqeb table names with no migration record are unrecorded", async () => {
    const connection = await fresh();
    await executor(connection).run(
      sql`CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL)`
    );
    expect(await inspectDatabase(connection)).toEqual({ kind: "unrecorded" });
  });

  test("Raaqeb tables with a record naming migrations this raaqeb does not carry are newer, however short", async () => {
    // Adopting it would apply every local migration on top and refuse the next boot.
    const connection = await fresh();
    await recordMigrations(connection, ["20260101000000_init"]);
    await executor(connection).run(
      sql`CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL)`
    );
    expect(await inspectDatabase(connection)).toEqual({
      kind: "newer",
      version: 1,
    });
  });

  test("a record that is not Raaqeb's with no Raaqeb tables is another application's", async () => {
    // Sharing its migration record is never safe; refusing it must not say "upgrade raaqeb".
    const connection = await fresh();
    await recordMigrations(connection, ["0001_other_app"]);
    await executor(connection).run(
      sql`CREATE TABLE customers (id integer PRIMARY KEY)`
    );
    expect(await inspectDatabase(connection)).toEqual({
      kind: "foreign-record",
    });
  });

  test("a record with nothing in it is Raaqeb at version 0", async () => {
    const connection = await fresh();
    await recordMigrations(connection, []);
    expect(await inspectDatabase(connection)).toEqual({
      kind: "raaqeb",
      version: 0,
    });
  });

  test("the list of tables leaves out SQLite's own and the system schemas", async () => {
    const connection = await fresh();
    const run = executor(connection);
    await run.run(sql`CREATE TABLE b (id integer PRIMARY KEY)`);
    await run.run(sql`CREATE TABLE a (id integer PRIMARY KEY)`);
    await run.run(sql`CREATE INDEX a_id ON a (id)`);
    expect(await listTables(connection)).toEqual(["a", "b"]);
  });
});

describe("testing a Postgres URL for the onboarding screen", () => {
  test("nothing listening is unreachable with the failure code", async () => {
    expect(
      await inspectPostgresUrl("postgres://u:p@127.0.0.1:1/raaqeb", {
        windowMs: 200,
      })
    ).toEqual({ failure: "refused", kind: "unreachable" });
  });

  test.if(onPostgres)(
    "the compose Postgres answers a verdict and is left alone",
    async () => {
      await scratchDatabase();
      const url = fixtureUrl() ?? "";
      expect(await inspectPostgresUrl(url, { windowMs: 5000 })).toEqual({
        kind: "empty",
      });
      expect(await inspectPostgresUrl(url, { windowMs: 5000 })).toEqual({
        kind: "empty",
      });
    }
  );
});

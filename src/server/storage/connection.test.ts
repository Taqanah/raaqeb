import { afterEach, describe, expect, test } from "bun:test";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  type Connection,
  closeConnection,
  executor,
  type PostgresPool,
  postgresExecutor,
  tables,
} from "./connection.ts";
import { connectTo, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
// biome-ignore lint/performance/noNamespaceImport: the test must see every table the schema file exports
import * as postgresSchema from "./schema/postgres.ts";
// biome-ignore lint/performance/noNamespaceImport: the test must see every table the schema file exports
import * as sqliteSchema from "./schema/sqlite.ts";

let open: { connection: Connection; cleanup: () => Promise<void> } | undefined;

async function migrated(): Promise<Connection> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  await migrateDatabase(connection);
  return connection;
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const groupCount = async (run: ReturnType<typeof executor>) => {
  const rows = await run.rows<{ n: number | string }>(
    sql`SELECT count(*) AS n FROM ${run.tables.groups}`
  );
  return Number(rows[0]?.n);
};

describe("a transaction on the connection", () => {
  test("two transactions asked for at once land one after the other, each whole", async () => {
    const run = executor(await migrated());
    const insert =
      (id: string, name: string) => (tx: ReturnType<typeof executor>) =>
        tx.run(
          sql`INSERT INTO ${tx.tables.groups} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("created_at")}) VALUES (${id}, ${name}, 1)`
        );
    await Promise.all([
      run.transaction(async (tx) => {
        await insert("g1", "a")(tx);
        await insert("g2", "b")(tx);
      }),
      run.transaction(async (tx) => {
        await insert("g3", "c")(tx);
        await insert("g4", "d")(tx);
      }),
    ]);
    expect(await groupCount(run)).toBe(4);
  });

  test("a transaction that fails does not hold up the next one", async () => {
    const run = executor(await migrated());
    const failing = run.transaction(() => Promise.reject(new Error("first")));
    const next = run.transaction(async (tx) => {
      await tx.run(
        sql`INSERT INTO ${tx.tables.groups} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("created_at")}) VALUES ('g1', 'a', 1)`
      );
    });
    await expect(failing).rejects.toThrow("first");
    await next;
    expect(await groupCount(run)).toBe(1);
  });

  test("lands nothing when the work throws, and the throw reaches the caller", async () => {
    const run = executor(await migrated());
    await expect(
      run.transaction(async (tx) => {
        await tx.run(
          sql`INSERT INTO ${tx.tables.groups} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("created_at")}) VALUES ('g1', 'a', 1)`
        );
        throw new Error("half way");
      })
    ).rejects.toThrow("half way");
    expect(await groupCount(run)).toBe(0);
  });

  test("lands nothing when a statement fails", async () => {
    const run = executor(await migrated());
    await expect(
      run.transaction(async (tx) => {
        await tx.run(
          sql`INSERT INTO ${tx.tables.groups} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("created_at")}) VALUES ('g1', 'a', 1)`
        );
        await tx.run(
          sql`INSERT INTO ${tx.tables.groups} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("created_at")}) VALUES ('g2', 'a', 1)`
        );
      })
    ).rejects.toThrow();
    expect(await groupCount(run)).toBe(0);
    // The connection is usable after the rollback.
    await run.run(
      sql`INSERT INTO ${run.tables.groups} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("created_at")}) VALUES ('g3', 'c', 1)`
    );
    expect(await groupCount(run)).toBe(1);
  });
});

describe("a statement on the connection", () => {
  test("answers how many rows it changed, inside a transaction or not", async () => {
    const run = executor(await migrated());
    const insert = (id: string) =>
      sql`INSERT INTO ${run.tables.groups} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("created_at")}) VALUES (${id}, ${id}, 1)`;
    expect(await run.run(insert("g1"))).toBe(1);
    expect(
      await run.transaction(async (tx) => {
        await tx.run(insert("g2"));
        return tx.run(insert("g3"));
      })
    ).toBe(1);
    expect(
      await run.run(
        sql`DELETE FROM ${run.tables.groups} WHERE ${sql.identifier("created_at")} = 1`
      )
    ).toBe(3);
    expect(
      await run.run(
        sql`DELETE FROM ${run.tables.groups} WHERE ${sql.identifier("created_at")} = 1`
      )
    ).toBe(0);
  });
});

describe("a statement the Postgres database does not answer", () => {
  // Answers long after the limit, as a database that never answers would.
  const silent = () =>
    new Promise<Iterable<never>>((resolve) => setTimeout(resolve, 400, []));
  const poolOf = (answers: () => Promise<Iterable<never>>): PostgresPool => ({
    execute: answers,
    transaction: (work) => work({ execute: answers }),
  });

  test("a read fails at the limit instead of waiting for good", async () => {
    const run = postgresExecutor(poolOf(silent), poolOf(silent), 30);
    await expect(run.rows(sql`SELECT 1`)).rejects.toThrow("did not answer");
  });

  test("a write fails at the limit too", async () => {
    const run = postgresExecutor(poolOf(silent), poolOf(silent), 30);
    await expect(run.run(sql`DELETE FROM x`)).rejects.toThrow("did not answer");
  });

  test("after one miss the next statements fail at once, without asking the database again", async () => {
    let asked = 0;
    const counting = () => {
      asked += 1;
      return silent();
    };
    const run = postgresExecutor(poolOf(counting), poolOf(counting), 30);
    await expect(run.rows(sql`SELECT 1`)).rejects.toThrow("did not answer");
    const started = performance.now();
    await expect(run.rows(sql`SELECT 1`)).rejects.toThrow("did not answer");
    await expect(run.run(sql`DELETE FROM x`)).rejects.toThrow("did not answer");
    expect(performance.now() - started).toBeLessThan(20);
    expect(asked).toBe(1);
  });

  test("once the limit has passed again the database is asked, and a database that is back is read as before", async () => {
    const database: { back: boolean } = { back: false };
    const flaky = () => (database.back ? Promise.resolve([]) : silent());
    const run = postgresExecutor(poolOf(flaky), poolOf(flaky), 30);
    await expect(run.rows(sql`SELECT 1`)).rejects.toThrow("did not answer");
    database.back = true;
    await Bun.sleep(40);
    expect(await run.rows(sql`SELECT 1`)).toEqual([]);
  });

  test("a slow statement inside a transaction is left to finish", async () => {
    const slow = () =>
      new Promise<Iterable<never>>((resolve) => setTimeout(resolve, 80, []));
    const run = postgresExecutor(poolOf(slow), poolOf(slow), 20);
    expect(await run.transaction((tx) => tx.rows(sql`SELECT 1`))).toEqual([]);
  });

  test("an answer inside the limit is read as before", async () => {
    const quick = () => Promise.resolve([]);
    const run = postgresExecutor(poolOf(quick), poolOf(quick), 30);
    expect(await run.rows(sql`SELECT 1`)).toEqual([]);
  });
});

/** Each export of a module by its name, sorted by name. */
const exportsOf = (module: object) =>
  Object.entries(module).toSorted(([a], [b]) => a.localeCompare(b));

describe("the table map", () => {
  test("each backend names every table its schema file exports, and only those", () => {
    for (const [mapped, schema] of [
      [tables.sqlite, sqliteSchema],
      [tables.postgres, postgresSchema],
    ] as const) {
      const declared = new Map(exportsOf(schema));
      expect(exportsOf(mapped).map(([name]) => name)).toEqual([
        ...declared.keys(),
      ]);
      for (const [name, table] of exportsOf(mapped)) {
        expect(table).toBe(declared.get(name));
      }
    }
  });

  test("a schema file exports tables and nothing else", () => {
    for (const [, value] of exportsOf(sqliteSchema)) {
      expect(is(value, SQLiteTable)).toBe(true);
    }
    for (const [, value] of exportsOf(postgresSchema)) {
      expect(is(value, PgTable)).toBe(true);
    }
  });

  test("a table goes by the same name in code and in the database on both backends", () => {
    const names = (map: object) =>
      exportsOf(map).map(([name, table]) => [
        name,
        is(table, SQLiteTable) || is(table, PgTable)
          ? getTableName(table)
          : undefined,
      ]);
    expect(names(tables.sqlite)).toEqual(names(tables.postgres));
  });
});

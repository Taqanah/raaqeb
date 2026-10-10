import { afterEach, describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, scratchDatabase } from "./fixture.ts";
import { listTables, raaqebTables } from "./inspect.ts";
import { appliedMigrations, migrateDatabase } from "./migrate.ts";
import { localMigrations, migrationsFolder } from "./migrationfiles.ts";
import { snapshotDir } from "./sqlite.ts";

const drizzleKitName = /^\d{14}_[a-z0-9_]+$/;

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

async function snapshots(connection: Connection): Promise<string[]> {
  if (connection.backend !== "sqlite") {
    return [];
  }
  const dir = snapshotDir(connection.file);
  if (
    !(await Bun.file(dir)
      .stat()
      .catch(() => undefined))
  ) {
    return [];
  }
  return (
    await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir }))
  ).toSorted();
}

describe("the migrations on disk", () => {
  test("one folder per dialect under storage/migrations", () => {
    expect(migrationsFolder("sqlite")).toEndWith(
      "/src/server/storage/migrations/sqlite"
    );
    expect(migrationsFolder("postgres")).toEndWith(
      "/src/server/storage/migrations/postgres"
    );
  });

  test("both dialects carry the same number of migrations, drizzle-kit named", async () => {
    const sqlite = await localMigrations("sqlite");
    const postgres = await localMigrations("postgres");
    expect(sqlite.length).toBe(postgres.length);
    expect(sqlite.length).toBeGreaterThan(0);
    for (const name of [...sqlite, ...postgres]) {
      expect(name).toMatch(drizzleKitName);
    }
  });
});

describe("migrating on start", () => {
  test("a fresh database gets every migration and every expected table", async () => {
    const connection = await fresh();
    const now = () => Date.UTC(2026, 8, 15, 12);
    const result = await migrateDatabase(connection, { now });
    const local = await localMigrations(connection.backend);
    expect(result).toEqual({
      applied: local,
      ok: true,
      snapshot:
        connection.backend === "sqlite"
          ? `${snapshotDir(connection.file)}/raaqeb-20260915T120000Z-before-${local[0]}.sqlite`
          : undefined,
    });
    expect(await listTables(connection)).toEqual([...raaqebTables].toSorted());
    expect(await appliedMigrations(connection)).toEqual(local);
  });

  test("a second start applies nothing and takes no snapshot", async () => {
    const connection = await fresh();
    await migrateDatabase(connection);
    const before = await snapshots(connection);
    const result = await migrateDatabase(connection);
    expect(result).toEqual({ applied: [], ok: true, snapshot: undefined });
    expect(await snapshots(connection)).toEqual(before);
  });

  test("the change counter row is seeded at zero by the migration", async () => {
    const connection = await fresh();
    await migrateDatabase(connection);
    const rows = await executor(connection).rows<{ id: number; value: number }>(
      sql`SELECT id, value FROM change_counter`
    );
    expect(rows).toEqual([{ id: 1, value: 0 }]);
  });

  test("a database with no record has none applied", async () => {
    const connection = await fresh();
    expect(await appliedMigrations(connection)).toEqual([]);
  });

  test("a failing migration is named, nothing of it stays, and SQLite keeps the snapshot", async () => {
    const connection = await fresh();
    // A table in the way of the first migration's CREATE TABLE.
    await executor(connection).run(sql`CREATE TABLE settings (wrong integer)`);
    const local = await localMigrations(connection.backend);
    const result = await migrateDatabase(connection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.migration).toBe(local[0]);
      // The stock migrator creates the record table outside the transaction, so "unchanged" would be false.
      expect(result.message).toBe(
        `migration ${local[0]} failed and was rolled back; nothing of it was applied${connection.backend === "sqlite" ? ", and a snapshot was taken first" : ""}`
      );
    }
    const tables = await listTables(connection);
    expect(tables).not.toContain("change_counter");
    expect(await appliedMigrations(connection)).toEqual([]);
    if (connection.backend === "sqlite") {
      expect(await snapshots(connection)).toHaveLength(1);
    }
  });

  test("a snapshot that cannot be taken stops before the migration, naming it", async () => {
    const connection = await fresh();
    if (connection.backend !== "sqlite") {
      return;
    }
    // A file where the snapshots folder must go.
    await Bun.write(snapshotDir(connection.file), "in the way");
    const local = await localMigrations(connection.backend);
    const result = await migrateDatabase(connection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.migration).toBe(local[0]);
      expect(result.message).toBe(
        `cannot take the snapshot before migration ${local[0]}; the database is untouched (snapshots/ in the data directory must be a writable folder)`
      );
    }
    expect(await listTables(connection)).toEqual([]);
  });

  test("a table missing after the run is reported by name", async () => {
    const connection = await fresh();
    await migrateDatabase(connection);
    await executor(connection).run(sql`DROP TABLE change_counter`);
    const result = await migrateDatabase(connection);
    expect(result).toEqual({
      message:
        "the database is missing the table change_counter after migrating",
      migration: undefined,
      ok: false,
    });
  });
});

describe("the published switch arriving on an install that has pages", () => {
  test("every page that exists when the migration runs stays published, and a page stored after it without the switch starts unpublished", async () => {
    const connection = await fresh();
    const root = (await Bun.$`mktemp -d`.text()).trim();
    const local = await localMigrations(connection.backend);
    const before = local.slice(
      0,
      local.findIndex((name) => name.endsWith("_published_pages"))
    );
    await Promise.all(
      before.map((name) =>
        Bun.write(
          `${root}/${connection.backend}/${name}/migration.sql`,
          Bun.file(
            `${migrationsFolder(connection.backend)}/${name}/migration.sql`
          )
        )
      )
    );
    const run = executor(connection);
    const page = (id: string) =>
      run.run(
        sql`INSERT INTO status_pages (id, slug, title, locale, is_default, customization, created_at, updated_at) VALUES (${id}, ${id}, ${id}, 'ar', 0, '{}', 0, 0)`
      );
    try {
      expect((await migrateDatabase(connection, { migrations: root })).ok).toBe(
        true
      );
      await page("live");
      expect((await migrateDatabase(connection)).ok).toBe(true);
      await page("new");
      const rows = await run.rows<{ id: string; published: number }>(
        sql`SELECT id, published FROM status_pages ORDER BY id`
      );
      expect(rows.map((row) => [row.id, Number(row.published)])).toEqual([
        ["live", 1],
        ["new", 0],
      ]);
    } finally {
      await Bun.$`rm -rf ${root}`.quiet();
    }
  });
});

describe("the migrations a build carries", () => {
  test("what is applied, and reported, is the folder's list, not the source tree's", async () => {
    const connection = await fresh();
    const root = (await Bun.$`mktemp -d`.text()).trim();
    const local = await localMigrations(connection.backend);
    // The last migration under another name: the report must name the folder's.
    const carried = local.map((name, index) =>
      index === local.length - 1 ? `${name}_carried` : name
    );
    await Promise.all(
      local.map((name, index) =>
        Bun.write(
          `${root}/${connection.backend}/${carried[index]}/migration.sql`,
          Bun.file(
            `${migrationsFolder(connection.backend)}/${name}/migration.sql`
          )
        )
      )
    );
    try {
      const result = await migrateDatabase(connection, { migrations: root });
      expect(result.ok && result.applied).toEqual(carried);
      expect(await appliedMigrations(connection)).toEqual(carried);
    } finally {
      await Bun.$`rm -rf ${root}`.quiet();
    }
  });
});

describe("content, one text per locale", () => {
  /** Migrates up to the bilingual content migration, runs the rows in, then migrates the rest; the database's rows after. */
  async function migratedFrom(
    connection: Connection,
    rows: readonly SQL[]
  ): Promise<string[]> {
    const root = (await Bun.$`mktemp -d`.text()).trim();
    const local = await localMigrations(connection.backend);
    const at = local.findIndex((name) => name.endsWith("_bilingual_content"));
    expect(at).toBeGreaterThan(0);
    const copy = (names: readonly string[]) =>
      Promise.all(
        names.map((name) =>
          Bun.write(
            `${root}/${connection.backend}/${name}/migration.sql`,
            Bun.file(
              `${migrationsFolder(connection.backend)}/${name}/migration.sql`
            )
          )
        )
      );
    try {
      await copy(local.slice(0, at));
      expect((await migrateDatabase(connection, { migrations: root })).ok).toBe(
        true
      );
      for (const row of rows) {
        // biome-ignore lint/performance/noAwaitInLoops: the rows go in one after the other
        await executor(connection).run(row);
      }
      await copy(local.slice(at));
      const result = await migrateDatabase(connection, { migrations: root });
      return result.ok ? result.applied : [];
    } finally {
      await Bun.$`rm -rf ${root}`.quiet();
    }
  }

  /** One column's JSON text, read back as values; null stays null. */
  async function column(connection: Connection, query: SQL) {
    return (await executor(connection).rows<{ v: string | null }>(query)).map(
      (row) => (row.v === null ? null : JSON.parse(row.v))
    );
  }

  test("existing content becomes the page language's text on a page and the install language's elsewhere", async () => {
    const connection = await fresh();
    const customization = JSON.stringify({
      description: "Our shop",
      footerLinks: [
        { label: "Help", url: "https://example.test/help" },
        { label: "Privacy", url: "https://example.test/privacy" },
      ],
      labels: { operational: "All good" },
    });
    const applied = await migratedFrom(connection, [
      sql`INSERT INTO settings (key, value, updated_at) VALUES ('install_language', '"en"', 0)`,
      sql`INSERT INTO components (id, name, description, status, created_at, updated_at) VALUES ('c1', 'Website', NULL, 'operational', 0, 0), ('c2', 'API', 'The public API', 'operational', 0, 0)`,
      sql`INSERT INTO status_pages (id, slug, title, locale, custom_domain, is_default, published, customization, created_at, updated_at) VALUES ('p1', 'main', 'حالة المتجر', 'ar', NULL, 1, 1, '{}', 0, 0), ('p2', 'shop', 'Shop status', 'en', NULL, 0, 1, ${customization}, 0, 0)`,
      sql`INSERT INTO component_groups (id, page_id, name, position) VALUES ('g1', 'p1', 'الخلفية', 0)`,
      sql`INSERT INTO incidents (id, title, impact, created_at, updated_at, resolved_at) VALUES ('i1', 'Slow checkout', 'minor', 0, 0, NULL)`,
      sql`INSERT INTO incident_updates (id, incident_id, stage, message, author, created_at) VALUES ('u1', 'i1', 'investigating', 'Looking into it.', 'owner@example.com', 0)`,
      sql`INSERT INTO maintenance_windows (id, title, message, starts_at, ends_at, stage, created_at, updated_at) VALUES ('w1', 'Upgrade', 'A new server.', 0, 1, 'completed', 0, 0)`,
    ]);
    expect(applied).toHaveLength(1);
    expect(
      await column(
        connection,
        sql`SELECT name AS v FROM components ORDER BY id`
      )
    ).toEqual([{ en: "Website" }, { en: "API" }]);
    expect(
      await column(
        connection,
        sql`SELECT description AS v FROM components ORDER BY id`
      )
    ).toEqual([null, { en: "The public API" }]);
    expect(
      await column(
        connection,
        sql`SELECT title AS v FROM status_pages ORDER BY id`
      )
    ).toEqual([{ ar: "حالة المتجر" }, { en: "Shop status" }]);
    expect(
      await column(connection, sql`SELECT name AS v FROM component_groups`)
    ).toEqual([{ ar: "الخلفية" }]);
    expect(
      await column(connection, sql`SELECT title AS v FROM incidents`)
    ).toEqual([{ en: "Slow checkout" }]);
    expect(
      await column(connection, sql`SELECT message AS v FROM incident_updates`)
    ).toEqual([{ en: "Looking into it." }]);
    expect(
      await column(connection, sql`SELECT title AS v FROM maintenance_windows`)
    ).toEqual([{ en: "Upgrade" }]);
    expect(
      await column(
        connection,
        sql`SELECT message AS v FROM maintenance_windows`
      )
    ).toEqual([{ en: "A new server." }]);
    expect(
      await column(
        connection,
        sql`SELECT customization AS v FROM status_pages ORDER BY id`
      )
    ).toEqual([
      {},
      {
        description: { en: "Our shop" },
        footerLinks: [
          { label: { en: "Help" }, url: "https://example.test/help" },
          { label: { en: "Privacy" }, url: "https://example.test/privacy" },
        ],
        labels: { operational: { en: "All good" } },
      },
    ]);
  });

  test("a stored install language that is not one, not even JSON, reads as Arabic and the migration still runs", async () => {
    const connection = await fresh();
    const applied = await migratedFrom(connection, [
      sql`INSERT INTO settings (key, value, updated_at) VALUES ('install_language', 'en', 0)`,
      sql`INSERT INTO components (id, name, description, status, created_at, updated_at) VALUES ('c1', 'الموقع', NULL, 'operational', 0, 0)`,
    ]);
    expect(applied).toHaveLength(1);
    expect(
      await column(connection, sql`SELECT name AS v FROM components`)
    ).toEqual([{ ar: "الموقع" }]);
  });

  test("with no install language stored, existing install-wide content is Arabic", async () => {
    const connection = await fresh();
    await migratedFrom(connection, [
      sql`INSERT INTO components (id, name, description, status, created_at, updated_at) VALUES ('c1', 'الموقع', NULL, 'operational', 0, 0)`,
    ]);
    expect(
      await column(connection, sql`SELECT name AS v FROM components`)
    ).toEqual([{ ar: "الموقع" }]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, scratchDatabase } from "./fixture.ts";
import { listTables, raaqebTables } from "./inspect.ts";
import { appliedMigrations, migrateDatabase, runMigrator } from "./migrate.ts";
import { localMigrations, migrationsFolder } from "./migrationfiles.ts";
import { openSqlite, snapshotDir } from "./sqlite.ts";

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

/** Runs the earlier migrations copied to `root` and checks each applied: the migrator alone, since the tables a later migration creates are rightly missing yet. */
async function migrateEarlier(
  connection: Connection,
  root: string,
  names: readonly string[]
): Promise<void> {
  await runMigrator(connection, root);
  expect(await appliedMigrations(connection)).toEqual([...names]);
}

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

  test("a later migration that fails is the one named, and the whole batch is rolled back", async () => {
    const connection = await fresh();
    // A table in the way of the probes migration, the 25th of the batch.
    await executor(connection).run(sql`CREATE TABLE probes (wrong integer)`);
    const result = await migrateDatabase(connection);
    expect(result).toEqual({
      message: `migration 20261021041150_probes failed and was rolled back; nothing of it was applied${connection.backend === "sqlite" ? ", and a snapshot was taken first" : ""}`,
      migration: "20261021041150_probes",
      ok: false,
    });
    expect(await appliedMigrations(connection)).toEqual([]);
    expect(await listTables(connection)).not.toContain("monitors");
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
      await migrateEarlier(connection, root, before);
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

describe("the domain expiring event arriving on an install that has monitors", () => {
  test("every monitor that exists when the migration runs gets the event on after its own, and one with every event off stays silent", async () => {
    const connection = await fresh();
    const earlier = await migratedUpTo(connection, "domain_registrations");
    const run = executor(connection);
    const monitor = (id: string, events?: string) =>
      run.run(
        events === undefined
          ? sql`INSERT INTO monitors (id, name, check_type, target, config, interval_ms, timeout_ms, retries, paused, created_at, updated_at) VALUES (${id}, ${id}, 'tcp', 'db.raaqeb.dev:5432', '{"host":"db.raaqeb.dev","port":5432,"type":"tcp"}', 60000, 10000, 0, 0, 0, 0)`
          : sql`INSERT INTO monitors (id, name, check_type, target, config, interval_ms, timeout_ms, retries, paused, created_at, updated_at, events) VALUES (${id}, ${id}, 'tcp', 'db.raaqeb.dev:5432', '{"host":"db.raaqeb.dev","port":5432,"type":"tcp"}', 60000, 10000, 0, 0, 0, 0, ${events})`
      );
    try {
      await monitor("all");
      await monitor("quiet", '["recovered"]');
      await monitor("none", "[]");
      expect((await migrateDatabase(connection)).ok).toBe(true);
      await monitor("new", '["down"]');
      const rows = await run.rows<{ id: string; events: string }>(
        sql`SELECT id, events FROM monitors ORDER BY id`
      );
      expect(rows.map((row) => [row.id, JSON.parse(row.events)])).toEqual([
        [
          "all",
          [
            "down",
            "recovered",
            "degraded_started",
            "degraded_ended",
            "certificate_expiring",
            "domain_expiring",
          ],
        ],
        ["new", ["down"]],
        ["none", []],
        ["quiet", ["recovered", "domain_expiring"]],
      ]);
    } finally {
      await earlier.cleanup();
    }
  });
});

describe("starts on SQLite that fail after the snapshot", () => {
  const minute = 60_000;
  const at = Date.UTC(2026, 10, 22, 9, 30, 15);

  /** A database at the next-to-last migration, with a folder of every migration whose last one fails, and a start that opens, migrates and closes it as a boot does. */
  async function upgradeThatFails() {
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    const file = `${dir}/raaqeb.sqlite`;
    const local = await localMigrations("sqlite");
    const last = local.at(-1) ?? "";
    await Promise.all(
      local.map(async (name) => {
        const text = await Bun.file(
          `${migrationsFolder("sqlite")}/${name}/migration.sql`
        ).text();
        if (name !== last) {
          await Bun.write(`${dir}/earlier/sqlite/${name}/migration.sql`, text);
        }
        await Bun.write(
          `${dir}/broken/sqlite/${name}/migration.sql`,
          name === last
            ? `${text}\n--> statement-breakpoint\nSELECT * FROM no_such_table;`
            : text
        );
      })
    );
    const earlier = openSqlite(file);
    await runMigrator(earlier, `${dir}/earlier`);
    await closeConnection(earlier);
    const failure = `migration ${last} failed and was rolled back; nothing of it was applied, and a snapshot was taken first`;
    return {
      cleanup: () => Bun.$`rm -rf ${dir}`.quiet(),
      failure,
      file,
      last,
      /** The snapshot files, by name. */
      kept: async () =>
        (
          await Array.fromAsync(
            new Bun.Glob("*").scan({ cwd: snapshotDir(file) })
          )
        ).toSorted(),
      start: async (now: number) => {
        const connection = openSqlite(file);
        try {
          const result = await migrateDatabase(connection, {
            migrations: `${dir}/broken`,
            now: () => now,
          });
          return result.ok ? "migrated" : result.message;
        } finally {
          await closeConnection(connection);
        }
      },
      /** A write between two starts, as the older release running in between would make. */
      write: async () => {
        const connection = openSqlite(file);
        await executor(connection).run(sql`CREATE TABLE note (n integer)`);
        await closeConnection(connection);
      },
    };
  }

  test("a start in the same second after the data changed goes on to the migration, and the snapshot holds the newer data", async () => {
    const upgrade = await upgradeThatFails();
    try {
      expect(await upgrade.start(at)).toBe(upgrade.failure);
      await upgrade.write();
      expect(await upgrade.start(at)).toBe(upgrade.failure);
      const kept = await upgrade.kept();
      expect(kept).toHaveLength(1);
      const copy = openSqlite(`${snapshotDir(upgrade.file)}/${kept[0]}`);
      const tables = await listTables(copy);
      await closeConnection(copy);
      expect(tables).toContain("note");
    } finally {
      await upgrade.cleanup();
    }
  });

  test("a crash loop takes a copy at every start and keeps the newest three", async () => {
    const upgrade = await upgradeThatFails();
    try {
      for (const now of [at, at + minute, at + 2 * minute, at + 3 * minute]) {
        // biome-ignore lint/performance/noAwaitInLoops: one start after another
        expect(await upgrade.start(now)).toBe(upgrade.failure);
      }
      expect(await upgrade.kept()).toEqual(
        ["093115", "093215", "093315"].map(
          (time) => `raaqeb-20261122T${time}Z-before-${upgrade.last}.sqlite`
        )
      );
    } finally {
      await upgrade.cleanup();
    }
  });

  test("a copy a killed or full-disk start left half written is removed by the next start", async () => {
    const upgrade = await upgradeThatFails();
    try {
      await upgrade.start(at);
      const [first = ""] = await upgrade.kept();
      const cut = `${snapshotDir(upgrade.file)}/raaqeb-20261122T090000Z-before-${upgrade.last}.sqlite.partial`;
      await Bun.write(cut, "cut short");
      await Bun.write(`${cut}-journal`, "cut short");
      expect(await upgrade.start(at + minute)).toBe(upgrade.failure);
      const kept = await upgrade.kept();
      expect(kept).toHaveLength(2);
      expect(kept[0]).toBe(first);
      expect(kept.every((name) => name.endsWith(".sqlite"))).toBe(true);
    } finally {
      await upgrade.cleanup();
    }
  });

  test("a start whose clock is behind the snapshots already taken keeps its own", async () => {
    const upgrade = await upgradeThatFails();
    try {
      for (const now of [at, at + minute, at + 2 * minute]) {
        // biome-ignore lint/performance/noAwaitInLoops: one start after another
        await upgrade.start(now);
      }
      await upgrade.write();
      expect(await upgrade.start(at - 60 * minute)).toBe(upgrade.failure);
      const kept = await upgrade.kept();
      // The three newest by name, and the one just taken until the next start prunes it.
      expect(kept).toHaveLength(4);
      const behind = `raaqeb-20261122T083015Z-before-${upgrade.last}.sqlite`;
      expect(kept).toContain(behind);
      const copy = openSqlite(`${snapshotDir(upgrade.file)}/${behind}`);
      const tables = await listTables(copy);
      await closeConnection(copy);
      expect(tables).toContain("note");
    } finally {
      await upgrade.cleanup();
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
      await migrateEarlier(connection, root, local.slice(0, at));
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
    expect(applied[0]).toEndWith("_bilingual_content");
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
    expect(applied[0]).toEndWith("_bilingual_content");
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

/** A database migrated up to the one before the named migration, in a folder of its own, and the rest of the run. */
async function migratedUpTo(
  connection: Connection,
  migration: string
): Promise<{ readonly cleanup: () => Promise<void> }> {
  const root = (await Bun.$`mktemp -d`.text()).trim();
  const local = await localMigrations(connection.backend);
  const earlier = local.slice(
    0,
    local.findIndex((name) => name.endsWith(`_${migration}`))
  );
  await Promise.all(
    earlier.map((name) =>
      Bun.write(
        `${root}/${connection.backend}/${name}/migration.sql`,
        Bun.file(
          `${migrationsFolder(connection.backend)}/${name}/migration.sql`
        )
      )
    )
  );
  await migrateEarlier(connection, root, earlier);
  return { cleanup: () => Bun.$`rm -rf ${root}`.quiet().then(() => undefined) };
}

describe("operator accounts arriving on an install that has its operator", () => {
  test("the operator becomes the owner with their own preferences and test message, and keeps no constant name", async () => {
    const connection = await fresh();
    const earlier = await migratedUpTo(connection, "operator_accounts");
    const run = executor(connection);
    const setting = (key: string, value: unknown) =>
      run.run(
        sql`INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${JSON.stringify(value)}, 0)`
      );
    try {
      await run.run(
        sql`INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES ('op', 'operator', 'operator@example.com', 1, 0, 0)`
      );
      await setting("operator_language", "en");
      await setting("operator_time_zone", "Asia/Riyadh");
      await setting("operator_clock", "24h");
      await setting("operator_calendar", "hijri");
      await setting("auth_email_tested", {
        channelId: "c1",
        email: "operator@example.com",
        updatedAt: 5,
      });
      await setting("install_language", "ar");
      expect((await migrateDatabase(connection)).ok).toBe(true);
      const [account] = await run.rows<Record<string, unknown>>(
        sql`SELECT name, role, language, time_zone, clock, calendar, deactivated_at FROM auth_user`
      );
      expect(account).toEqual({
        calendar: "hijri",
        clock: "24h",
        deactivated_at: null,
        language: "en",
        name: "",
        role: "owner",
        time_zone: "Asia/Riyadh",
      });
      const keys = await run.rows<{ key: string }>(
        sql`SELECT key FROM settings ORDER BY key`
      );
      expect(keys.map((row) => row.key)).toEqual([
        "auth_email_tested:op",
        "install_language",
      ]);
    } finally {
      await earlier.cleanup();
    }
  });

  test("an operator who kept the install's preferences keeps following them", async () => {
    const connection = await fresh();
    const earlier = await migratedUpTo(connection, "operator_accounts");
    const run = executor(connection);
    try {
      await run.run(
        sql`INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES ('op', 'operator', 'operator@example.com', 1, 0, 0)`
      );
      expect((await migrateDatabase(connection)).ok).toBe(true);
      const [account] = await run.rows<Record<string, unknown>>(
        sql`SELECT role, language, time_zone, clock, calendar FROM auth_user`
      );
      expect(account).toEqual({
        calendar: null,
        clock: null,
        language: null,
        role: "owner",
        time_zone: null,
      });
    } finally {
      await earlier.cleanup();
    }
  });

  test("an install still in onboarding keeps no test message", async () => {
    const connection = await fresh();
    const earlier = await migratedUpTo(connection, "operator_accounts");
    const run = executor(connection);
    try {
      await run.run(
        sql`INSERT INTO settings (key, value, updated_at) VALUES ('auth_email_tested', '{}', 0)`
      );
      expect((await migrateDatabase(connection)).ok).toBe(true);
      const keys = await run.rows<{ key: string }>(
        sql`SELECT key FROM settings`
      );
      expect(keys).toEqual([]);
    } finally {
      await earlier.cleanup();
    }
  });
});

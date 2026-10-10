import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { closeConnection, executor } from "./connection.ts";
import { connectTo, fixtureBackend, scratchDatabase } from "./fixture.ts";
import { appliedMigrations } from "./migrate.ts";
import { localMigrations, migrationsFolder } from "./migrationfiles.ts";
import { defineSetting } from "./settings.ts";
import { sqliteFileName } from "./sqlite.ts";
import {
  type DatabaseLocation,
  databaseOpener,
  locateDatabase,
  openStorage,
  type Storage,
} from "./storage.ts";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => Bun.$`rm -rf ${dir}`.quiet()));
});

async function scratchDir(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  tempDirs.push(dir);
  return dir;
}

const cleanups: (() => Promise<void>)[] = [];
const opened: Storage[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((storage) => storage.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** An empty database for one test, cleaned up after it. */
async function scratch(): Promise<DatabaseLocation> {
  const database = await scratchDatabase();
  cleanups.push(database.cleanup);
  return database.location;
}

/** Opens storage on the location and keeps it for closing after the test. */
async function openOn(
  location: DatabaseLocation
): Promise<Awaited<ReturnType<typeof openStorage>>> {
  const result = await openStorage(location, { connectWindowMs: 5000 });
  if (result.ok) {
    opened.push(result.storage);
  }
  return result;
}

/** Runs statements by hand on a location before storage opens. */
async function prepare(
  location: DatabaseLocation,
  statements: ReturnType<typeof sql>[]
): Promise<void> {
  const connection = await connectTo(location);
  const run = executor(connection);
  for (const statement of statements) {
    // biome-ignore lint/performance/noAwaitInLoops: a statement may depend on the one before it
    await run.run(statement);
  }
  await closeConnection(connection);
}

describe("where the database is", () => {
  test("a URL names Postgres", async () => {
    expect(
      await locateDatabase({
        databaseUrl: "postgres://u:p@h/d",
        dataDir: "/nowhere",
      })
    ).toEqual({ backend: "postgres", url: "postgres://u:p@h/d" });
  });

  test("without a URL, the default file counts only when it already exists", async () => {
    const dataDir = await scratchDir();
    expect(await locateDatabase({ databaseUrl: undefined, dataDir })).toBe(
      undefined
    );
    await Bun.write(`${dataDir}/${sqliteFileName}`, "");
    expect(await locateDatabase({ databaseUrl: undefined, dataDir })).toEqual({
      backend: "sqlite",
      file: `${dataDir}/${sqliteFileName}`,
    });
  });
});

describe("opening storage", () => {
  test("an empty database is migrated and the storage answers", async () => {
    const result = await openOn(await scratch());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.storage.backend).toBe(fixtureBackend());
      expect(result.notes).toContain(
        `database is empty; created it at version ${(await localMigrations(fixtureBackend())).length}`
      );
      expect(await result.storage.changeCounter()).toBe(0);
      expect(await result.storage.bump()).toBe(1);
      const language = defineSetting("install_language", z.string());
      await result.storage.settings.set(language, "ar");
      expect(await result.storage.settings.get(language)).toBe("ar");
    }
  });

  test("a Raaqeb database is adopted and the version noted", async () => {
    const location = await scratch();
    const first = await openOn(location);
    if (!first.ok) {
      throw new Error(first.message);
    }
    await first.storage.bump();
    await first.storage.close();
    const again = await openOn(location);
    expect(again.ok).toBe(true);
    if (again.ok) {
      const version = (await localMigrations(fixtureBackend())).length;
      expect(again.notes).toContain(
        `database is Raaqeb at version ${version}; nothing to migrate`
      );
      expect(await again.storage.changeCounter()).toBe(1);
    }
  });

  test("a Raaqeb database behind this raaqeb is migrated forward and the versions noted", async () => {
    const location = await scratch();
    // The record as the migrator creates it: its id fills itself on both dialects.
    const id = location.backend === "postgres" ? "serial" : "integer";
    await prepare(location, [
      sql.raw(
        `CREATE TABLE __drizzle_migrations (id ${id} PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at text)`
      ),
    ]);
    const result = await openOn(location);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const version = (await localMigrations(fixtureBackend())).length;
      expect(result.notes).toContain(
        `database is Raaqeb at version 0; migrated forward by ${version} to ${version}`
      );
      expect(await result.storage.changeCounter()).toBe(0);
    }
  });

  test("foreign tables are left alone and said so", async () => {
    const location = await scratch();
    await prepare(location, [
      sql`CREATE TABLE customers (id integer PRIMARY KEY)`,
      sql`INSERT INTO customers (id) VALUES (7)`,
    ]);
    const result = await openOn(location);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notes).toContain(
        "database holds 1 table that is not Raaqeb's; Raaqeb creates and touches only its own"
      );
    }
    const connection = await connectTo(location);
    expect(
      await executor(connection).rows<{ id: number }>(
        sql`SELECT id FROM customers`
      )
    ).toEqual([{ id: 7 }]);
    await closeConnection(connection);
  });

  test("Raaqeb tables with no migration record are refused", async () => {
    const location = await scratch();
    await prepare(location, [
      sql`CREATE TABLE settings (key text PRIMARY KEY)`,
    ]);
    expect(await openOn(location)).toEqual({
      message:
        "database holds Raaqeb tables but no migration record; refusing to touch it (restore a backup made by Raaqeb, or point DATABASE_URL at an empty database)",
      ok: false,
    });
  });

  test("a database written by a newer Raaqeb is refused", async () => {
    const location = await scratch();
    await prepare(location, [
      sql`CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL, updated_at integer NOT NULL)`,
      sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at text)`,
      sql`INSERT INTO __drizzle_migrations (id, hash, created_at, name) VALUES (1, 'x', 0, '20260101000000_a'), (2, 'x', 0, '20260102000000_b'), (3, 'x', 0, '20260103000000_c'), (4, 'x', 0, '20260104000000_d')`,
    ]);
    expect(await openOn(location)).toEqual({
      message:
        "database is Raaqeb at version 4, newer than this raaqeb knows; upgrade raaqeb instead",
      ok: false,
    });
  });

  test("another application's database is refused without advice to upgrade", async () => {
    const location = await scratch();
    await prepare(location, [
      sql`CREATE TABLE customers (id integer PRIMARY KEY)`,
      sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at text)`,
      sql`INSERT INTO __drizzle_migrations (id, hash, created_at, name) VALUES (1, 'x', 0, '0001_other_app')`,
    ]);
    expect(await openOn(location)).toEqual({
      message:
        "database holds another application's migration record; Raaqeb cannot share it (point DATABASE_URL at an empty database)",
      ok: false,
    });
  });

  test("an unreachable Postgres is refused naming the failure, never the URL", async () => {
    const url = "postgres://raaqeb:SECRET_PASSWORD@127.0.0.1:1/raaqeb";
    const result = await openStorage(
      { backend: "postgres", url },
      { connectWindowMs: 200 }
    );
    expect(result).toEqual({
      message: `cannot connect to Postgres: connection refused (DATABASE_URL, ${url.length} characters)`,
      ok: false,
    });
  });

  test("a SQLite file that cannot be opened is refused naming the data directory's length", async () => {
    const dataDir = "/nonexistent/raaqeb";
    const file = `${dataDir}/${sqliteFileName}`;
    expect(await openStorage({ backend: "sqlite", file })).toEqual({
      message: `cannot open the SQLite file (RAAQEB_DATA_DIR, ${dataDir.length} characters)`,
      ok: false,
    });
  });
});

/** A migrations root, as a build carries it, holding the first `count` migrations of each dialect. */
async function carried(count: number): Promise<string> {
  const root = await scratchDir();
  await Promise.all(
    (["sqlite", "postgres"] as const).map(async (backend) => {
      const names = (await localMigrations(backend)).slice(0, count);
      await Promise.all(
        names.map((name) =>
          Bun.write(
            `${root}/${backend}/${name}/migration.sql`,
            Bun.file(`${migrationsFolder(backend)}/${name}/migration.sql`)
          )
        )
      );
    })
  );
  return root;
}

describe("the migrations a build carries", () => {
  test("storage migrates with the folder it is given, not the source tree's", async () => {
    const location = await scratch();
    const [first] = await localMigrations(location.backend);
    const result = await openStorage(location, {
      connectWindowMs: 5000,
      migrations: await carried(1),
    });
    if (result.ok) {
      opened.push(result.storage);
    }
    // One migration makes none of the later tables, so the check after the run refuses it.
    expect(result.ok).toBe(false);
    const connection = await connectTo(location);
    expect(await appliedMigrations(connection)).toEqual([first ?? ""]);
    await closeConnection(connection);
  });

  test("a database migrated past the folder given is refused as newer", async () => {
    const location = await scratch();
    const all = await openOn(location);
    if (all.ok) {
      await all.storage.close();
      opened.splice(0);
    }
    const version = (await localMigrations(location.backend)).length;
    const result = await openStorage(location, {
      connectWindowMs: 5000,
      migrations: await carried(1),
    });
    if (result.ok) {
      opened.push(result.storage);
    }
    expect(result).toEqual({
      message: `database is Raaqeb at version ${version}, newer than this raaqeb knows; upgrade raaqeb instead`,
      ok: false,
    });
  });

  test("a folder carrying every migration opens storage as the source tree's does", async () => {
    const location = await scratch();
    const count = (await localMigrations(location.backend)).length;
    const result = await openStorage(location, {
      connectWindowMs: 5000,
      migrations: await carried(count),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      opened.push(result.storage);
    }
  });

  test.if(fixtureBackend() === "postgres")(
    "the onboarding connection test reads the folder the opener was given",
    async () => {
      const location = await scratch();
      const all = await openOn(location);
      if (all.ok) {
        await all.storage.close();
        opened.splice(0);
      }
      const opener = databaseOpener(() => undefined, {
        migrations: await carried(1),
      });
      const url = location.backend === "postgres" ? location.url : "";
      expect(await opener.test(url, { windowMs: 5000 })).toEqual({
        kind: "newer",
        version: (await localMigrations("postgres")).length,
      });
    }
  );
});

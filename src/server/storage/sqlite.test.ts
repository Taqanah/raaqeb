import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeConnection, executor } from "./connection.ts";
import {
  openSqlite,
  snapshotDir,
  snapshotSqlite,
  snapshotsKept,
  sqliteFileName,
} from "./sqlite.ts";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => Bun.$`rm -rf ${dir}`.quiet()));
});

async function scratchFile(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  tempDirs.push(dir);
  return `${dir}/${sqliteFileName}`;
}

async function pragma(file: string, name: string): Promise<unknown> {
  const connection = openSqlite(file);
  try {
    const rows = await executor(connection).rows<Record<string, unknown>>(
      sql.raw(`PRAGMA ${name}`)
    );
    return Object.values(rows[0] ?? {})[0];
  } finally {
    await closeConnection(connection);
  }
}

describe("the default SQLite file", () => {
  test("runs in write-ahead log mode with the log capped at 4 MB", async () => {
    const file = await scratchFile();
    expect(await pragma(file, "journal_mode")).toBe("wal");
    expect(await pragma(file, "journal_size_limit")).toBe(4 * 1024 * 1024);
  });

  test("runs with incremental vacuum so deleted history returns space", async () => {
    const file = await scratchFile();
    // 2 is INCREMENTAL; it must be set before the first table exists.
    expect(await pragma(file, "auto_vacuum")).toBe(2);
  });

  test("enforces foreign keys", async () => {
    const file = await scratchFile();
    expect(await pragma(file, "foreign_keys")).toBe(1);
  });

  test("opening it beside a running server waits for the server's write instead of failing as locked", async () => {
    const file = await scratchFile();
    const first = openSqlite(file);
    first.client.run("CREATE TABLE probe (n integer)");
    first.client.close();
    // Another process holds a write transaction for 300 ms, as the server does mid-write.
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `const { Database } = require("bun:sqlite");
const db = new Database(${JSON.stringify(file)});
db.run("BEGIN IMMEDIATE");
db.run("INSERT INTO probe VALUES (1)");
console.log("held");
Bun.sleepSync(300);
db.run("COMMIT");`,
      ],
      { stdout: "pipe" }
    );
    const reader = holder.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    const second = openSqlite(file);
    const rows = second.client.query("SELECT n FROM probe").all();
    second.client.close();
    expect(await holder.exited).toBe(0);
    expect(rows).toEqual([{ n: 1 }]);
  });

  test("a file that is not a database cannot be opened", async () => {
    const file = await scratchFile();
    await Bun.write(file, "not a database");
    expect(() => openSqlite(file)).toThrow();
  });
});

describe("the pre-upgrade snapshot", () => {
  test("lives under snapshots/ beside the file", () => {
    expect(snapshotDir("/var/lib/raaqeb/raaqeb.sqlite")).toBe(
      "/var/lib/raaqeb/snapshots"
    );
  });

  test("is a readable copy named by the UTC time and the pending migration", async () => {
    const file = await scratchFile();
    const connection = openSqlite(file);
    const run = executor(connection);
    await run.run(sql`CREATE TABLE probe (n integer)`);
    await run.run(sql`INSERT INTO probe VALUES (7)`);
    const now = Date.UTC(2026, 8, 15, 10, 20, 30);
    const path = await snapshotSqlite(connection, "20260915100034_init", now);
    await closeConnection(connection);
    expect(path).toBe(
      `${snapshotDir(file)}/raaqeb-20260915T102030Z-before-20260915100034_init.sqlite`
    );
    const copy = openSqlite(path);
    const rows = await executor(copy).rows<{ n: number }>(
      sql`SELECT n FROM probe`
    );
    await closeConnection(copy);
    expect(rows).toEqual([{ n: 7 }]);
  });

  test("keeps only the newest three", async () => {
    const file = await scratchFile();
    const connection = openSqlite(file);
    const base = Date.UTC(2026, 8, 15);
    await Promise.all(
      Array.from({ length: snapshotsKept + 2 }, (_, i) =>
        snapshotSqlite(connection, `m${i}`, base + i * 60_000)
      )
    );
    await closeConnection(connection);
    const kept = (
      await Array.fromAsync(new Bun.Glob("*").scan({ cwd: snapshotDir(file) }))
    ).toSorted();
    expect(kept).toEqual([
      "raaqeb-20260915T000200Z-before-m2.sqlite",
      "raaqeb-20260915T000300Z-before-m3.sqlite",
      "raaqeb-20260915T000400Z-before-m4.sqlite",
    ]);
  });

  test("prunes by time, not by migration name, and leaves other files alone", async () => {
    const file = await scratchFile();
    const connection = openSqlite(file);
    const dir = snapshotDir(file);
    await Bun.write(`${dir}/operator-backup.sqlite`, "");
    await Bun.write(`${dir}/notes.txt`, "");
    const base = Date.UTC(2026, 8, 15);
    // Names sort the other way round from time.
    for (const [i, label] of ["z", "y", "x", "w"].entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one boot after another
      await snapshotSqlite(connection, label, base + i * 60_000);
    }
    await closeConnection(connection);
    const kept = (
      await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir }))
    ).toSorted();
    expect(kept).toEqual([
      "notes.txt",
      "operator-backup.sqlite",
      "raaqeb-20260915T000100Z-before-y.sqlite",
      "raaqeb-20260915T000200Z-before-x.sqlite",
      "raaqeb-20260915T000300Z-before-w.sqlite",
    ]);
  });
});

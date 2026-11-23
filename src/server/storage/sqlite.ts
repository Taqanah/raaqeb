/**
 * The SQLite backend: the default profile, one file in
 * the data directory with its write-ahead log beside it, and a snapshot of
 * that file under `snapshots/` before pending migrations run.
 */
import { constants, Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SqliteConnection } from "./connection.ts";

/** The database file's name inside the data directory. */
export const sqliteFileName = "raaqeb.sqlite";

/** How many pre-upgrade snapshots stay on disk; older ones are pruned. */
export const snapshotsKept = 3;

const snapshotPrefix = "raaqeb-";
const snapshotSuffix = ".sqlite";
const walLimitBytes = 4 * 1024 * 1024;

/**
 * Opens (creating when missing) the file in WAL mode with incremental vacuum,
 * a 4 MB write-ahead log cap and foreign keys on. Throws when the file cannot
 * be opened; the caller turns that into a refused boot.
 */
export function openSqlite(file: string): SqliteConnection {
  // Bun creates a missing file whatever `create` says; strict mode is the one option that matters.
  const client = new Database(file, { strict: true });
  // First: the auto_vacuum pragma takes the write lock, so it must wait out a running server's write.
  client.run("PRAGMA busy_timeout = 5000");
  // Incremental vacuum only takes on a file with no tables yet.
  client.run("PRAGMA auto_vacuum = INCREMENTAL");
  client.run("PRAGMA journal_mode = WAL");
  // macOS lends Bun its own SQLite, built to keep the -wal and -shm files after the last close; off, as Bun's own build on Linux and Windows.
  client.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  client.run(`PRAGMA journal_size_limit = ${walLimitBytes}`);
  client.run("PRAGMA synchronous = NORMAL");
  client.run("PRAGMA foreign_keys = ON");
  return { backend: "sqlite", client, db: drizzle({ client }), file };
}

/**
 * Copies the database with `VACUUM INTO` to `<dir>/snapshots/` beside the
 * file, named by the UTC time and the first pending migration, then prunes to
 * `snapshotsKept`, never the copy just taken. Answers the snapshot's path.
 * The copy is written under a temporary name and renamed, so a start cut
 * short leaves no half copy under a snapshot's name, and a second start in
 * the same second replaces the first one's. What a start cut short left is
 * removed once per start by `removePartialSnapshots`, never here, so snapshots
 * taken at once do not delete each other's copy in progress.
 */
export function snapshotSqlite(
  connection: SqliteConnection,
  label: string,
  now: number
): Promise<string> {
  const run = lastSnapshot.then(() => takeSnapshot(connection, label, now));
  lastSnapshot = run.catch(() => undefined);
  return run;
}

// One at a time: a copy kept for being the one just taken must not outlive the pruning of a later one at once beside it.
let lastSnapshot: Promise<unknown> = Promise.resolve();

async function takeSnapshot(
  connection: SqliteConnection,
  label: string,
  now: number
): Promise<string> {
  const dir = snapshotDir(connection.file);
  await Bun.$`mkdir -p ${dir}`.quiet();
  const stamp = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const name = `${snapshotPrefix}${stamp}-before-${label}${snapshotSuffix}`;
  connection.client.run("VACUUM INTO ?", [`${dir}/${name}.partial`]);
  await Bun.$`mv -f ${`${dir}/${name}.partial`} ${`${dir}/${name}`}`.quiet();
  await prune(dir, name);
  return `${dir}/${name}`;
}

/** Removes what a start killed or out of disk mid-copy left; on a full disk it holds the space the next copy needs. */
export async function removePartialSnapshots(file: string): Promise<void> {
  const dir = snapshotDir(file);
  await Bun.$`mkdir -p ${dir}`.quiet();
  await removeAll(
    dir,
    await Array.fromAsync(new Bun.Glob("*.partial*").scan({ cwd: dir }))
  );
}

/** The snapshot folder for a database file. */
export function snapshotDir(file: string): string {
  const slash = file.lastIndexOf("/");
  return `${slash === -1 ? "." : file.slice(0, slash)}/snapshots`;
}

/** Deletes every snapshot but the newest `snapshotsKept` and the one just `taken`, which a clock set back sorts oldest; names sort by time. */
async function prune(dir: string, taken: string): Promise<void> {
  const names = (
    await Array.fromAsync(
      new Bun.Glob(`${snapshotPrefix}*${snapshotSuffix}`).scan({ cwd: dir })
    )
  ).toSorted((a, b) => a.localeCompare(b));
  await removeAll(
    dir,
    names
      .slice(0, Math.max(0, names.length - snapshotsKept))
      .filter((name) => name !== taken)
  );
}

/** Deletes the named files; two starts at once delete at once, and a file already gone is fine. */
async function removeAll(dir: string, names: string[]): Promise<void> {
  await Promise.all(
    names.map((name) =>
      Bun.file(`${dir}/${name}`)
        .delete()
        .catch(() => undefined)
    )
  );
}

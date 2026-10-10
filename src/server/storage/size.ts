/**
 * The database's size and the disk under it (CONTEXT.md "Size budget"): the used size the size budget is checked against,
 * the free disk the SQLite reserve is checked against, and giving freed
 * space back after a delete. Used size is what a delete lowers at once:
 * SQLite's pages in use, not the file, whose freed pages stay until a
 * vacuum; Postgres's own tables with their indexes and TOAST, not the
 * database, which may hold another application's tables.
 */
// biome-ignore lint/style/noRestrictedImports: Bun has no statfs; the free disk under the SQLite file needs one
import { statfs } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { Connection, Executor } from "./connection.ts";
import { raaqebTables } from "./inspect.ts";

export interface DatabaseSize {
  /** The free bytes of the file system holding the SQLite file, as an unprivileged process may use them; nothing on Postgres, which gives no such signal. */
  free: () => Promise<number | undefined>;
  /** Gives freed space back: on SQLite an incremental vacuum and then a truncating checkpoint, so the file shrinks on disk; on Postgres a plain VACUUM of the history tables, which makes the space reusable inside the files only. */
  reclaim: () => Promise<void>;
  /** Raaqeb's used size in bytes: SQLite's pages in use, `(page_count - freelist_count) * page_size`; the sum of `pg_total_relation_size` over Raaqeb's own tables on Postgres. */
  used: () => Promise<number>;
}

/** Reads the free bytes of the file system holding a directory; the storage fixture replaces it with a nearly full one. */
export type FreeBytesReader = (directory: string) => Promise<number>;

/** The free bytes an unprivileged process may use, from `statfs`. */
export async function statfsFreeBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return stats.bavail * stats.bsize;
}

/** The size of the open database; `run` is the storage's own executor, so giving space back queues behind its transactions. */
export function databaseSize(
  connection: Connection,
  run: Executor,
  freeBytes: FreeBytesReader = statfsFreeBytes
): DatabaseSize {
  if (connection.backend === "sqlite") {
    const { client, file } = connection;
    const usedPages = client.query<{ bytes: number }, []>(
      "SELECT (count.page_count - free.freelist_count) * size.page_size AS bytes FROM pragma_page_count() AS count, pragma_freelist_count() AS free, pragma_page_size() AS size"
    );
    const slash = file.lastIndexOf("/");
    const directory = slash === -1 ? "." : file.slice(0, slash);
    return {
      free: () => freeBytes(directory),
      // A checkpoint inside an open transaction throws "database table is locked", so it waits its turn in the queue.
      reclaim: () =>
        run.exclusive(() => {
          // The vacuum moves the free pages to the end and cuts them off; the checkpoint writes that into the file.
          client.run("PRAGMA incremental_vacuum");
          client.run("PRAGMA wal_checkpoint(TRUNCATE)");
        }),
      // Async, so a failing pragma rejects rather than throws.
      used: async () => usedPages.get()?.bytes ?? 0,
    };
  }
  const {
    captures,
    checks,
    dailyRollups,
    failureDetails,
    hourlyRollups,
    sealedDays,
  } = run.tables;
  const names = sql.join(
    raaqebTables.map((name) => sql`${name}`),
    sql`, `
  );
  return {
    free: () => Promise.resolve(undefined),
    reclaim: async () => {
      await run.run(
        sql`VACUUM ${checks}, ${sealedDays}, ${hourlyRollups}, ${dailyRollups}, ${failureDetails}, ${captures}`
      );
    },
    used: async () => {
      const [row] = await run.rows<{ bytes: number }>(
        sql`SELECT CAST(COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS BIGINT) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN (${names})`
      );
      return Number(row?.bytes ?? 0);
    },
  };
}

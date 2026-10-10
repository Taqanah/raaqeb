/**
 * The migrations this binary carries: one folder per dialect, each
 * migration a drizzle-kit folder holding `migration.sql`. The source tree
 * keeps them under `migrations/` beside this module; a build carries a copy
 * under `dist/migrations`, which the entry names, since a bundled
 * chunk's `import.meta.dir` is not this folder. The
 * connection test and the migrator both read the list from here.
 */
import type { Backend } from "./connection.ts";

/** The source tree's migrations, one folder per dialect; what tests and a run without a build read. */
export const sourceMigrations = `${import.meta.dir}/migrations`;

/** The migrations folder for a backend under a root holding one folder per dialect. */
export function migrationsFolder(
  backend: Backend,
  root: string = sourceMigrations
): string {
  return `${root}/${backend}`;
}

/** The names of the migrations under the root, in order. */
export async function localMigrations(
  backend: Backend,
  root: string = sourceMigrations
): Promise<string[]> {
  const files = await Array.fromAsync(
    new Bun.Glob("*/migration.sql").scan({
      cwd: migrationsFolder(backend, root),
    })
  );
  // Cut by length, not at a "/": Windows answers `<name>\migration.sql`.
  return files
    .map((file) => file.slice(0, -"/migration.sql".length))
    .toSorted((a, b) => a.localeCompare(b));
}

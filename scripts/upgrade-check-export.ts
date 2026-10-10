/**
 * What `bun run upgrade:check` reads of two exports and two logs: every
 * moment of a seed moved to the present, the differences between the export
 * the old version wrote and the one the new version wrote, and whether the
 * migrations ran once. Pure; the containers are the check's own.
 */
import { z } from "zod";

/** One line of an export file, parsed. */
export type ExportLine = Record<string, unknown>;

const objectSchema = z.record(z.string(), z.unknown());
const rowsSchema = z.array(objectSchema);

const moment = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

function shifted(value: unknown, deltaMs: number): unknown {
  if (typeof value === "string" && moment.test(value)) {
    return new Date(Date.parse(value) + deltaMs).toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((each) => shifted(each, deltaMs));
  }
  const fields = objectSchema.safeParse(value);
  return fields.success
    ? Object.fromEntries(
        Object.entries(fields.data).map(([key, each]) => [
          key,
          shifted(each, deltaMs),
        ])
      )
    : value;
}

/** The lines with every moment (ISO 8601 text) moved by `deltaMs`; other text and numbers stay as they are. */
export function shiftTimes(
  lines: readonly ExportLine[],
  deltaMs: number
): ExportLine[] {
  return lines.map((line) => objectSchema.parse(shifted(line, deltaMs)));
}

/** The fields whose values differ between two rows, sorted. */
function changedFields(
  was: Record<string, unknown>,
  is: Record<string, unknown>
): string[] {
  return [...new Set([...Object.keys(was), ...Object.keys(is)])]
    .filter((field) => JSON.stringify(was[field]) !== JSON.stringify(is[field]))
    .toSorted((a, b) => a.localeCompare(b));
}

/** A text longer than this is a body or a ciphertext, too long to name a row by. */
const nameLength = 80;

/** A row of a configuration table: by its id or key, else by what it holds short of a long text. */
function rowName(row: Record<string, unknown>): string {
  const { id, key } = row;
  if (typeof id === "string") {
    return id;
  }
  if (typeof key === "string") {
    return key;
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(row).filter(
        ([, value]) => typeof value !== "string" || value.length <= nameLength
      )
    )
  );
}

/** A record of history: by its monitor and the moment it began. */
function recordName(row: Record<string, unknown>): string {
  return `${String(row.monitor)} ${String(row.at ?? row.startedAt)}`;
}

/** The rows of an export by table: the header's configuration tables, then the history by kind. */
function tablesOf(
  lines: readonly ExportLine[]
): Map<string, Map<string, Record<string, unknown>>> {
  const [header, ...history] = lines;
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const configuration = z
    .record(z.string(), rowsSchema)
    .catch({})
    .parse(objectSchema.catch({}).parse(header).configuration);
  for (const [table, rows] of Object.entries(configuration)) {
    tables.set(table, new Map(rows.map((row) => [rowName(row), row])));
  }
  for (const line of history) {
    const kind = String(line.kind);
    const rows = tables.get(kind) ?? new Map();
    rows.set(recordName(line), line);
    tables.set(kind, rows);
  }
  return tables;
}

/** The header's fields but the configuration and the time of the export, which differ by design. */
function headerOf(lines: readonly ExportLine[]): Record<string, unknown> {
  const { configuration, exportedAt, ...rest } = objectSchema
    .catch({})
    .parse(lines[0]);
  return rest;
}

/**
 * What differs between the export the old version wrote and the one the new
 * version wrote of the same install, one sentence each, naming the table or
 * the kind of history and the row, and for a changed row the fields that
 * differ, never their values (credentials are in clear in the file). Order
 * does not matter, and neither does when the export was made.
 */
export function differences(
  before: readonly ExportLine[],
  after: readonly ExportLine[]
): string[] {
  const found: string[] = [];
  const header = changedFields(headerOf(before), headerOf(after));
  if (header.length > 0) {
    found.push(`the header's ${header.join(", ")} changed`);
  }
  const was = tablesOf(before);
  const is = tablesOf(after);
  for (const table of new Set([...was.keys(), ...is.keys()])) {
    const rowsWas = was.get(table) ?? new Map();
    const rowsIs = is.get(table) ?? new Map();
    for (const [name, row] of rowsWas) {
      const now = rowsIs.get(name);
      if (now === undefined) {
        found.push(`${table} ${name} is missing after the upgrade`);
        continue;
      }
      const fields = changedFields(row, now);
      if (fields.length > 0) {
        found.push(`${table} ${name} changed: ${fields.join(", ")}`);
      }
    }
    for (const name of rowsIs.keys()) {
      if (!rowsWas.has(name)) {
        found.push(`${table} ${name} appeared after the upgrade`);
      }
    }
  }
  return found;
}

/** What a start logged of the database: the version it found, how many migrations it applied, and the version it left. */
export interface MigrationNote {
  readonly applied: number;
  readonly from: number;
  readonly to: number;
}

const note =
  /database is Raaqeb at version (\d+); (?:nothing to migrate|migrated forward by (\d+) to (\d+))/;

/** The note in a start's log, or nothing when it logged none. */
export function migrationNote(log: string): MigrationNote | undefined {
  const match = note.exec(log);
  if (!match) {
    return;
  }
  const from = Number(match[1]);
  return {
    applied: Number(match[2] ?? 0),
    from,
    to: Number(match[3] ?? from),
  };
}

/** Why the two starts on one database, the new version's first and the next after it, do not show migrations that ran once. */
export function migrationProblems(first: string, next: string): string[] {
  const left = migrationNote(first);
  const again = migrationNote(next);
  const problems: string[] = [];
  if (!left) {
    problems.push("the first start logged no note on the database");
  }
  if (!again) {
    problems.push("the next start logged no note on the database");
  }
  if (left && again) {
    if (again.applied > 0) {
      problems.push(
        `the next start migrated forward by ${again.applied} again`
      );
    }
    if (again.from !== left.to) {
      problems.push(
        `the next start found version ${again.from}, where the first start left ${left.to}`
      );
    }
  }
  return problems;
}

/** How many rows each table of the export holds and how many records each kind of history, without the empty ones. */
export function inventory(
  lines: readonly ExportLine[]
): Record<string, number> {
  return Object.fromEntries(
    [...tablesOf(lines)]
      .map(([table, rows]) => [table, rows.size] as const)
      .filter(([, size]) => size > 0)
  );
}

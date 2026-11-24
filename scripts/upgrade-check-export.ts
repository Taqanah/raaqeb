/**
 * What `bun run upgrade:check` reads of two exports and two logs: every
 * moment of a seed moved to the present, the differences between the export
 * the old version wrote and the one the new version wrote, and whether the
 * migrations ran once. Pure; the containers are the check's own.
 */
import { z } from "zod";
import {
  fromVersion1,
  headerSchema,
  recordSchema,
} from "@/shared/schemas/export.ts";
import { confirmationLifetimeMs } from "@/shared/schemas/subscription.ts";

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

/** The rows of an export by table: the header's configuration tables with the page image lines, then the history by kind. */
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
    if (line.kind === "image") {
      // A page image's line replaced its row in the header, so it compares as that row.
      const { body, contentType, hash, image, page, updatedAt } = line;
      const row = {
        pageId: page,
        kind: image,
        contentType,
        body,
        hash,
        updatedAt,
      };
      const rows = tables.get("pageImages") ?? new Map();
      rows.set(rowName(row), row);
      tables.set("pageImages", rows);
      continue;
    }
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

/** A value as JSON carries it, so an encoded line compares with one read from a file. */
function asWritten(value: unknown): ExportLine {
  return objectSchema.parse(JSON.parse(JSON.stringify(value)));
}

/** The old export as the new version reads it on import: the header through `fromVersion1` and the header's schema, each record through its own, so a field a format step adds carries what an import gives it. */
function readNow(lines: readonly ExportLine[]): ExportLine[] {
  const [first, ...history] = lines;
  const header = headerSchema.safeParse(fromVersion1(first));
  if (!header.success) {
    throw new Error("the new version cannot read the old export's first line");
  }
  return [
    asWritten(headerSchema.encode(header.data)),
    ...history.map((line, index) => {
      const record = recordSchema.safeParse(line);
      if (!record.success) {
        throw new Error(
          `the new version cannot read line ${index + 2} of the old export`
        );
      }
      return asWritten(recordSchema.encode(record.data));
    }),
  ];
}

/** The differences an upgrade may make, each with its reason, and the rest. */
export interface UpgradeDifferences {
  readonly allowed: string[];
  readonly found: string[];
}

/**
 * What differs between the old version's export and the new version's of the
 * same install, once the old one is read as the new version imports it. What
 * reading adds to the old file and the format's named rewrites are allowed,
 * and so are the rows of a table the old file does not carry, the audit
 * entries made after the old export (the check's own sign-ins), and what the
 * clock did between the two exports (a window's start or end, a pending
 * subscription's expired link); each is named with its reason, as is the time
 * the new version recorded a row reading adds.
 * What reading loses of the old file, and anything else, is found. `read` is
 * the old file as the new version reads it, given only by a test.
 */
export function upgradeDifferences(
  before: readonly ExportLine[],
  after: readonly ExportLine[],
  read: readonly ExportLine[] = readNow(before)
): UpgradeDifferences {
  const into = readingChanges(before, read);
  const old = objectSchema.catch({}).parse(before[0]);
  const carried = objectSchema.catch({}).parse(old.configuration);
  const exportedAt = Date.parse(String(old.exportedAt));
  const was = tablesOf(before);
  const given = tablesOf(read);
  const [first, ...history] = after;
  const header = objectSchema.catch({}).parse(first);
  const exportedAfter = Date.parse(String(header.exportedAt));
  const configuration = Object.fromEntries(
    Object.entries(objectSchema.catch({}).parse(header.configuration)).map(
      ([table, rows]) => [
        table,
        rowsSchema
          .catch([])
          .parse(rows)
          .filter((row) => {
            if (!(table in carried)) {
              into.allowed.push(
                `${table} ${rowName(row)} appeared: the old file does not carry ${table}`
              );
              return false;
            }
            if (
              table === "auditEntries" &&
              Date.parse(String(row.at)) > exportedAt
            ) {
              into.allowed.push(
                `${table} ${rowName(row)} (${String(row.action)}) appeared: written after the old export`
              );
              return false;
            }
            return true;
          })
          .map((row) => {
            const name = rowName(row);
            const stand = given.get(table)?.get(name);
            if (
              table === "maintenanceWindows" &&
              stand !== undefined &&
              advancedBetween(stand, row, exportedAt, exportedAfter)
            ) {
              into.allowed.push(
                `${table} ${name} changed: stage, updatedAt: its start or end came between the two exports`
              );
              return { ...row, stage: stand.stage, updatedAt: stand.updatedAt };
            }
            return stand === undefined || was.get(table)?.has(name)
              ? row
              : restamped(into, `${table} ${name}`, row, stand, exportedAt);
          }),
      ]
    )
  );
  const kept = new Set(
    rowsSchema.catch([]).parse(configuration.subscriptions).map(rowName)
  );
  return {
    allowed: into.allowed,
    found: [
      ...into.found,
      ...differences(withoutExpired(read, kept, exportedAfter, into), [
        { ...header, configuration },
        ...history,
      ]),
    ],
  };
}

/** Whether the new version moved the window on as the scheduler does at the time it wrote, between the two exports, and changed nothing else of it. */
function advancedBetween(
  was: Record<string, unknown>,
  is: Record<string, unknown>,
  oldAt: number,
  newAt: number
): boolean {
  const at = Date.parse(String(is.updatedAt));
  if (!(at > oldAt && at <= newAt)) {
    return false;
  }
  // The scheduler's advance: a window past its end completes, a scheduled one past its start begins.
  const { endsAt, stage: from, startsAt } = was;
  let stage = from;
  if (from !== "completed" && Date.parse(String(endsAt)) <= at) {
    stage = "completed";
  } else if (from === "scheduled" && Date.parse(String(startsAt)) <= at) {
    stage = "in_progress";
  }
  return (
    stage !== from &&
    is.stage === stage &&
    changedFields(was, is).join() === "stage,updatedAt"
  );
}

/** The old file without the pending subscriptions the new version no longer holds because their confirmation link ran out before its export, each allowed with its reason. */
function withoutExpired(
  lines: readonly ExportLine[],
  kept: ReadonlySet<string>,
  newAt: number,
  into: UpgradeDifferences
): ExportLine[] {
  const [first, ...history] = lines;
  const header = objectSchema.catch({}).parse(first);
  const configuration = objectSchema.catch({}).parse(header.configuration);
  const subscriptions = rowsSchema
    .catch([])
    .parse(configuration.subscriptions)
    .filter((row) => {
      const name = rowName(row);
      const ranOut =
        row.status === "pending" &&
        Date.parse(String(row.requestedAt)) + confirmationLifetimeMs <= newAt;
      if (ranOut && !kept.has(name)) {
        into.allowed.push(
          `subscriptions ${name} is missing: its confirmation link ran out between the two exports`
        );
        return false;
      }
      return true;
    });
  return [
    { ...header, configuration: { ...configuration, subscriptions } },
    ...history,
  ];
}

/** A row reading adds holds the time the conversion gives it, which the new version cannot match: it records the row when it upgrades, after the old export. That time alone is allowed to differ. */
function restamped(
  into: UpgradeDifferences,
  name: string,
  row: Record<string, unknown>,
  read: Record<string, unknown>,
  exportedAt: number
): Record<string, unknown> {
  if (
    row.updatedAt === read.updatedAt ||
    !(Date.parse(String(row.updatedAt)) > exportedAt)
  ) {
    return row;
  }
  into.allowed.push(
    `${name} changed: updatedAt: recorded by the new version after the old export`
  );
  return { ...row, updatedAt: read.updatedAt };
}

const reading = "what the new version reads into the old file";

/** The fields of the old file a format step rewrites, by table; any other field it had that reading changes is lost. */
const rewritten: Readonly<Record<string, readonly string[]>> = {
  monitors: ["events"],
};

/** Sorts what reading changed of one row into what it adds or a format step rewrites, allowed, and what it loses of the old file, found. */
function sortChanged(
  into: UpgradeDifferences,
  was: Record<string, unknown>,
  is: Record<string, unknown>,
  rewrites: readonly string[],
  named: (fields: string) => string
): void {
  const fields = changedFields(was, is);
  const lost = fields.filter((f) => f in was && !rewrites.includes(f));
  const added = fields.filter((f) => !lost.includes(f));
  if (added.length > 0) {
    into.allowed.push(`${named(added.join(", "))}: ${reading}`);
  }
  if (lost.length > 0) {
    into.found.push(
      `${named(lost.join(", "))} when the new version reads the old file`
    );
  }
}

/** What reading the old file changes: what it adds and the named rewrites are allowed, and what it loses of the old file is found. */
function readingChanges(
  before: readonly ExportLine[],
  read: readonly ExportLine[]
): UpgradeDifferences {
  const into: UpgradeDifferences = { allowed: [], found: [] };
  sortChanged(
    into,
    headerOf(before),
    headerOf(read),
    ["version"],
    (fields) => `the header's ${fields} changed`
  );
  const was = tablesOf(before);
  const is = tablesOf(read);
  for (const table of new Set([...was.keys(), ...is.keys()])) {
    const rowsWas = was.get(table) ?? new Map();
    const rowsIs = is.get(table) ?? new Map();
    for (const [name, row] of rowsWas) {
      const now = rowsIs.get(name);
      if (now === undefined) {
        into.found.push(
          `${table} ${name} is missing when the new version reads the old file`
        );
        continue;
      }
      sortChanged(
        into,
        row,
        now,
        rewritten[table] ?? [],
        (fields) => `${table} ${name} changed: ${fields}`
      );
    }
    for (const name of rowsIs.keys()) {
      if (!rowsWas.has(name)) {
        into.allowed.push(`${table} ${name} appeared: ${reading}`);
      }
    }
  }
  return into;
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

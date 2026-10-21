/**
 * What export and import need of storage (CONTEXT.md "Export", "Import"):
 * the install's configuration read as one
 * consistent set of rows, the refusal of an install that already holds
 * monitors, pages or components, the configuration written back with its
 * ids and times, history written a batch at a time, and what an import
 * wrote taken out again when it fails. Credentials stay sealed here; the
 * export module opens them and the import module seals them.
 */
import { getTableColumns, type SQL, sql } from "drizzle-orm";
import { type Check, resultCode } from "@/shared/schemas/check.ts";
import {
  type Configuration,
  type ConfigurationTable,
  travellingSettings,
} from "@/shared/schemas/export.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import {
  type Rollup,
  type RollupSpan,
  rollupSpanMs,
} from "@/shared/schemas/rollup.ts";
import type { Executor } from "./connection.ts";
import { bumpChangeCounter } from "./counter.ts";

/** The ids an import wrote, so a failed one can take them out again. */
export interface Restored {
  readonly auditEntries: readonly string[];
  readonly channels: readonly string[];
  readonly components: readonly string[];
  readonly groups: readonly string[];
  readonly incidents: readonly string[];
  readonly maintenanceSeries: readonly string[];
  readonly maintenanceWindows: readonly string[];
  readonly monitors: readonly string[];
  readonly operatorAccounts: readonly string[];
  readonly probes: readonly string[];
  readonly statusPages: readonly string[];
  readonly tags: readonly string[];
}

/** How many lines of each kind the full export writes for one monitor's days. */
export interface HistoryCount {
  /** Checks, sealed and in the head table. */
  readonly checks: number;
  /** Daily rollups of days with neither checks nor hourly rollups. */
  readonly daily: number;
  /** Hourly rollups of days with no checks. */
  readonly hourly: number;
}

export interface TransferRepository {
  /** Every table the configuration carries, read as one transaction; the settings only those that travel. Credentials are sealed as stored. */
  configuration: () => Promise<Configuration>;
  /** Each monitor's history as the full export writes it, counted without reading it, by monitor id; a monitor with none is left out. */
  historyCounts: () => Promise<Map<string, HistoryCount>>;
  /** Whether the install holds a monitor, a status page or a component, which refuses an import; an incident or a window an older version left with no component counts too. */
  holdsContent: () => Promise<boolean>;
  /** Deletes what an import wrote; the history goes with its monitors. */
  remove: (restored: Restored) => Promise<void>;
  /**
   * Writes the configuration but its settings as one transaction, with its
   * ids and times as they are. A channel or a probe whose id the install
   * already has stays as the install has it. Answers what it wrote, or nothing, having
   * written nothing, when the install holds content by then.
   */
  restore: (configuration: Configuration) => Promise<Restored | undefined>;
  /** Stores checks as head rows, a few hundred to a statement; a check already stored is kept. */
  writeChecks: (checks: readonly Check[]) => Promise<void>;
  /** Stores outages; an outage already stored is kept. */
  writeOutages: (outages: readonly Outage[]) => Promise<void>;
  /** Stores rollups of one span, replacing any at the same monitor and time. */
  writeRollups: (span: RollupSpan, rollups: readonly Rollup[]) => Promise<void>;
  /** Stores the settings, replacing the install's own, and moves the change counter, as one transaction: the last write of an import. */
  writeSettings: (settings: Configuration["settings"]) => Promise<void>;
}

/** The tables a configuration writes, parents before the rows that reference them. */
const writeOrder: readonly Exclude<ConfigurationTable, "settings">[] = [
  "groups",
  "tags",
  "channels",
  "probes",
  "monitors",
  "monitorTags",
  "monitorChannels",
  "monitorProbes",
  "components",
  "componentMonitors",
  "statusPages",
  "componentGroups",
  "pageComponents",
  "pageImages",
  "incidents",
  "incidentUpdates",
  "incidentStatuses",
  "maintenanceSeries",
  "maintenanceSeriesComponents",
  "maintenanceWindows",
  "maintenanceComponents",
  "subscriptions",
];

/** Parameters a statement binds at most: under both backends' 65,535. */
const parametersPerStatement = 60_000;

/** Code point order, the same on both backends whatever their collation. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The rows in the order of their first two columns' text, so both backends read one configuration the same. */
function inKeyOrder<Row extends object>(rows: Row[]): Row[] {
  const key = (row: Row) =>
    Object.values(row)
      .slice(0, 2)
      .map((value) => String(value))
      .join("\u0000");
  return rows.sort((a, b) => compareCodePoints(key(a), key(b)));
}

/** Slices of a list short enough for one statement at `width` parameters a row. */
function batches<Item>(items: readonly Item[], width: number): Item[][] {
  const size = Math.floor(parametersPerStatement / width);
  const out: Item[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
}

export function transferRepository(executor: Executor): TransferRepository {
  const {
    auditEntries,
    authUser,
    channels,
    checks,
    components,
    dailyRollups,
    groups,
    hourlyRollups,
    incidents,
    maintenanceSeries,
    maintenanceWindows,
    monitors,
    outages,
    probes,
    sealedDays,
    settings,
    statusPages,
    tags,
  } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  const dayMs = sql`CAST(${rollupSpanMs.day} AS BIGINT)`;

  /** One table's rows under their columns' property names; the settings only those that travel. */
  const read = async <Name extends ConfigurationTable>(
    run: Executor,
    name: Name
  ): Promise<Configuration[Name][number][]> => {
    const table = run.tables[name];
    const select = sql.join(
      Object.entries(getTableColumns(table)).map(
        ([property, each]) => sql`${each} AS ${column(property)}`
      ),
      sql`, `
    );
    const where =
      name === "settings"
        ? sql` WHERE ${settings.key} IN (${sql.join(
            travellingSettings.map((key) => sql`${key}`),
            sql`, `
          )})`
        : sql``;
    const rows = await run.rows<Configuration[Name][number]>(
      sql`SELECT ${select} FROM ${table}${where}`
    );
    return inKeyOrder(rows);
  };

  /** Writes rows under their columns' property names, a batch to a statement, with a conflict clause when one is given. */
  const insert = async (
    run: Executor,
    name: ConfigurationTable,
    rows: readonly object[],
    conflict: SQL = sql``
  ) => {
    const table = run.tables[name];
    const columns = Object.entries(getTableColumns(table));
    const names = sql.join(
      columns.map(([, each]) => column(each.name)),
      sql`, `
    );
    for (const batch of batches(rows, columns.length)) {
      const values = batch.map((row) => {
        const fields = new Map<string, unknown>(Object.entries(row));
        return sql`(${sql.join(
          columns.map(([property]) => sql`${fields.get(property) ?? null}`),
          sql`, `
        )})`;
      });
      // biome-ignore lint/performance/noAwaitInLoops: one statement after another on the transaction's connection
      await run.run(
        sql`INSERT INTO ${table} (${names}) VALUES ${sql.join(values, sql`, `)}${conflict}`
      );
    }
  };

  // The account columns that travel: never the credentials, sessions, second step or last sign-in, which belong to the install that holds them.
  const accountColumns = {
    calendar: authUser.calendar,
    clock: authUser.clock,
    createdAt: authUser.createdAt,
    deactivatedAt: authUser.deactivatedAt,
    email: authUser.email,
    emailVerified: authUser.emailVerified,
    id: authUser.id,
    language: authUser.language,
    name: authUser.name,
    role: authUser.role,
    timeZone: authUser.timeZone,
    updatedAt: authUser.updatedAt,
  };

  /** The accounts under the configuration's property names, the id first so they read in its order on both backends. */
  const readAccounts = async (
    run: Executor
  ): Promise<Configuration["operatorAccounts"]> => {
    const select = sql.join(
      Object.entries(accountColumns).map(
        ([property, each]) => sql`${each} AS ${column(property)}`
      ),
      sql`, `
    );
    const rows = await run.rows<Configuration["operatorAccounts"][number]>(
      sql`SELECT ${select} FROM ${authUser}`
    );
    return rows
      .map((row) => ({
        ...row,
        createdAt: Number(row.createdAt),
        deactivatedAt:
          row.deactivatedAt === null ? null : Number(row.deactivatedAt),
        emailVerified: Number(row.emailVerified),
        updatedAt: Number(row.updatedAt),
      }))
      .sort((a, b) => compareCodePoints(a.id, b.id));
  };

  /** Writes the accounts the install lacks by id and by address, with no credentials, and answers their ids. */
  const writeAccounts = async (
    run: Executor,
    accounts: Configuration["operatorAccounts"]
  ): Promise<string[]> => {
    const held = await run.rows<{ email: string; id: string }>(
      sql`SELECT ${authUser.id} AS id, lower(${authUser.email}) AS email FROM ${authUser}`
    );
    const ids = new Set(held.map((row) => row.id));
    const emails = new Set(held.map((row) => row.email));
    const fresh = accounts.filter(
      (account) =>
        !(ids.has(account.id) || emails.has(account.email.toLowerCase()))
    );
    for (const account of fresh) {
      const values = Object.keys(accountColumns).map(
        (property) =>
          sql`${new Map(Object.entries(account)).get(property) ?? null}`
      );
      // biome-ignore lint/performance/noAwaitInLoops: an install has a handful of accounts
      await run.run(
        sql`INSERT INTO ${authUser} (${sql.join(
          Object.values(accountColumns).map((each) => column(each.name)),
          sql`, `
        )}, ${column(authUser.twoFactorEnabled.name)}) VALUES (${sql.join(values, sql`, `)}, 0)`
      );
    }
    return fresh.map((account) => account.id);
  };

  /** The audit log, oldest first, under the configuration's property names. */
  const readAudit = async (
    run: Executor
  ): Promise<Configuration["auditEntries"]> =>
    (
      await run.rows<Configuration["auditEntries"][number]>(
        sql`SELECT ${auditEntries.id} AS id, ${auditEntries.at} AS ${column("at")}, ${auditEntries.actorId} AS ${column("actorId")}, ${auditEntries.actorEmail} AS ${column("actorEmail")}, ${auditEntries.action} AS action, ${auditEntries.targetId} AS ${column("targetId")}, ${auditEntries.detail} AS detail, ${auditEntries.address} AS address FROM ${auditEntries} ORDER BY ${auditEntries.at}, ${auditEntries.id}`
      )
    ).map((row) => ({ ...row, at: Number(row.at) }));

  /** Writes the entries the install lacks by id and answers their ids. */
  const writeAudit = async (
    run: Executor,
    entries: Configuration["auditEntries"]
  ): Promise<string[]> => {
    const written: string[] = [];
    for (const entry of entries) {
      // biome-ignore lint/performance/noAwaitInLoops: one statement after another on the transaction's connection
      const changed = await run.run(
        sql`INSERT INTO ${auditEntries} (${column(auditEntries.id.name)}, ${column(auditEntries.at.name)}, ${column(auditEntries.actorId.name)}, ${column(auditEntries.actorEmail.name)}, ${column(auditEntries.action.name)}, ${column(auditEntries.targetId.name)}, ${column(auditEntries.detail.name)}, ${column(auditEntries.address.name)}) VALUES (${entry.id}, ${entry.at}, ${entry.actorId}, ${entry.actorEmail}, ${entry.action}, ${entry.targetId}, ${entry.detail}, ${entry.address}) ON CONFLICT (${column(auditEntries.id.name)}) DO NOTHING`
      );
      if (changed > 0) {
        written.push(entry.id);
      }
    }
    return written;
  };

  const holds = async (run: Executor) =>
    (
      await run.rows(
        sql`SELECT 1 FROM ${monitors} UNION ALL SELECT 1 FROM ${statusPages} UNION ALL SELECT 1 FROM ${components} UNION ALL SELECT 1 FROM ${incidents} UNION ALL SELECT 1 FROM ${maintenanceWindows} LIMIT 1`
      )
    ).length > 0;

  /** Deletes the rows of one table whose id is listed. */
  const removeIds = async (
    run: Executor,
    table:
      | typeof monitors
      | typeof statusPages
      | typeof components
      | typeof incidents
      | typeof maintenanceWindows
      | typeof maintenanceSeries
      | typeof channels
      | typeof probes
      | typeof groups
      | typeof tags
      | typeof authUser
      | typeof auditEntries,
    ids: readonly string[]
  ) => {
    for (const batch of batches(ids, 1)) {
      // biome-ignore lint/performance/noAwaitInLoops: one statement after another on the transaction's connection
      await run.run(
        sql`DELETE FROM ${table} WHERE ${table.id} IN (${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
    }
  };

  /** Which of these ids the table already holds. */
  const held = async (
    run: Executor,
    table: typeof channels | typeof probes,
    ids: readonly string[]
  ): Promise<Set<string>> => {
    const existing = new Set<string>();
    for (const batch of batches(ids, 1)) {
      // biome-ignore lint/performance/noAwaitInLoops: one read after another on the transaction's connection
      const rows = await run.rows<{ id: string }>(
        sql`SELECT ${table.id} AS id FROM ${table} WHERE ${table.id} IN (${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
      for (const row of rows) {
        existing.add(row.id);
      }
    }
    return existing;
  };

  return {
    configuration: () =>
      executor.transaction(async (tx) => {
        if (tx.backend === "postgres") {
          // Every read below sees the one snapshot the first one takes, so no row points at one written in between.
          await tx.run(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        }
        return {
          settings: await read(tx, "settings"),
          groups: await read(tx, "groups"),
          tags: await read(tx, "tags"),
          channels: await read(tx, "channels"),
          probes: await read(tx, "probes"),
          monitors: await read(tx, "monitors"),
          monitorTags: await read(tx, "monitorTags"),
          monitorChannels: await read(tx, "monitorChannels"),
          monitorProbes: await read(tx, "monitorProbes"),
          components: await read(tx, "components"),
          componentMonitors: await read(tx, "componentMonitors"),
          statusPages: await read(tx, "statusPages"),
          componentGroups: await read(tx, "componentGroups"),
          pageComponents: await read(tx, "pageComponents"),
          pageImages: await read(tx, "pageImages"),
          incidents: await read(tx, "incidents"),
          incidentUpdates: await read(tx, "incidentUpdates"),
          incidentStatuses: await read(tx, "incidentStatuses"),
          maintenanceSeries: await read(tx, "maintenanceSeries"),
          maintenanceSeriesComponents: await read(
            tx,
            "maintenanceSeriesComponents"
          ),
          maintenanceWindows: await read(tx, "maintenanceWindows"),
          maintenanceComponents: await read(tx, "maintenanceComponents"),
          subscriptions: await read(tx, "subscriptions"),
          operatorAccounts: await readAccounts(tx),
          auditEntries: await readAudit(tx),
        };
      }),
    historyCounts: async () => {
      // A day's lines are of its finest kind alone, as the export writes them: checks, else hourly rollups, else the daily one.
      const noChecks = (monitorId: SQL, start: SQL) =>
        sql`NOT EXISTS (SELECT 1 FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} = ${start}) AND NOT EXISTS (SELECT 1 FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} >= ${start} AND ${checks.startedAt} < ${start} + ${dayMs})`;
      const hourStart = sql`(${hourlyRollups.hour} / ${dayMs}) * ${dayMs}`;
      const rows = await executor.rows<{
        kind: keyof HistoryCount;
        lines: number | string;
        monitor_id: string;
      }>(
        sql`SELECT ${sealedDays.monitorId} AS monitor_id, 'checks' AS kind, SUM(${sealedDays.checks}) AS lines FROM ${sealedDays} GROUP BY ${sealedDays.monitorId}
          UNION ALL SELECT ${checks.monitorId}, 'checks', COUNT(*) FROM ${checks} GROUP BY ${checks.monitorId}
          UNION ALL SELECT ${hourlyRollups.monitorId}, 'hourly', COUNT(*) FROM ${hourlyRollups} WHERE ${noChecks(sql`${hourlyRollups.monitorId}`, hourStart)} GROUP BY ${hourlyRollups.monitorId}
          UNION ALL SELECT ${dailyRollups.monitorId}, 'daily', COUNT(*) FROM ${dailyRollups} WHERE ${noChecks(sql`${dailyRollups.monitorId}`, sql`${dailyRollups.day}`)} AND NOT EXISTS (SELECT 1 FROM ${hourlyRollups} WHERE ${hourlyRollups.monitorId} = ${dailyRollups.monitorId} AND ${hourlyRollups.hour} >= ${dailyRollups.day} AND ${hourlyRollups.hour} < ${dailyRollups.day} + ${dayMs}) GROUP BY ${dailyRollups.monitorId}`
      );
      const counts = new Map<string, HistoryCount>();
      for (const row of rows) {
        const count = counts.get(row.monitor_id) ?? {
          checks: 0,
          daily: 0,
          hourly: 0,
        };
        // Postgres answers a count or a sum as a bigint, which the driver reads as text.
        counts.set(row.monitor_id, {
          ...count,
          [row.kind]: count[row.kind] + Number(row.lines),
        });
      }
      return counts;
    },
    holdsContent: () => holds(executor),
    remove: (restored) =>
      executor.transaction(async (tx) => {
        await removeIds(tx, monitors, restored.monitors);
        await removeIds(tx, statusPages, restored.statusPages);
        await removeIds(tx, incidents, restored.incidents);
        await removeIds(tx, maintenanceWindows, restored.maintenanceWindows);
        await removeIds(tx, maintenanceSeries, restored.maintenanceSeries);
        await removeIds(tx, components, restored.components);
        await removeIds(tx, channels, restored.channels);
        await removeIds(tx, probes, restored.probes);
        await removeIds(tx, groups, restored.groups);
        await removeIds(tx, tags, restored.tags);
        await removeIds(tx, authUser, restored.operatorAccounts);
        await removeIds(tx, auditEntries, restored.auditEntries);
      }),
    restore: (configuration) =>
      executor.transaction(async (tx) => {
        // A refusal is an answer, not an error class: the storage comes from the entry's module tree and the import runs in the handler's bundle, so an `instanceof` across them fails.
        if (await holds(tx)) {
          return;
        }
        const heldChannels = await held(
          tx,
          channels,
          configuration.channels.map((row) => row.id)
        );
        const heldProbes = await held(
          tx,
          probes,
          configuration.probes.map((row) => row.id)
        );
        const written = {
          ...configuration,
          channels: configuration.channels.filter(
            (row) => !heldChannels.has(row.id)
          ),
          probes: configuration.probes.filter((row) => !heldProbes.has(row.id)),
        };
        for (const name of writeOrder) {
          // biome-ignore lint/performance/noAwaitInLoops: parents before the rows that reference them
          await insert(tx, name, written[name]);
        }
        const accounts = await writeAccounts(
          tx,
          configuration.operatorAccounts
        );
        const audit = await writeAudit(tx, configuration.auditEntries);
        const idsOf = (rows: readonly { id: string }[]) =>
          rows.map((row) => row.id);
        return {
          auditEntries: audit,
          channels: idsOf(written.channels),
          components: idsOf(written.components),
          groups: idsOf(written.groups),
          incidents: idsOf(written.incidents),
          maintenanceSeries: idsOf(written.maintenanceSeries),
          maintenanceWindows: idsOf(written.maintenanceWindows),
          monitors: idsOf(written.monitors),
          operatorAccounts: accounts,
          probes: idsOf(written.probes),
          statusPages: idsOf(written.statusPages),
          tags: idsOf(written.tags),
        };
      }),
    writeChecks: async (rows) => {
      for (const batch of batches(rows, 8)) {
        // biome-ignore lint/performance/noAwaitInLoops: one statement after another, oldest first
        await executor.run(
          sql`INSERT INTO ${checks} (${column("monitor_id")}, ${column("started_at")}, ${column("result")}, ${column("response_ms")}, ${column("status_code")}, ${column("reason")}, ${column("attempts")}, ${column("bytes")}) VALUES ${sql.join(
            batch.map(
              (check) =>
                sql`(${check.monitorId}, ${check.startedAt}, ${resultCode(check.result)}, ${check.responseMs ?? null}, ${check.statusCode ?? null}, ${check.reason}, ${check.attempts}, ${check.bytes})`
            ),
            sql`, `
          )} ON CONFLICT (${column("monitor_id")}, ${column("started_at")}) DO NOTHING`
        );
      }
    },
    writeOutages: async (rows) => {
      // One list names the columns and gives each row's values, so a batch's width follows a new column.
      const fields: readonly [string, (outage: Outage) => unknown][] = [
        ["monitor_id", (outage) => outage.monitorId],
        ["started_at", (outage) => outage.startedAt],
        ["ended_at", (outage) => outage.endedAt ?? null],
        ["reason", (outage) => outage.reason],
        ["acknowledged_at", (outage) => outage.acknowledgedAt ?? null],
      ];
      const names = sql.join(
        fields.map(([name]) => column(name)),
        sql`, `
      );
      for (const batch of batches(rows, fields.length)) {
        // biome-ignore lint/performance/noAwaitInLoops: one statement after another
        await executor.run(
          sql`INSERT INTO ${outages} (${names}) VALUES ${sql.join(
            batch.map(
              (outage) =>
                sql`(${sql.join(
                  fields.map(([, value]) => sql`${value(outage)}`),
                  sql`, `
                )})`
            ),
            sql`, `
          )} ON CONFLICT (${column("monitor_id")}, ${column("started_at")}) DO NOTHING`
        );
      }
    },
    writeRollups: async (span, rows) => {
      const table = span === "hour" ? hourlyRollups : dailyRollups;
      const at = column(span);
      const replaced = [
        "checks",
        "observed_ms",
        "average_ms",
        "min_ms",
        "max_ms",
        "failed",
        "degraded",
      ].map((name) => sql`${column(name)} = excluded.${column(name)}`);
      for (const batch of batches(rows, 9)) {
        // biome-ignore lint/performance/noAwaitInLoops: one statement after another
        await executor.run(
          sql`INSERT INTO ${table} (${column("monitor_id")}, ${at}, ${column("checks")}, ${column("observed_ms")}, ${column("average_ms")}, ${column("min_ms")}, ${column("max_ms")}, ${column("failed")}, ${column("degraded")}) VALUES ${sql.join(
            batch.map(
              (rollup) =>
                sql`(${rollup.monitorId}, ${rollup.at}, ${rollup.checks}, ${rollup.observedMs}, ${rollup.averageMs ?? null}, ${rollup.minMs ?? null}, ${rollup.maxMs ?? null}, ${rollup.failed}, ${rollup.degraded})`
            ),
            sql`, `
          )} ON CONFLICT (${column("monitor_id")}, ${at}) DO UPDATE SET ${sql.join(replaced, sql`, `)}`
        );
      }
    },
    writeSettings: (rows) =>
      executor.transaction(async (tx) => {
        await insert(
          tx,
          "settings",
          rows,
          sql` ON CONFLICT (${column("key")}) DO UPDATE SET ${column("value")} = excluded.${column("value")}, ${column("updated_at")} = excluded.${column("updated_at")}`
        );
        await bumpChangeCounter(tx);
      }),
  };
}

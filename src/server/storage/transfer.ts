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
  readonly channels: readonly string[];
  readonly components: readonly string[];
  readonly groups: readonly string[];
  readonly incidents: readonly string[];
  readonly maintenanceWindows: readonly string[];
  readonly monitors: readonly string[];
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
   * ids and times as they are. A channel whose id the install already has
   * stays as the install has it. Answers what it wrote, or nothing, having
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
  "monitors",
  "monitorTags",
  "monitorChannels",
  "components",
  "componentMonitors",
  "statusPages",
  "componentGroups",
  "pageComponents",
  "pageImages",
  "incidents",
  "incidentUpdates",
  "incidentStatuses",
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
    channels,
    checks,
    components,
    dailyRollups,
    groups,
    hourlyRollups,
    incidents,
    maintenanceWindows,
    monitors,
    outages,
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
      | typeof channels
      | typeof groups
      | typeof tags,
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
          monitors: await read(tx, "monitors"),
          monitorTags: await read(tx, "monitorTags"),
          monitorChannels: await read(tx, "monitorChannels"),
          components: await read(tx, "components"),
          componentMonitors: await read(tx, "componentMonitors"),
          statusPages: await read(tx, "statusPages"),
          componentGroups: await read(tx, "componentGroups"),
          pageComponents: await read(tx, "pageComponents"),
          pageImages: await read(tx, "pageImages"),
          incidents: await read(tx, "incidents"),
          incidentUpdates: await read(tx, "incidentUpdates"),
          incidentStatuses: await read(tx, "incidentStatuses"),
          maintenanceWindows: await read(tx, "maintenanceWindows"),
          maintenanceComponents: await read(tx, "maintenanceComponents"),
          subscriptions: await read(tx, "subscriptions"),
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
        await removeIds(tx, components, restored.components);
        await removeIds(tx, channels, restored.channels);
        await removeIds(tx, groups, restored.groups);
        await removeIds(tx, tags, restored.tags);
      }),
    restore: (configuration) =>
      executor.transaction(async (tx) => {
        // A refusal is an answer, not an error class: the storage comes from the entry's module tree and the import runs in the handler's bundle, so an `instanceof` across them fails.
        if (await holds(tx)) {
          return;
        }
        const ids = configuration.channels.map((row) => row.id);
        const existing = new Set<string>();
        for (const batch of batches(ids, 1)) {
          // biome-ignore lint/performance/noAwaitInLoops: one read after another on the transaction's connection
          const rows = await tx.rows<{ id: string }>(
            sql`SELECT ${channels.id} AS id FROM ${channels} WHERE ${channels.id} IN (${sql.join(
              batch.map((id) => sql`${id}`),
              sql`, `
            )})`
          );
          for (const row of rows) {
            existing.add(row.id);
          }
        }
        const written = {
          ...configuration,
          channels: configuration.channels.filter(
            (row) => !existing.has(row.id)
          ),
        };
        for (const name of writeOrder) {
          // biome-ignore lint/performance/noAwaitInLoops: parents before the rows that reference them
          await insert(tx, name, written[name]);
        }
        const idsOf = (rows: readonly { id: string }[]) =>
          rows.map((row) => row.id);
        return {
          channels: idsOf(written.channels),
          components: idsOf(written.components),
          groups: idsOf(written.groups),
          incidents: idsOf(written.incidents),
          maintenanceWindows: idsOf(written.maintenanceWindows),
          monitors: idsOf(written.monitors),
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

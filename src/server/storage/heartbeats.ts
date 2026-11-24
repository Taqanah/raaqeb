/**
 * The heartbeats repository (CONTEXT.md "Heartbeat"): one row per
 * incoming call to a heartbeat monitor's unique URL, keyed by monitor and
 * arrival time, with the source address. Each monitor keeps its latest
 * hundred; the scheduler's evaluation prunes the rest.
 * Rows never leave this file.
 */
import { inArray, sql } from "drizzle-orm";
import type {
  Heartbeat,
  HeartbeatFailure,
} from "@/shared/schemas/heartbeat.ts";
import type { Executor } from "./connection.ts";

export interface HeartbeatsRepository {
  /** Whether a heartbeat monitor has this token: one seek of its unique index. */
  knows: (token: string) => Promise<boolean>;
  /** The newest heartbeat of each of these monitors that reported failure, even when a heartbeat that says the job ran came after it; with `before`, the newest that arrived before that time. */
  lastFailures: (
    monitorIds: readonly string[],
    before?: number
  ) => Promise<ReadonlyMap<string, Heartbeat>>;
  /** The latest heartbeat of each of these monitors that has one, by monitor id; with `before`, the latest that arrived before that time. */
  latest: (
    monitorIds: readonly string[],
    before?: number
  ) => Promise<ReadonlyMap<string, Heartbeat>>;
  /** Deletes every heartbeat of the monitor but the newest `keep`. */
  prune: (monitorId: string, keep: number) => Promise<void>;
  /** The monitor's newest `limit` heartbeats, newest first. */
  recent: (monitorId: string, limit: number) => Promise<readonly Heartbeat[]>;
  /** Stores a heartbeat for the heartbeat monitor with this token and answers its id, or nothing when no heartbeat monitor has the token; `failure` marks a call that said the job failed. A second heartbeat in the same millisecond is the same row. */
  record: (
    token: string,
    arrivedAt: number,
    sourceIp: string | undefined,
    failure?: HeartbeatFailure
  ) => Promise<string | undefined>;
}

/** A heartbeat row as the driver answers it. */
interface HeartbeatRow {
  arrived_at: number | string;
  exit_code: number | string | null;
  failed: number | string;
  message: string | null;
  monitor_id: string;
  source_ip: string | null;
}

function heartbeatOf(row: HeartbeatRow): Heartbeat {
  return {
    arrivedAt: Number(row.arrived_at),
    failure:
      Number(row.failed) === 1
        ? {
            exitCode:
              row.exit_code === null ? undefined : Number(row.exit_code),
            message: row.message ?? undefined,
          }
        : undefined,
    sourceIp: row.source_ip ?? undefined,
  };
}

export function heartbeatsRepository(executor: Executor): HeartbeatsRepository {
  const { heartbeats, monitors } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  /** The columns a row is read with, under the names `HeartbeatRow` has. */
  const fields = sql`${heartbeats.monitorId} AS monitor_id, ${heartbeats.arrivedAt} AS arrived_at, ${heartbeats.sourceIp} AS source_ip, ${heartbeats.failed} AS failed, ${heartbeats.exitCode} AS exit_code, ${heartbeats.message} AS message`;

  return {
    knows: async (token) =>
      (
        await executor.rows<{ one: number }>(
          sql`SELECT 1 AS one FROM ${monitors} WHERE ${monitors.heartbeatToken} = ${token} LIMIT 1`
        )
      ).length > 0,
    latest: async (monitorIds, before) => {
      if (monitorIds.length === 0) {
        return new Map();
      }
      const bound =
        before === undefined
          ? sql``
          : sql` AND latest.${column("arrived_at")} < ${before}`;
      // Driven from the monitors asked about, one key seek each: the newest row of the pair key.
      const rows = await executor.rows<HeartbeatRow>(
        sql`SELECT ${fields} FROM ${heartbeats} WHERE ${heartbeats.arrivedAt} = (SELECT max(${column("arrived_at")}) FROM ${heartbeats} AS latest WHERE latest.${column("monitor_id")} = ${heartbeats.monitorId}${bound}) AND ${inArray(heartbeats.monitorId, [...monitorIds])}`
      );
      return new Map(rows.map((row) => [row.monitor_id, heartbeatOf(row)]));
    },
    prune: async (monitorId, keep) => {
      // The newest `keep` stay; the arrival time of the one past them is the line, and nothing past a short list deletes anything.
      await executor.run(
        sql`DELETE FROM ${heartbeats} WHERE ${heartbeats.monitorId} = ${monitorId} AND ${heartbeats.arrivedAt} <= (SELECT ${column("arrived_at")} FROM ${heartbeats} WHERE ${heartbeats.monitorId} = ${monitorId} ORDER BY ${column("arrived_at")} DESC LIMIT 1 OFFSET ${keep})`
      );
    },
    lastFailures: async (monitorIds, before) => {
      if (monitorIds.length === 0) {
        return new Map();
      }
      const bound =
        before === undefined
          ? sql``
          : sql` AND latest.${column("arrived_at")} < ${before}`;
      // As `latest`, over the failing rows alone: at most the hundred a monitor keeps are looked through.
      const rows = await executor.rows<HeartbeatRow>(
        sql`SELECT ${fields} FROM ${heartbeats} WHERE ${heartbeats.failed} = 1 AND ${heartbeats.arrivedAt} = (SELECT max(${column("arrived_at")}) FROM ${heartbeats} AS latest WHERE latest.${column("monitor_id")} = ${heartbeats.monitorId} AND latest.${column("failed")} = 1${bound}) AND ${inArray(heartbeats.monitorId, [...monitorIds])}`
      );
      return new Map(rows.map((row) => [row.monitor_id, heartbeatOf(row)]));
    },
    recent: async (monitorId, limit) => {
      const rows = await executor.rows<HeartbeatRow>(
        sql`SELECT ${fields} FROM ${heartbeats} WHERE ${heartbeats.monitorId} = ${monitorId} ORDER BY ${heartbeats.arrivedAt} DESC LIMIT ${limit}`
      );
      return rows.map(heartbeatOf);
    },
    record: async (token, arrivedAt, sourceIp, failure) => {
      // One statement: the token names a heartbeat monitor (only they hold one) or nothing is written; a second call in the same millisecond updates the one row, so it still answers the monitor.
      const rows = await executor.rows<{ monitor_id: string }>(
        sql`INSERT INTO ${heartbeats} (${column("monitor_id")}, ${column("arrived_at")}, ${column("source_ip")}, ${column("failed")}, ${column("exit_code")}, ${column("message")}) SELECT ${monitors.id}, ${arrivedAt}, ${sourceIp ?? null}, ${failure ? 1 : 0}, ${failure?.exitCode ?? null}, ${failure?.message ?? null} FROM ${monitors} WHERE ${monitors.heartbeatToken} = ${token} ON CONFLICT (${column("monitor_id")}, ${column("arrived_at")}) DO UPDATE SET ${column("source_ip")} = excluded.${column("source_ip")}, ${column("failed")} = excluded.${column("failed")}, ${column("exit_code")} = excluded.${column("exit_code")}, ${column("message")} = excluded.${column("message")} RETURNING ${column("monitor_id")} AS monitor_id`
      );
      return rows[0]?.monitor_id;
    },
  };
}

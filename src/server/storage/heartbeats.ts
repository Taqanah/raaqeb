/**
 * The heartbeats repository (CONTEXT.md "Heartbeat"): one row per
 * incoming call to a heartbeat monitor's unique URL, keyed by monitor and
 * arrival time, with the source address. Each monitor keeps its latest
 * hundred; the scheduler's evaluation prunes the rest.
 * Rows never leave this file.
 */
import { inArray, sql } from "drizzle-orm";
import type { Heartbeat } from "@/shared/schemas/heartbeat.ts";
import type { Executor } from "./connection.ts";

export interface HeartbeatsRepository {
  /** The latest heartbeat of each of these monitors that has one, by monitor id; with `before`, the latest that arrived before that time. */
  latest: (
    monitorIds: readonly string[],
    before?: number
  ) => Promise<ReadonlyMap<string, Heartbeat>>;
  /** Deletes every heartbeat of the monitor but the newest `keep`. */
  prune: (monitorId: string, keep: number) => Promise<void>;
  /** Stores a heartbeat for the heartbeat monitor with this token and answers its id, or nothing when no heartbeat monitor has the token. A second heartbeat in the same millisecond is the same row. */
  record: (
    token: string,
    arrivedAt: number,
    sourceIp: string | undefined
  ) => Promise<string | undefined>;
}

/** A heartbeat row as the driver answers it. */
interface HeartbeatRow {
  arrived_at: number | string;
  monitor_id: string;
  source_ip: string | null;
}

export function heartbeatsRepository(executor: Executor): HeartbeatsRepository {
  const { heartbeats, monitors } = executor.tables;
  const column = (name: string) => sql.identifier(name);

  return {
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
        sql`SELECT ${heartbeats.monitorId} AS monitor_id, ${heartbeats.arrivedAt} AS arrived_at, ${heartbeats.sourceIp} AS source_ip FROM ${heartbeats} WHERE ${heartbeats.arrivedAt} = (SELECT max(${column("arrived_at")}) FROM ${heartbeats} AS latest WHERE latest.${column("monitor_id")} = ${heartbeats.monitorId}${bound}) AND ${inArray(heartbeats.monitorId, [...monitorIds])}`
      );
      return new Map(
        rows.map((row) => [
          row.monitor_id,
          {
            arrivedAt: Number(row.arrived_at),
            sourceIp: row.source_ip ?? undefined,
          },
        ])
      );
    },
    prune: async (monitorId, keep) => {
      // The newest `keep` stay; the arrival time of the one past them is the line, and nothing past a short list deletes anything.
      await executor.run(
        sql`DELETE FROM ${heartbeats} WHERE ${heartbeats.monitorId} = ${monitorId} AND ${heartbeats.arrivedAt} <= (SELECT ${column("arrived_at")} FROM ${heartbeats} WHERE ${heartbeats.monitorId} = ${monitorId} ORDER BY ${column("arrived_at")} DESC LIMIT 1 OFFSET ${keep})`
      );
    },
    record: async (token, arrivedAt, sourceIp) => {
      // One statement: the token names a heartbeat monitor (only they hold one) or nothing is written; a second call in the same millisecond updates the one row, so it still answers the monitor.
      const rows = await executor.rows<{ monitor_id: string }>(
        sql`INSERT INTO ${heartbeats} (${column("monitor_id")}, ${column("arrived_at")}, ${column("source_ip")}) SELECT ${monitors.id}, ${arrivedAt}, ${sourceIp ?? null} FROM ${monitors} WHERE ${monitors.heartbeatToken} = ${token} ON CONFLICT (${column("monitor_id")}, ${column("arrived_at")}) DO UPDATE SET ${column("source_ip")} = excluded.${column("source_ip")} RETURNING ${column("monitor_id")} AS monitor_id`
      );
      return rows[0]?.monitor_id;
    },
  };
}

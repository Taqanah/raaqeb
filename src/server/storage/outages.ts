/**
 * The outages repository (CONTEXT.md "Outage"): one row per span
 * of one monitor being down, opened by the first confirmed down check and
 * closed by the first recovered check, kept on its own so it outlives the
 * checks that produced it, and the operator may acknowledge it once, which
 * stops its reminders. Never deleted by retention or the size budget;
 * only with its monitor. Rows never leave this file.
 */
import { sql } from "drizzle-orm";
import type { Outage } from "@/shared/schemas/outage.ts";
import { type ReasonCode, reasonName } from "@/shared/schemas/reason.ts";
import type { Executor } from "./connection.ts";

export interface OutagesRepository {
  /** Acknowledges the monitor's outage that started at `startedAt` at this time, when it is still open and nobody acknowledged it; answers the acknowledged outage or nothing. */
  acknowledge: (
    monitorId: string,
    startedAt: number,
    at: number
  ) => Promise<Outage | undefined>;
  /** Closes the monitor's open outage at this time, when it has one; answers the closed outage or nothing. */
  close: (monitorId: string, endedAt: number) => Promise<Outage | undefined>;
  /** The outages of one monitor, newest first; with `since`, only those still open or ended after it. */
  list: (monitorId: string, since?: number) => Promise<Outage[]>;
  /** Every outage still open, across monitors, in key order. */
  ongoing: () => Promise<Outage[]>;
  /** Opens an outage for an active monitor that has none open and was not changed since the check started; answers whether one was opened. A paused monitor gets none. */
  open: (
    monitorId: string,
    startedAt: number,
    reason: ReasonCode
  ) => Promise<boolean>;
  /** The outages of many monitors still open or ended after `since`, newest first, by monitor id, in one read. A monitor with none is left out. */
  since: (
    monitorIds: readonly string[],
    since: number
  ) => Promise<Map<string, Outage[]>>;
}

/** Thrown by a read when a stored row carries a reason this version does not know; the message names the outage, never the text. */
export class OutageShapeError extends Error {
  readonly monitorId: string;
  readonly startedAt: number;
  constructor(monitorId: string, startedAt: number) {
    super(
      `the stored outage of the monitor ${monitorId} at ${startedAt} does not fit its schema`
    );
    this.name = "OutageShapeError";
    this.monitorId = monitorId;
    this.startedAt = startedAt;
  }
}

/** A row as the driver answers it. */
interface OutageRow {
  acknowledged_at: number | null;
  ended_at: number | null;
  monitor_id: string;
  reason: number;
  started_at: number;
}

export function outagesRepository(executor: Executor): OutagesRepository {
  const { monitors, outages } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  const columns = sql`${outages.monitorId} AS monitor_id, ${outages.startedAt} AS started_at, ${outages.endedAt} AS ended_at, ${outages.reason} AS reason, ${outages.acknowledgedAt} AS acknowledged_at`;

  return {
    acknowledge: async (monitorId, startedAt, at) => {
      const rows = await executor.rows<OutageRow>(
        sql`UPDATE ${outages} SET ${column("acknowledged_at")} = ${at} WHERE ${outages.monitorId} = ${monitorId} AND ${outages.startedAt} = ${startedAt} AND ${outages.endedAt} IS NULL AND ${outages.acknowledgedAt} IS NULL RETURNING ${columns}`
      );
      const [row] = rows;
      return row ? outageOf(row) : undefined;
    },
    close: async (monitorId, endedAt) => {
      const rows = await executor.rows<OutageRow>(
        sql`UPDATE ${outages} SET ${column("ended_at")} = ${endedAt} WHERE ${outages.monitorId} = ${monitorId} AND ${outages.endedAt} IS NULL RETURNING ${columns}`
      );
      const [row] = rows;
      return row ? outageOf(row) : undefined;
    },
    list: async (monitorId, since) => {
      const recent =
        since === undefined
          ? sql``
          : sql` AND (${outages.endedAt} IS NULL OR ${outages.endedAt} > ${since})`;
      const rows = await executor.rows<OutageRow>(
        sql`SELECT ${columns} FROM ${outages} WHERE ${outages.monitorId} = ${monitorId}${recent} ORDER BY ${outages.startedAt} DESC`
      );
      return rows.map(outageOf);
    },
    since: async (monitorIds, since) => {
      const read = new Map<string, Outage[]>();
      if (monitorIds.length === 0) {
        return read;
      }
      const rows = await executor.rows<OutageRow>(
        sql`SELECT ${columns} FROM ${outages} WHERE ${outages.monitorId} IN (${sql.join(
          monitorIds.map((id) => sql`${id}`),
          sql`, `
        )}) AND (${outages.endedAt} IS NULL OR ${outages.endedAt} > ${since}) ORDER BY ${outages.monitorId}, ${outages.startedAt} DESC`
      );
      for (const row of rows) {
        const list = read.get(row.monitor_id) ?? [];
        list.push(outageOf(row));
        read.set(row.monitor_id, list);
      }
      return read;
    },
    ongoing: async () => {
      const rows = await executor.rows<OutageRow>(
        sql`SELECT ${columns} FROM ${outages} WHERE ${outages.endedAt} IS NULL ORDER BY ${outages.monitorId}, ${outages.startedAt}`
      );
      return rows.map(outageOf);
    },
    open: async (monitorId, startedAt, reason) => {
      // One statement decides: the monitor exists, is active, was not paused, resumed or edited since the check started (a check that outlives a pause does not speak for the monitor as it is now), and has no open outage. A paused monitor's time is never downtime.
      const rows = await executor.rows<{ monitor_id: string }>(
        sql`INSERT INTO ${outages} (${column("monitor_id")}, ${column("started_at")}, ${column("ended_at")}, ${column("reason")}) SELECT ${monitors.id}, ${startedAt}, NULL, ${reason} FROM ${monitors} WHERE ${monitors.id} = ${monitorId} AND ${monitors.paused} = 0 AND ${monitors.updatedAt} <= ${startedAt} AND NOT EXISTS (SELECT 1 FROM ${outages} WHERE ${outages.monitorId} = ${monitorId} AND ${outages.endedAt} IS NULL) RETURNING ${outages.monitorId} AS monitor_id`
      );
      return rows.length === 1;
    },
  };
}

function outageOf(row: OutageRow): Outage {
  if (!reasonName(row.reason)) {
    throw new OutageShapeError(row.monitor_id, row.started_at);
  }
  return {
    acknowledgedAt: row.acknowledged_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    monitorId: row.monitor_id,
    reason: row.reason as ReasonCode,
    startedAt: row.started_at,
  };
}

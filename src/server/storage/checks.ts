/**
 * The checks repository (CONTEXT.md "Check", "Head table", "Sealed day",
 * "Rollup", "Failure detail", "Capture"): the head table
 * holds the open UTC day's checks as plain rows keyed by monitor and
 * started-at; sealing moves each closed day of a monitor into one sealed day
 * and writes that day's rollups. Every read of check history merges the
 * head rows and the sealed days at the day boundary. The failure detail and
 * the capture sit in their own tables under the check's key and outlive the
 * head row through the raw window. Rows never leave this file.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { RetentionBounds } from "@/shared/domain/retention.ts";
import { bucketsOf, rollupsOfDay } from "@/shared/domain/rollup.ts";
import {
  type CheckCoverage,
  coverageOf,
  type Span,
} from "@/shared/domain/uptime.ts";
import {
  type Capture,
  type Check,
  type CheckOutcome,
  captureHeadersSchema,
  type FailureDetail,
  failureDetailAssertionSchema,
  failureDetailParamsSchema,
  resultCode,
  resultOf,
} from "@/shared/schemas/check.ts";
import type { ChartTier, ResponseBucket } from "@/shared/schemas/detail.ts";
import { type ReasonCode, reasonName } from "@/shared/schemas/reason.ts";
import {
  type Rollup,
  type RollupSpan,
  rollupSpanMs,
} from "@/shared/schemas/rollup.ts";
import {
  type ChunkColumns,
  ChunkFormatError,
  checkAt,
  decodeChunk,
  encodeChunk,
} from "./chunk.ts";
import type { Executor } from "./connection.ts";

/** The three tiers of check history, in the order a size-budget delete takes them: raw days first, then hourly rollups, then daily rollups. */
export const historyTiers = ["raw", "hourly", "daily"] as const;
export type HistoryTier = (typeof historyTiers)[number];

/** What one size-budget delete took: one UTC day of one tier, across every monitor. */
export interface DroppedDay {
  /** The day's start, UTC milliseconds. */
  readonly day: number;
  /** The rows it deleted, every table counted. */
  readonly rows: number;
  readonly tier: HistoryTier;
}

/** A closed UTC day of one monitor that still has head rows. */
export interface UnsealedDay {
  /** The day's start, UTC milliseconds. */
  readonly day: number;
  readonly monitorId: string;
}

export interface ChecksRepository {
  /** The capture of one check, or nothing. */
  capture: (
    monitorId: string,
    startedAt: number
  ) => Promise<Capture | undefined>;
  /** The first and last check of one monitor with `from <= startedAt < to`, head rows and sealed days alike, and every gap between two consecutive ones longer than `longerThanMs`; nothing without a check. */
  coverage: (
    monitorId: string,
    from: number,
    to: number,
    longerThanMs: number
  ) => Promise<CheckCoverage | undefined>;
  /** The UTC days one monitor has checks on with `from <= day < to`, sealed or in the head, oldest first; `from` is a UTC day's start. */
  days: (monitorId: string, from: number, to: number) => Promise<number[]>;
  /** The failure detail of one check, or nothing. */
  detail: (
    monitorId: string,
    startedAt: number
  ) => Promise<FailureDetail | undefined>;
  /**
   * Deletes the oldest UTC day of history before `before` across every
   * monitor, from the first tier that has one (`historyTiers`): a raw day is
   * its sealed days, its head rows, and every failure detail and capture up
   * to its end. Nothing from `before` on is touched, nor any outage.
   * Answers what it took, or nothing when no tier has a day before `before`.
   */
  dropOldest: (before: number) => Promise<DroppedDay | undefined>;
  /** The newest check of every monitor that has one; the most frequent read. It reads the head, and a sealed day only for a monitor with no head row. */
  latest: () => Promise<Check[]>;
  /**
   * Deletes one monitor's history past its retention as one transaction:
   * sealed days, head rows, failure details and captures before `raw`,
   * hourly rollups before `hourly`, daily rollups before `daily`. Answers
   * how many rows it deleted.
   */
  purge: (monitorId: string, bounds: RetentionBounds) => Promise<number>;
  /** The checks of one monitor with `from <= startedAt < to`, oldest first. */
  range: (monitorId: string, from: number, to: number) => Promise<Check[]>;
  /** The checks of many monitors, each from its own start in `from` to `to`, oldest first, by monitor id: one read for all, so a list's bars cost no round trip per monitor. A monitor with none is left out. */
  ranges: (
    from: ReadonlyMap<string, number>,
    to: number
  ) => Promise<Map<string, Check[]>>;
  /** The newest checks of one monitor, newest first, at most `limit`. */
  recent: (monitorId: string, limit: number) => Promise<Check[]>;
  /** Stores a check with its detail and capture as one write. */
  record: (outcome: CheckOutcome) => Promise<void>;
  /** The rollups of one monitor over one span with `from <= at < to`, oldest first. */
  rollups: (
    monitorId: string,
    span: RollupSpan,
    from: number,
    to: number
  ) => Promise<Rollup[]>;
  /** The rollups of many monitors over one span with `from <= at < to`, oldest first, by monitor id, in one read. A monitor with none is left out. */
  rollupsOf: (
    monitorIds: readonly string[],
    span: RollupSpan,
    from: number,
    to: number
  ) => Promise<Map<string, Rollup[]>>;
  /**
   * Seals one closed UTC day of one monitor as one transaction: the day's
   * head rows leave the head and join whatever the day already sealed, and
   * the sealed day and the day's hourly and daily rollups are written from
   * them, with the spans maintenance windows covered the monitor left out
   * of its observed time; the transaction commits all of it or none. Safe
   * to rerun. Answers how many checks the sealed day holds.
   */
  seal: (
    monitorId: string,
    day: number,
    gapLimitMs: number,
    excluded: readonly Span[]
  ) => Promise<number>;
  /** The checks of one monitor with `from <= startedAt < to` summed into buckets of `bucketMs` from `from`, oldest first, a bucket without a check left out: from every check on the raw tier, and on the hourly tier from the hourly rollups where a day is sealed. */
  series: (
    monitorId: string,
    from: number,
    to: number,
    bucketMs: number,
    tier: ChartTier
  ) => Promise<ResponseBucket[]>;
  /** Every monitor's days before `before` that still have head rows, oldest first. */
  unsealed: (before: number) => Promise<UnsealedDay[]>;
}

/** Thrown by a read when a stored detail or capture no longer fits its schema; the message names the check, never the text. */
export class CheckShapeError extends Error {
  readonly monitorId: string;
  readonly startedAt: number;
  constructor(monitorId: string, startedAt: number) {
    super(
      `the stored record of the check ${monitorId} at ${startedAt} does not fit its schema`
    );
    this.name = "CheckShapeError";
    this.monitorId = monitorId;
    this.startedAt = startedAt;
  }
}

/** A head row as the driver answers it. */
interface CheckRow {
  attempts: number;
  bytes: number;
  monitor_id: string;
  reason: number;
  response_ms: number | null;
  result: number;
  started_at: number;
  status_code: number | null;
}

interface DetailRow {
  assertion: string | null;
  error: string | null;
  params: string;
}

interface CaptureRow {
  body: Uint8Array;
  headers: string;
}

/** A sealed day as the driver answers it. */
interface SealedRow {
  chunk: Uint8Array;
  day: number;
  monitor_id: string;
}

/** A rollup as the driver answers it. */
interface RollupRow {
  at: number;
  average_ms: number | null;
  checks: number;
  degraded: number;
  failed: number;
  max_ms: number | null;
  min_ms: number | null;
  monitor_id: string;
  observed_ms: number;
}

const dayMs = rollupSpanMs.day;

/** The monitors one read of `ranges` takes: SQLite's expression depth is 1000, and each adds one OR. */
const rangesPerRead = 250;

/** The start of the UTC day `at` falls in. */
function dayOf(at: number): number {
  return Math.floor(at / dayMs) * dayMs;
}

export function checksRepository(executor: Executor): ChecksRepository {
  const {
    captures,
    checks,
    dailyRollups,
    failureDetails,
    hourlyRollups,
    monitors,
    sealedDays,
  } = executor.tables;
  const columns = sql`${checks.monitorId} AS monitor_id, ${checks.startedAt} AS started_at, ${checks.result} AS result, ${checks.responseMs} AS response_ms, ${checks.statusCode} AS status_code, ${checks.reason} AS reason, ${checks.attempts} AS attempts, ${checks.bytes} AS bytes`;
  // RETURNING names the modified table's columns bare, which both dialects accept.
  const returned = sql`${sql.identifier("monitor_id")}, ${sql.identifier("started_at")}, ${sql.identifier("result")}, ${sql.identifier("response_ms")}, ${sql.identifier("status_code")}, ${sql.identifier("reason")}, ${sql.identifier("attempts")}, ${sql.identifier("bytes")}`;
  const sealedColumns = sql`${sealedDays.monitorId} AS monitor_id, ${sealedDays.day} AS ${sql.identifier("day")}, ${sealedDays.chunk} AS chunk`;

  /** One monitor's head rows with `from <= startedAt < to`, oldest first. */
  const headRange = async (
    run: Executor,
    monitorId: string,
    from: number,
    to: number
  ): Promise<Check[]> =>
    (
      await run.rows<CheckRow>(
        sql`SELECT ${columns} FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} >= ${from} AND ${checks.startedAt} < ${to} ORDER BY ${checks.startedAt}`
      )
    ).map(checkOf);

  /** One monitor's sealed days with `from <= day < to`, oldest first, still packed. */
  const sealedRange = (
    run: Executor,
    monitorId: string,
    from: number,
    to: number
  ): Promise<SealedRow[]> =>
    run.rows<SealedRow>(
      sql`SELECT ${sealedColumns} FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} >= ${from} AND ${sealedDays.day} < ${to} ORDER BY ${sealedDays.day}`
    );

  /** The checks of a few monitors, each from its own start to `to`, from their sealed days and head rows, oldest first, each once. */
  const mergedOf = async (
    from: readonly (readonly [string, number])[],
    to: number
  ): Promise<Map<string, Check[]>> => {
    const ranges = (
      monitorId: SQLWrapper,
      at: SQLWrapper,
      start: (at: number) => number
    ) =>
      sql.join(
        from.map(
          ([id, each]) =>
            sql`(${monitorId} = ${id} AND ${at} >= ${start(each)})`
        ),
        sql` OR `
      );
    // The head first: a day sealed between the two reads is then read twice and kept once, never missed.
    const head = await executor.rows<CheckRow>(
      sql`SELECT ${columns} FROM ${checks} WHERE (${ranges(checks.monitorId, checks.startedAt, (at) => at)}) AND ${checks.startedAt} < ${to}`
    );
    const sealed = await executor.rows<SealedRow>(
      sql`SELECT ${sealedColumns} FROM ${sealedDays} WHERE (${ranges(sealedDays.monitorId, sealedDays.day, dayOf)}) AND ${sealedDays.day} < ${to}`
    );
    const starts = new Map(from);
    const read = new Map<string, { head: Check[]; sealed: Check[] }>();
    const of = (id: string) => {
      let lists = read.get(id);
      if (!lists) {
        lists = { head: [], sealed: [] };
        read.set(id, lists);
      }
      return lists;
    };
    for (const row of sealed) {
      const start = starts.get(row.monitor_id) ?? to;
      const list = of(row.monitor_id).sealed;
      const day = columnsOf(row);
      // Only the checks in range become objects: a day read for a few minutes before its end holds thousands.
      day.startedAt.forEach((at, index) => {
        if (at < start || at >= to) {
          return;
        }
        const check = checkAt(day, index, row.monitor_id);
        if (!check) {
          throw new CheckShapeError(row.monitor_id, at);
        }
        list.push(check);
      });
    }
    for (const row of head) {
      of(row.monitor_id).head.push(checkOf(row));
    }
    const merged = new Map<string, Check[]>();
    for (const [id, lists] of read) {
      const each = union(lists.sealed, lists.head);
      if (each.length > 0) {
        merged.set(id, each);
      }
    }
    return merged;
  };

  /** The rollups of many monitors over one span with `from <= at < to`, oldest first, by monitor id. */
  const rollupsOf = async (
    monitorIds: readonly string[],
    span: RollupSpan,
    from: number,
    to: number
  ): Promise<Map<string, Rollup[]>> => {
    const read = new Map<string, Rollup[]>();
    if (monitorIds.length === 0) {
      return read;
    }
    const table = span === "hour" ? hourlyRollups : dailyRollups;
    const at = span === "hour" ? hourlyRollups.hour : dailyRollups.day;
    const rows = await executor.rows<RollupRow>(
      sql`SELECT ${table.monitorId} AS monitor_id, ${at} AS ${sql.identifier("at")}, ${table.checks} AS checks, ${table.observedMs} AS observed_ms, ${table.averageMs} AS average_ms, ${table.minMs} AS min_ms, ${table.maxMs} AS max_ms, ${table.failed} AS failed, ${table.degraded} AS degraded FROM ${table} WHERE ${table.monitorId} IN (${sql.join(
        monitorIds.map((id) => sql`${id}`),
        sql`, `
      )}) AND ${at} >= ${from} AND ${at} < ${to} ORDER BY ${table.monitorId}, ${at}`
    );
    for (const row of rows) {
      const list = read.get(row.monitor_id) ?? [];
      list.push(rollupOfRow(row));
      read.set(row.monitor_id, list);
    }
    return read;
  };

  /** The checks of one monitor with `from <= startedAt < to` from its sealed days and head rows, oldest first, each once. */
  const merged = async (
    monitorId: string,
    from: number,
    to: number
  ): Promise<Check[]> =>
    (await mergedOf([[monitorId, from]], to)).get(monitorId) ?? [];

  return {
    capture: async (monitorId, startedAt) => {
      const [row] = await executor.rows<CaptureRow>(
        sql`SELECT ${captures.headers} AS headers, ${captures.body} AS body FROM ${captures} WHERE ${captures.monitorId} = ${monitorId} AND ${captures.startedAt} = ${startedAt}`
      );
      if (!row) {
        return;
      }
      const headers = captureHeadersSchema.safeParse(parseJson(row.headers));
      if (!headers.success) {
        throw new CheckShapeError(monitorId, startedAt);
      }
      return {
        body: new Uint8Array(row.body),
        headers: headers.data,
        monitorId,
        startedAt,
      };
    },
    days: async (monitorId, from, to) => {
      const day = sql`(${checks.startedAt} / CAST(${dayMs} AS BIGINT)) * CAST(${dayMs} AS BIGINT)`;
      const rows = await executor.rows<{ day: number }>(
        sql`SELECT ${sealedDays.day} AS ${sql.identifier("day")} FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} >= ${from} AND ${sealedDays.day} < ${to} UNION SELECT ${day} FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} >= ${from} AND ${checks.startedAt} < ${to} ORDER BY 1`
      );
      return rows.map((row) => Number(row.day));
    },
    coverage: async (monitorId, from, to, longerThanMs) => {
      // The head first, as in `merged`: a time read twice is one check to `coverageOf`.
      const head = await executor.rows<{ started_at: number }>(
        sql`SELECT ${checks.startedAt} AS started_at FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} >= ${from} AND ${checks.startedAt} < ${to}`
      );
      const sealed = await sealedRange(executor, monitorId, dayOf(from), to);
      // Only the times, in one typed array: a month of a 20 s monitor is about a megabyte.
      const days = sealed.map((row) => columnsOf(row).startedAt);
      const times = new Float64Array(
        days.reduce((sum, day) => sum + day.length, head.length)
      );
      let length = 0;
      for (const day of days) {
        for (const at of day) {
          if (at >= from && at < to) {
            times[length] = at;
            length += 1;
          }
        }
      }
      for (const row of head) {
        times[length] = row.started_at;
        length += 1;
      }
      return coverageOf(times.subarray(0, length).sort(), longerThanMs);
    },
    detail: async (monitorId, startedAt) => {
      const [row] = await executor.rows<DetailRow>(
        sql`SELECT ${failureDetails.assertion} AS assertion, ${failureDetails.params} AS params, ${failureDetails.error} AS error FROM ${failureDetails} WHERE ${failureDetails.monitorId} = ${monitorId} AND ${failureDetails.startedAt} = ${startedAt}`
      );
      if (!row) {
        return;
      }
      const params = failureDetailParamsSchema.safeParse(parseJson(row.params));
      const assertion =
        row.assertion === null
          ? undefined
          : failureDetailAssertionSchema.safeParse(parseJson(row.assertion));
      if (!(params.success && (assertion === undefined || assertion.success))) {
        throw new CheckShapeError(monitorId, startedAt);
      }
      return {
        assertion: assertion?.data,
        error: row.error ?? undefined,
        monitorId,
        params: params.data,
        startedAt,
      };
    },
    latest: async () => {
      // Driven from the monitors table through a row-value IN, so both planners loop over the monitors and seek the key once each, never scanning the head table (probed with EXPLAIN on both).
      const head = (
        await executor.rows<CheckRow>(
          sql`SELECT ${columns} FROM ${checks} WHERE (${checks.monitorId}, ${checks.startedAt}) IN (SELECT ${monitors.id}, (SELECT MAX(${sql.identifier("started_at")}) FROM ${checks} AS ${sql.identifier("newest")} WHERE ${sql.identifier("newest")}.${sql.identifier("monitor_id")} = ${monitors.id}) FROM ${monitors})`
        )
      ).map(checkOf);
      // A monitor with no head row after its newest sealed day (paused, or not yet checked today) reads that day's last check too, and the newer of the two stands.
      const sealed = await executor.rows<SealedRow>(
        sql`SELECT ${sealedColumns} FROM ${sealedDays} WHERE ${sealedDays.day} = (SELECT MAX(${sql.identifier("day")}) FROM ${sealedDays} AS ${sql.identifier("newest")} WHERE ${sql.identifier("newest")}.${sql.identifier("monitor_id")} = ${sealedDays.monitorId}) AND NOT EXISTS (SELECT 1 FROM ${checks} WHERE ${checks.monitorId} = ${sealedDays.monitorId} AND ${checks.startedAt} >= ${sealedDays.day} + CAST(${dayMs} AS BIGINT))`
      );
      const newest = new Map(head.map((check) => [check.monitorId, check]));
      for (const check of sealed.flatMap((row) => checksOfDay(row).slice(-1))) {
        const seen = newest.get(check.monitorId);
        if (!seen || seen.startedAt < check.startedAt) {
          newest.set(check.monitorId, check);
        }
      }
      return [...newest.values()];
    },
    dropOldest: (before) =>
      executor.transaction(async (tx) => {
        const oldest = async (query: SQL): Promise<number | undefined> => {
          const [row] = await tx.rows<{ at: number | null }>(query);
          return row?.at === null || row?.at === undefined
            ? undefined
            : dayOf(Number(row.at));
        };
        const sealed = await oldest(
          sql`SELECT MIN(${sealedDays.day}) AS ${sql.identifier("at")} FROM ${sealedDays} WHERE ${sealedDays.day} < ${before}`
        );
        const head = await oldest(
          sql`SELECT MIN(${checks.startedAt}) AS ${sql.identifier("at")} FROM ${checks} WHERE ${checks.startedAt} < ${before}`
        );
        const rawDays = [sealed, head].filter((day) => day !== undefined);
        if (rawDays.length > 0) {
          const raw = Math.min(...rawDays);
          // Everything up to the day's end: the details and captures of days already gone go with it.
          const end = raw + dayMs;
          let rows = await tx.run(
            sql`DELETE FROM ${sealedDays} WHERE ${sealedDays.day} < ${end}`
          );
          for (const table of [checks, failureDetails, captures]) {
            // biome-ignore lint/performance/noAwaitInLoops: one statement at a time, a transaction holds one connection
            rows += await tx.run(
              sql`DELETE FROM ${table} WHERE ${table.startedAt} < ${end}`
            );
          }
          return { day: raw, rows, tier: "raw" };
        }
        const hour = await oldest(
          sql`SELECT MIN(${hourlyRollups.hour}) AS ${sql.identifier("at")} FROM ${hourlyRollups} WHERE ${hourlyRollups.hour} < ${before}`
        );
        if (hour !== undefined) {
          const rows = await tx.run(
            sql`DELETE FROM ${hourlyRollups} WHERE ${hourlyRollups.hour} < ${Math.min(hour + dayMs, before)}`
          );
          return { day: hour, rows, tier: "hourly" };
        }
        const daily = await oldest(
          sql`SELECT MIN(${dailyRollups.day}) AS ${sql.identifier("at")} FROM ${dailyRollups} WHERE ${dailyRollups.day} < ${before}`
        );
        if (daily === undefined) {
          return;
        }
        const rows = await tx.run(
          sql`DELETE FROM ${dailyRollups} WHERE ${dailyRollups.day} = ${daily}`
        );
        return { day: daily, rows, tier: "daily" };
      }),
    purge: (monitorId, bounds) =>
      executor.transaction(async (tx) => {
        const statements = [
          sql`DELETE FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} < ${bounds.raw}`,
          ...[checks, failureDetails, captures].map(
            (table) =>
              sql`DELETE FROM ${table} WHERE ${table.monitorId} = ${monitorId} AND ${table.startedAt} < ${bounds.raw}`
          ),
          sql`DELETE FROM ${hourlyRollups} WHERE ${hourlyRollups.monitorId} = ${monitorId} AND ${hourlyRollups.hour} < ${bounds.hourly}`,
          sql`DELETE FROM ${dailyRollups} WHERE ${dailyRollups.monitorId} = ${monitorId} AND ${dailyRollups.day} < ${bounds.daily}`,
        ];
        let rows = 0;
        for (const statement of statements) {
          // biome-ignore lint/performance/noAwaitInLoops: one statement at a time, a transaction holds one connection
          rows += await tx.run(statement);
        }
        return rows;
      }),
    range: merged,
    recent: async (monitorId, limit) => {
      const head = (
        await executor.rows<CheckRow>(
          sql`SELECT ${columns} FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} ORDER BY ${checks.startedAt} DESC LIMIT ${limit}`
        )
      ).map(checkOf);
      const sealed: Check[] = [];
      if (head.length < limit) {
        const days = await executor.rows<{ day: number }>(
          sql`SELECT ${sealedDays.day} AS ${sql.identifier("day")} FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} ORDER BY ${sealedDays.day} DESC`
        );
        // Newest day first, one chunk at a time, until the head and the days hold enough.
        for (const { day } of days) {
          if (head.length + sealed.length >= limit) {
            break;
          }
          // biome-ignore lint/performance/noAwaitInLoops: one chunk at a time, only as far back as needed
          const [row] = await sealedRange(executor, monitorId, day, day + 1);
          sealed.push(...(row ? checksOfDay(row) : []));
        }
      }
      return union(sealed, head).toReversed().slice(0, limit);
    },
    record: ({ capture, check, detail }) =>
      executor.transaction(async (tx) => {
        await tx.run(
          sql`INSERT INTO ${checks} (${sql.identifier("monitor_id")}, ${sql.identifier("started_at")}, ${sql.identifier("result")}, ${sql.identifier("response_ms")}, ${sql.identifier("status_code")}, ${sql.identifier("reason")}, ${sql.identifier("attempts")}, ${sql.identifier("bytes")}) VALUES (${check.monitorId}, ${check.startedAt}, ${resultCode(check.result)}, ${check.responseMs ?? null}, ${check.statusCode ?? null}, ${check.reason}, ${check.attempts}, ${check.bytes})`
        );
        if (detail) {
          await tx.run(
            sql`INSERT INTO ${failureDetails} (${sql.identifier("monitor_id")}, ${sql.identifier("started_at")}, ${sql.identifier("assertion")}, ${sql.identifier("params")}, ${sql.identifier("error")}) VALUES (${detail.monitorId}, ${detail.startedAt}, ${detail.assertion === undefined ? null : JSON.stringify(detail.assertion)}, ${JSON.stringify(detail.params)}, ${detail.error ?? null})`
          );
        }
        if (capture) {
          await tx.run(
            sql`INSERT INTO ${captures} (${sql.identifier("monitor_id")}, ${sql.identifier("started_at")}, ${sql.identifier("headers")}, ${sql.identifier("body")}) VALUES (${capture.monitorId}, ${capture.startedAt}, ${JSON.stringify(capture.headers)}, ${capture.body})`
          );
        }
      }),
    ranges: async (from, to) => {
      const all = [...from];
      const read = new Map<string, Check[]>();
      for (let index = 0; index < all.length; index += rangesPerRead) {
        // biome-ignore lint/performance/noAwaitInLoops: one batch after another holds one connection, not the pool
        const batch = await mergedOf(
          all.slice(index, index + rangesPerRead),
          to
        );
        for (const [id, each] of batch) {
          read.set(id, each);
        }
      }
      return read;
    },
    rollups: async (monitorId, span, from, to) =>
      (await rollupsOf([monitorId], span, from, to)).get(monitorId) ?? [],
    rollupsOf: (monitorIds, span, from, to) =>
      rollupsOf(monitorIds, span, from, to),
    seal: (monitorId, day, gapLimitMs, excluded) =>
      executor.transaction(async (tx) => {
        const end = day + dayMs;
        // The head rows are taken out first and exactly these are sealed: a check written into the day meanwhile stays in the head for the next pass. One statement at a time: a transaction holds one connection.
        const head = (
          await tx.rows<CheckRow>(
            sql`DELETE FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} >= ${day} AND ${checks.startedAt} < ${end} RETURNING ${returned}`
          )
        ).map(checkOf);
        const [existing] = await sealedRange(tx, monitorId, day, day + 1);
        const sealed = union(existing ? checksOfDay(existing) : [], head);
        if (sealed.length === 0) {
          return 0;
        }
        const before = await neighbour(tx, monitorId, day, "before");
        const after = await neighbour(tx, monitorId, end, "after");
        const { daily, hourly } = rollupsOfDay({
          after,
          before,
          checks: sealed,
          day,
          excluded,
          gapLimitMs,
          monitorId,
        });
        const chunk = encodeChunk(day, sealed);
        await tx.run(
          sql`DELETE FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} = ${day}`
        );
        await tx.run(
          sql`INSERT INTO ${sealedDays} (${sql.identifier("monitor_id")}, ${sql.identifier("day")}, ${sql.identifier("checks")}, ${sql.identifier("observed_ms")}, ${sql.identifier("chunk")}) VALUES (${monitorId}, ${day}, ${sealed.length}, ${daily.observedMs}, ${chunk})`
        );
        await tx.run(
          sql`DELETE FROM ${hourlyRollups} WHERE ${hourlyRollups.monitorId} = ${monitorId} AND ${hourlyRollups.hour} >= ${day} AND ${hourlyRollups.hour} < ${end}`
        );
        if (hourly.length > 0) {
          await tx.run(
            sql`INSERT INTO ${hourlyRollups} (${rollupColumns("hour")}) VALUES ${sql.join(hourly.map(rollupValues), sql`, `)}`
          );
        }
        await tx.run(
          sql`DELETE FROM ${dailyRollups} WHERE ${dailyRollups.monitorId} = ${monitorId} AND ${dailyRollups.day} = ${day}`
        );
        await tx.run(
          sql`INSERT INTO ${dailyRollups} (${rollupColumns("day")}) VALUES ${rollupValues(daily)}`
        );
        return sealed.length;
      }),
    series: async (monitorId, from, to, bucketMs, tier) => {
      if (tier === "raw") {
        return bucketsOf({
          bucketMs,
          checks: await merged(monitorId, from, to),
          from,
          rollups: [],
          to,
        });
      }
      // A sealed day is in the hourly rollups; the head holds the days not sealed yet.
      // The head first: a day sealed between the two reads is counted twice for this one read rather than missed.
      const head = await headRange(executor, monitorId, from, to);
      const rollups = await executor.rows<RollupRow>(
        sql`SELECT ${hourlyRollups.monitorId} AS monitor_id, ${hourlyRollups.hour} AS ${sql.identifier("at")}, ${hourlyRollups.checks} AS checks, ${hourlyRollups.observedMs} AS observed_ms, ${hourlyRollups.averageMs} AS average_ms, ${hourlyRollups.minMs} AS min_ms, ${hourlyRollups.maxMs} AS max_ms, ${hourlyRollups.failed} AS failed, ${hourlyRollups.degraded} AS degraded FROM ${hourlyRollups} WHERE ${hourlyRollups.monitorId} = ${monitorId} AND ${hourlyRollups.hour} >= ${from} AND ${hourlyRollups.hour} < ${to}`
      );
      return bucketsOf({
        bucketMs,
        checks: head,
        from,
        rollups: rollups.map(rollupOfRow),
        to,
      });
    },
    unsealed: async (before) => {
      const day = sql`(${checks.startedAt} / CAST(${dayMs} AS BIGINT)) * CAST(${dayMs} AS BIGINT)`;
      const rows = await executor.rows<{ day: number; monitor_id: string }>(
        sql`SELECT ${checks.monitorId} AS monitor_id, ${day} AS ${sql.identifier("day")} FROM ${checks} WHERE ${checks.startedAt} < ${before} GROUP BY ${checks.monitorId}, ${sql.identifier("day")} ORDER BY ${sql.identifier("day")}, ${checks.monitorId}`
      );
      return rows.map((row) => ({
        day: Number(row.day),
        monitorId: row.monitor_id,
      }));
    },
  };

  /** The monitor's last check before `at`, or its first check from `at` on, head rows and sealed days alike. */
  async function neighbour(
    run: Executor,
    monitorId: string,
    at: number,
    side: "before" | "after"
  ): Promise<number | undefined> {
    const [head] = await run.rows<{ started_at: number | null }>(
      side === "before"
        ? sql`SELECT MAX(${checks.startedAt}) AS started_at FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} < ${at}`
        : sql`SELECT MIN(${checks.startedAt}) AS started_at FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} >= ${at}`
    );
    const [row] = await run.rows<SealedRow>(
      side === "before"
        ? sql`SELECT ${sealedColumns} FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} < ${at} ORDER BY ${sealedDays.day} DESC LIMIT 1`
        : sql`SELECT ${sealedColumns} FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} >= ${at} ORDER BY ${sealedDays.day} LIMIT 1`
    );
    const times = row ? columnsOf(row).startedAt : undefined;
    const sealed = side === "before" ? times?.at(-1) : times?.[0];
    const candidates = [head?.started_at ?? undefined, sealed].filter(
      (time): time is number => time !== undefined
    );
    if (candidates.length === 0) {
      return;
    }
    return side === "before"
      ? Math.max(...candidates)
      : Math.min(...candidates);
  }

  function rollupColumns(span: RollupSpan) {
    return sql`${sql.identifier("monitor_id")}, ${sql.identifier(span)}, ${sql.identifier("checks")}, ${sql.identifier("observed_ms")}, ${sql.identifier("average_ms")}, ${sql.identifier("min_ms")}, ${sql.identifier("max_ms")}, ${sql.identifier("failed")}, ${sql.identifier("degraded")}`;
  }
}

function rollupValues(rollup: Rollup) {
  return sql`(${rollup.monitorId}, ${rollup.at}, ${rollup.checks}, ${rollup.observedMs}, ${rollup.averageMs ?? null}, ${rollup.minMs ?? null}, ${rollup.maxMs ?? null}, ${rollup.failed}, ${rollup.degraded})`;
}

function rollupOfRow(row: RollupRow): Rollup {
  return {
    at: Number(row.at),
    averageMs: row.average_ms ?? undefined,
    checks: row.checks,
    degraded: row.degraded,
    failed: row.failed,
    maxMs: row.max_ms ?? undefined,
    minMs: row.min_ms ?? undefined,
    monitorId: row.monitor_id,
    observedMs: row.observed_ms,
  };
}

/** A sealed day's chunk as columns; bytes this version cannot read name the monitor and the day. */
function columnsOf(row: SealedRow): ChunkColumns {
  let columns: ChunkColumns | undefined;
  try {
    columns = decodeChunk(Number(row.day), row.chunk);
  } catch (error) {
    if (!(error instanceof ChunkFormatError)) {
      throw error;
    }
  }
  if (!columns) {
    throw new CheckShapeError(row.monitor_id, Number(row.day));
  }
  return columns;
}

/** Every check of a sealed day, oldest first. */
function checksOfDay(row: SealedRow): Check[] {
  const columns = columnsOf(row);
  return Array.from(columns.startedAt, (startedAt, index) => {
    const check = checkAt(columns, index, row.monitor_id);
    if (!check) {
      throw new CheckShapeError(row.monitor_id, startedAt);
    }
    return check;
  });
}

/** Two lists of one monitor's checks as one, oldest first; a check in both is kept once, the later list's copy. */
function union(first: readonly Check[], second: readonly Check[]): Check[] {
  const byTime = new Map<number, Check>();
  for (const check of [...first, ...second]) {
    byTime.set(check.startedAt, check);
  }
  return [...byTime.values()].toSorted((a, b) => a.startedAt - b.startedAt);
}

function checkOf(row: CheckRow): Check {
  const result = resultOf(row.result);
  if (!(result && reasonName(row.reason))) {
    throw new CheckShapeError(row.monitor_id, row.started_at);
  }
  return {
    attempts: row.attempts,
    bytes: row.bytes,
    monitorId: row.monitor_id,
    reason: row.reason as ReasonCode,
    responseMs: row.response_ms ?? undefined,
    result,
    startedAt: row.started_at,
    statusCode: row.status_code ?? undefined,
  };
}

/** Parsed JSON, or nothing for text that is not JSON; the schema decides after. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller's schema refuses `undefined` and names the check.
  }
}

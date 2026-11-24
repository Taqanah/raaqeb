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
  checkResults,
  type FailureDetail,
  failureDetailAssertionSchema,
  failureDetailParamsSchema,
  resultCode,
  resultOf,
} from "@/shared/schemas/check.ts";
import type { ChartTier, ResponseBucket } from "@/shared/schemas/detail.ts";
import {
  type ReasonCode,
  reasonName,
  reasons,
} from "@/shared/schemas/reason.ts";
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

/** What one monitor's read of `summaries` asks. */
export interface SummaryRead {
  /** The UTC day the day tallies start at; the coverage reads from `limitMs` before it, so a check just before covers its start. */
  readonly from: number;
  /** The gap limit: a gap between two consecutive checks longer than this is no data. */
  readonly limitMs: number;
}

/** A UTC day's checks summed: how many, how many degraded and down, and the response times of the others. */
export interface DayTally {
  readonly checks: number;
  readonly degraded: number;
  readonly down: number;
  /** How many response times `totalMs` sums. */
  readonly timed: number;
  readonly totalMs: number;
}

/** What a monitor's checks say over a read, without a row per check. */
export interface CheckSummary {
  readonly coverage: CheckCoverage | undefined;
  /** The days from the read's `from` on that have a check, by UTC day start. */
  readonly days: ReadonlyMap<number, DayTally>;
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
  /** The newest checks of one monitor, newest first, at most `limit`; with a span, only those with `from <= startedAt < to`. */
  recent: (monitorId: string, limit: number, span?: Span) => Promise<Check[]>;
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
  /**
   * The coverage and the day tallies of many monitors up to `to`, by monitor
   * id, summed where the checks are: the head rows are never read one by
   * one, so a list's bars cost no memory per check. Same answer as reading
   * each monitor's checks from `ranges` and summing them. A monitor with no
   * check is left out.
   */
  summaries: (
    reads: ReadonlyMap<string, SummaryRead>,
    to: number
  ) => Promise<Map<string, CheckSummary>>;
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

/** One monitor's head rows of one UTC day, summed, as the driver answers it; counts come back as numbers or, on Postgres, as text. */
interface TallyRow {
  check_count: number | string;
  day: number | string;
  degraded_count: number | string;
  down_count: number | string;
  first_at: number | string;
  last_at: number | string;
  monitor_id: string;
  timed_count: number | string;
  total_ms: number | string;
  /** The first check of the day with a result or reason code this version does not know; none when all are known. */
  unknown_at: number | string | null;
}

/** A head row that follows a gap, with the check before it, as the driver answers it. */
interface GapRow {
  monitor_id: string;
  prev_at: number | string | null;
  started_at: number | string;
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

  /** One condition per distinct value, holding for the monitors that have it: their ids in an IN, which both planners seek once per monitor, where an OR of one term per monitor costs a multi-index union or a long CASE per row. */
  const perValue = (
    monitorId: SQLWrapper,
    values: readonly (readonly [string, number])[],
    holds: (value: number) => SQL
  ) => {
    const ids = new Map<number, string[]>();
    for (const [id, value] of values) {
      ids.set(value, [...(ids.get(value) ?? []), id]);
    }
    return sql.join(
      [...ids].map(
        ([value, own]) =>
          sql`(${monitorId} IN (${sql.join(
            own.map((id) => sql`${id}`),
            sql`, `
          )}) AND ${holds(value)})`
      ),
      sql` OR `
    );
  };

  /** The monitors' own starts as one condition on a table's monitor and time columns. */
  const startsOf = (
    monitorId: SQLWrapper,
    at: SQLWrapper,
    starts: readonly (readonly [string, number])[]
  ) => perValue(monitorId, starts, (start) => sql`${at} >= ${start}`);

  /** The checks of a few monitors' sealed days, each from its own start to `to`, by monitor id. */
  const sealedChecksOf = async (
    from: readonly (readonly [string, number])[],
    to: number
  ): Promise<Map<string, Check[]>> => {
    const rows = await executor.rows<SealedRow>(
      sql`SELECT ${sealedColumns} FROM ${sealedDays} WHERE (${startsOf(
        sealedDays.monitorId,
        sealedDays.day,
        from.map(([id, start]) => [id, dayOf(start)])
      )}) AND ${sealedDays.day} < ${to}`
    );
    const starts = new Map(from);
    const read = new Map<string, Check[]>();
    for (const row of rows) {
      const start = starts.get(row.monitor_id) ?? to;
      const list = read.get(row.monitor_id) ?? [];
      read.set(row.monitor_id, list);
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
    return read;
  };

  /** The checks of a few monitors, each from its own start to `to`, from their sealed days and head rows, oldest first, each once. */
  const mergedOf = async (
    from: readonly (readonly [string, number])[],
    to: number
  ): Promise<Map<string, Check[]>> => {
    // The head first: a day sealed between the two reads is then read twice and kept once, never missed.
    const head = await executor.rows<CheckRow>(
      sql`SELECT ${columns} FROM ${checks} WHERE (${startsOf(checks.monitorId, checks.startedAt, from)}) AND ${checks.startedAt} < ${to}`
    );
    const sealed = await sealedChecksOf(from, to);
    const heads = new Map<string, Check[]>();
    for (const row of head) {
      const list = heads.get(row.monitor_id) ?? [];
      list.push(checkOf(row));
      heads.set(row.monitor_id, list);
    }
    const merged = new Map<string, Check[]>();
    for (const id of new Set([...sealed.keys(), ...heads.keys()])) {
      const each = union(sealed.get(id) ?? [], heads.get(id) ?? []);
      if (each.length > 0) {
        merged.set(id, each);
      }
    }
    return merged;
  };

  /** The checks of many monitors, each from its own start to `to`, one batch of monitors at a time. */
  const rangesOf = async (
    from: ReadonlyMap<string, number>,
    to: number
  ): Promise<Map<string, Check[]>> => {
    const all = [...from];
    const read = new Map<string, Check[]>();
    for (let index = 0; index < all.length; index += rangesPerRead) {
      // biome-ignore lint/performance/noAwaitInLoops: one batch after another holds one connection, not the pool
      const batch = await mergedOf(all.slice(index, index + rangesPerRead), to);
      for (const [id, each] of batch) {
        read.set(id, each);
      }
    }
    return read;
  };

  /** The checks that follow a gap, on SQLite, with the check before each: a check with none within its monitor's limit before it, the previous one looked up for those few rows alone. A `LAG` over every row ran twice as slow here, and the same `NOT EXISTS` is a hash anti join on Postgres, quadratic in the day's rows. */
  const gapEndsSqlite = (
    where: SQL,
    batch: readonly (readonly [string, SummaryRead])[]
  ): SQL => {
    const near = sql.identifier("near");
    const earlier = sql.identifier("earlier");
    const started = sql.identifier("started_at");
    const monitor = sql.identifier("monitor_id");
    const afterGap = perValue(
      checks.monitorId,
      batch.map(([id, read]) => [id, read.limitMs]),
      (limit) =>
        sql`NOT EXISTS (SELECT 1 FROM ${checks} AS ${near} WHERE ${near}.${monitor} = ${checks.monitorId} AND ${near}.${started} < ${checks.startedAt} AND ${near}.${started} >= ${checks.startedAt} - CAST(${limit} AS BIGINT))`
    );
    return sql`SELECT ${checks.monitorId} AS monitor_id, ${checks.startedAt} AS started_at, (SELECT MAX(${earlier}.${started}) FROM ${checks} AS ${earlier} WHERE ${earlier}.${monitor} = ${checks.monitorId} AND ${earlier}.${started} < ${checks.startedAt}) AS prev_at FROM ${checks} WHERE ${where} AND (${afterGap}) ORDER BY ${checks.monitorId}, ${checks.startedAt}`;
  };

  /** The same on Postgres: a `LAG` over the primary key's order, one ordered pass. */
  const gapEndsPostgres = (
    where: SQL,
    batch: readonly (readonly [string, SummaryRead])[]
  ): SQL => {
    const longer = perValue(
      sql`monitor_id`,
      batch.map(([id, read]) => [id, read.limitMs]),
      (limit) => sql`started_at - prev_at > CAST(${limit} AS BIGINT)`
    );
    return sql`SELECT monitor_id, prev_at, started_at FROM (SELECT ${checks.monitorId} AS monitor_id, ${checks.startedAt} AS started_at, LAG(${checks.startedAt}) OVER (PARTITION BY ${checks.monitorId} ORDER BY ${checks.startedAt}) AS prev_at FROM ${checks} WHERE ${where}) AS spaced WHERE prev_at IS NOT NULL AND (${longer}) ORDER BY monitor_id, started_at`;
  };

  /** The monitors' head rows of the batch summed: per UTC day the counts and the response times, and the gaps between consecutive checks longer than each monitor's limit. */
  const headSummariesOf = async (
    batch: readonly (readonly [string, SummaryRead])[],
    to: number
  ) => {
    const where = sql`(${startsOf(
      checks.monitorId,
      checks.startedAt,
      batch.map(([id, read]) => [id, read.from - read.limitMs])
    )}) AND ${checks.startedAt} < ${to}`;
    const day = sql`(${checks.startedAt} / CAST(${dayMs} AS BIGINT)) * CAST(${dayMs} AS BIGINT)`;
    const failed = resultCode("down");
    const slow = resultCode("degraded");
    // The head rows are never built one by one here, so a code this version does not know is found in the same scan.
    const unknown = sql`${checks.result} NOT IN (${sql.join(
      checkResults.map((result) => sql`${resultCode(result)}`),
      sql`, `
    )}) OR ${checks.reason} NOT IN (${sql.join(
      Object.values(reasons).map((code) => sql`${code}`),
      sql`, `
    )})`;
    const tallies = await executor.rows<TallyRow>(
      sql`SELECT ${checks.monitorId} AS monitor_id, ${day} AS ${sql.identifier("day")}, COUNT(*) AS check_count, SUM(CASE WHEN ${checks.result} = ${slow} THEN 1 ELSE 0 END) AS degraded_count, SUM(CASE WHEN ${checks.result} = ${failed} THEN 1 ELSE 0 END) AS down_count, COUNT(CASE WHEN ${checks.result} <> ${failed} THEN ${checks.responseMs} END) AS timed_count, COALESCE(SUM(CASE WHEN ${checks.result} <> ${failed} THEN ${checks.responseMs} END), 0) AS total_ms, MIN(${checks.startedAt}) AS first_at, MAX(${checks.startedAt}) AS last_at, MIN(CASE WHEN ${unknown} THEN ${checks.startedAt} END) AS unknown_at FROM ${checks} WHERE ${where} GROUP BY ${checks.monitorId}, ${sql.identifier("day")}`
    );
    const gaps = await executor.rows<GapRow>(
      executor.backend === "sqlite"
        ? gapEndsSqlite(where, batch)
        : gapEndsPostgres(where, batch)
    );
    return headSummaryOf(
      tallies,
      gaps,
      new Map(batch.map(([id, read]) => [id, read.from - read.limitMs]))
    );
  };

  /** The summaries of a batch of monitors: the head rows summed in the database, the sealed days' few checks near the start summed here. `before` is how many monitors the previous pass left apart. */
  const summarisedOf = async (
    batch: readonly (readonly [string, SummaryRead])[],
    to: number,
    before = Number.POSITIVE_INFINITY
  ): Promise<Map<string, CheckSummary>> => {
    // The head first, as in `mergedOf`.
    const head = await headSummariesOf(batch, to);
    const sealed = await sealedChecksOf(
      batch.map(([id, read]) => [id, read.from - read.limitMs]),
      to
    );
    // A monitor whose sealed days reach past its first head row (a closed day left unsealed while a later one was sealed, or a day sealed between the two reads) is apart: the head's sums can neither order nor dedupe them.
    const apart = new Map<string, SummaryRead>();
    const summaries = new Map<string, CheckSummary>();
    for (const [id, read] of batch) {
      const own = sealed.get(id) ?? [];
      const headed = head.get(id);
      if (headed && own.some((check) => check.startedAt >= headed.first)) {
        apart.set(id, read);
        continue;
      }
      const summary = summaryOf(own, headed, read);
      if (summary) {
        summaries.set(id, summary);
      }
    }
    if (apart.size === 0) {
      return summaries;
    }
    // A day sealed between the two reads has left the head by now: read those monitors again while each pass leaves fewer apart, and check by check only those it never settles.
    const settled =
      apart.size < before
        ? await summarisedOf([...apart], to, apart.size)
        : await checkedOf(apart, to);
    for (const [id, summary] of settled) {
      summaries.set(id, summary);
    }
    return summaries;
  };

  /** The summaries of a few monitors from their checks read one by one. */
  const checkedOf = async (
    reads: ReadonlyMap<string, SummaryRead>,
    to: number
  ): Promise<Map<string, CheckSummary>> => {
    const starts = new Map(
      [...reads].map(([id, read]) => [id, read.from - read.limitMs])
    );
    const summaries = new Map<string, CheckSummary>();
    for (const [id, each] of await rangesOf(starts, to)) {
      const read = reads.get(id);
      if (read) {
        summaries.set(id, {
          coverage: coverageOf(
            each.map((check) => check.startedAt),
            read.limitMs
          ),
          days: tallyDays(each, read.from),
        });
      }
    }
    return summaries;
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
      for (const check of sealed.flatMap((row) => lastCheckOfDay(row))) {
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
    recent: async (
      monitorId,
      limit,
      { from, to } = { from: 0, to: Number.MAX_SAFE_INTEGER }
    ) => {
      const head = (
        await executor.rows<CheckRow>(
          sql`SELECT ${columns} FROM ${checks} WHERE ${checks.monitorId} = ${monitorId} AND ${checks.startedAt} >= ${from} AND ${checks.startedAt} < ${to} ORDER BY ${checks.startedAt} DESC LIMIT ${limit}`
        )
      ).map(checkOf);
      const sealed: Check[] = [];
      if (head.length < limit) {
        const days = await executor.rows<{ day: number }>(
          sql`SELECT ${sealedDays.day} AS ${sql.identifier("day")} FROM ${sealedDays} WHERE ${sealedDays.monitorId} = ${monitorId} AND ${sealedDays.day} >= ${dayOf(from)} AND ${sealedDays.day} < ${to} ORDER BY ${sealedDays.day} DESC`
        );
        // Newest day first, one chunk at a time, until the head and the days hold enough.
        for (const { day } of days) {
          if (head.length + sealed.length >= limit) {
            break;
          }
          // biome-ignore lint/performance/noAwaitInLoops: one chunk at a time, only as far back as needed
          const [row] = await sealedRange(executor, monitorId, day, day + 1);
          sealed.push(
            ...(row ? checksOfDay(row) : []).filter(
              (check) => check.startedAt >= from && check.startedAt < to
            )
          );
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
    ranges: rangesOf,
    rollups: async (monitorId, span, from, to) =>
      (await rollupsOf([monitorId], span, from, to)).get(monitorId) ?? [],
    rollupsOf: (monitorIds, span, from, to) =>
      rollupsOf(monitorIds, span, from, to),
    seal: (monitorId, day, gapLimitMs, excluded) =>
      // Nothing in here may yield to the event loop: on SQLite a read outside it shares the connection and would find the day on neither side.
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
    summaries: async (reads, to) => {
      const all = [...reads];
      const read = new Map<string, CheckSummary>();
      for (let index = 0; index < all.length; index += rangesPerRead) {
        // biome-ignore lint/performance/noAwaitInLoops: one batch after another holds one connection, not the pool
        const batch = await summarisedOf(
          all.slice(index, index + rangesPerRead),
          to
        );
        for (const [id, each] of batch) {
          read.set(id, each);
        }
      }
      return read;
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

/** The last check of a sealed day, as a list of one: only it becomes an object, not the day's thousand. */
function lastCheckOfDay(row: SealedRow): Check[] {
  const columns = columnsOf(row);
  const index = columns.startedAt.length - 1;
  if (index < 0) {
    return [];
  }
  const check = checkAt(columns, index, row.monitor_id);
  if (!check) {
    throw new CheckShapeError(row.monitor_id, columns.startedAt[index] ?? 0);
  }
  return [check];
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

/** What a monitor's head rows say, summed in the database. */
interface HeadSummary {
  readonly days: Map<number, DayTally>;
  readonly first: number;
  readonly gaps: Span[];
  readonly last: number;
}

/** The head rows' sums of each monitor, by monitor id; `starts` is where each monitor's read starts. */
function headSummaryOf(
  tallies: readonly TallyRow[],
  gaps: readonly GapRow[],
  starts: ReadonlyMap<string, number>
): Map<string, HeadSummary> {
  const read = new Map<string, HeadSummary>();
  for (const row of tallies) {
    if (row.unknown_at !== null) {
      throw new CheckShapeError(row.monitor_id, Number(row.unknown_at));
    }
    const first = Number(row.first_at);
    const last = Number(row.last_at);
    const seen = read.get(row.monitor_id);
    const own: HeadSummary = {
      days: seen?.days ?? new Map<number, DayTally>(),
      first: Math.min(first, seen?.first ?? first),
      gaps: [],
      last: Math.max(last, seen?.last ?? last),
    };
    read.set(row.monitor_id, own);
    addTally(own.days, Number(row.day), {
      checks: Number(row.check_count),
      degraded: Number(row.degraded_count),
      down: Number(row.down_count),
      timed: Number(row.timed_count),
      totalMs: Number(row.total_ms),
    });
  }
  for (const row of gaps) {
    // The read's first check has no check before it within the read, or none at all: no gap.
    const from = row.prev_at === null ? undefined : Number(row.prev_at);
    if (from !== undefined && from >= (starts.get(row.monitor_id) ?? from)) {
      read.get(row.monitor_id)?.gaps.push({ from, to: Number(row.started_at) });
    }
  }
  return read;
}

/** A monitor's summary from its sealed checks, all before its head rows, and its head's sums; nothing without a check. The gap from the last sealed check to the first head row counts like any other. */
function summaryOf(
  sealed: readonly Check[],
  head: HeadSummary | undefined,
  read: SummaryRead
): CheckSummary | undefined {
  const times = Float64Array.from(sealed, (check) => check.startedAt).sort();
  const before = coverageOf(times, read.limitMs);
  const days = tallyDays(sealed, read.from);
  if (!head) {
    return before && { coverage: before, days };
  }
  for (const [at, tally] of head.days) {
    // The head also holds the checks within the limit before `from`, which only the coverage reads.
    if (at >= read.from) {
      addTally(days, at, tally);
    }
  }
  const bridge =
    before && head.first - before.last > read.limitMs
      ? [{ from: before.last, to: head.first }]
      : [];
  return {
    coverage: {
      first: before?.first ?? head.first,
      gaps: [...(before?.gaps ?? []), ...bridge, ...head.gaps],
      last: head.last,
    },
    days,
  };
}

/** A day's tally with another's added. */
function addTally(
  days: Map<number, DayTally>,
  day: number,
  tally: DayTally
): void {
  const before = days.get(day);
  days.set(day, {
    checks: (before?.checks ?? 0) + tally.checks,
    degraded: (before?.degraded ?? 0) + tally.degraded,
    down: (before?.down ?? 0) + tally.down,
    timed: (before?.timed ?? 0) + tally.timed,
    totalMs: (before?.totalMs ?? 0) + tally.totalMs,
  });
}

/** The checks from `from` on summed by UTC day. */
function tallyDays(
  checks: readonly Check[],
  from: number
): Map<number, DayTally> {
  const days = new Map<number, DayTally>();
  for (const check of checks) {
    if (check.startedAt < from) {
      continue;
    }
    const timed = check.result !== "down" && check.responseMs !== undefined;
    addTally(days, dayOf(check.startedAt), {
      checks: 1,
      degraded: check.result === "degraded" ? 1 : 0,
      down: check.result === "down" ? 1 : 0,
      timed: timed ? 1 : 0,
      totalMs: timed ? (check.responseMs ?? 0) : 0,
    });
  }
  return days;
}

/** Parsed JSON, or nothing for text that is not JSON; the schema decides after. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller's schema refuses `undefined` and names the check.
  }
}

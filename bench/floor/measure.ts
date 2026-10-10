/**
 * What the harness reads after a container stopped: scheduler
 * lateness from the check rows, the trend of RSS across the accelerated
 * day, the public route's JavaScript, and disk per monitor per day from the
 * database's own page accounting.
 */

import { spreadWindowMs, tickPeriodMs } from "@/server/scheduler/schedule.ts";

const minuteMs = 60_000;

const tagPattern = /<(script|link)\b[^>]*>/gi;
const srcPattern = /\bsrc=["']([^"']+)["']/i;
const hrefPattern = /\bhref=["']([^"']+)["']/i;
const modulePreloadPattern = /\brel=["']modulepreload["']/i;

/** The median of a list of numbers; the mean of the middle two for an even count. */
function middle(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[half] ?? 0)
    : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
}

/** One check row's monitor and start, all lateness needs. */
export interface StartedCheck {
  readonly monitorId: string;
  readonly startedAt: number;
}

/** How late one check started against the time the scheduler had it due. */
export interface Lateness {
  readonly at: number;
  readonly ms: number;
}

/** The median lateness of the checks that started in one minute. */
export interface MinuteLateness {
  readonly checks: number;
  /** Checks that started past the late bound, shown beside the median that judges the minute. */
  readonly late: number;
  readonly medianMs: number;
  /** The minute's start, milliseconds from the span's start. */
  readonly minute: number;
}

/**
 * Each check's lateness under the scheduler's own rule: the
 * first runs spread over 30 seconds in list order, each next run one
 * interval after the run was due, or after its start when it started more
 * than an interval late. The boot is the earliest time every first check
 * allows, so the least late first run counts as on time.
 */
export function latenessOf(
  rows: readonly StartedCheck[],
  order: readonly string[],
  intervalMs: number
): Lateness[] {
  const starts = new Map<string, number[]>();
  for (const row of rows) {
    const list = starts.get(row.monitorId) ?? [];
    list.push(row.startedAt);
    starts.set(row.monitorId, list);
  }
  const step = spreadWindowMs / Math.max(order.length, 1);
  const offsets = order.map((_, index) => Math.min(index * step, intervalMs));
  const firsts = order.flatMap((id, index) => {
    const first = Math.min(...(starts.get(id) ?? []));
    return Number.isFinite(first) ? [first - (offsets[index] ?? 0)] : [];
  });
  const bootAt = Math.min(...firsts);
  return order.flatMap((id, index) => {
    let due = bootAt + (offsets[index] ?? 0);
    return (starts.get(id) ?? [])
      .toSorted((a, b) => a - b)
      .map((at) => {
        const ms = at - due;
        const onCadence = due + intervalMs;
        due = onCadence > at ? onCadence : at + intervalMs;
        return { at, ms };
      });
  });
}

/** The median lateness of each whole minute of a span; a minute with no check is left out. */
export function latenessByMinute(
  lateness: readonly Lateness[],
  from: number,
  to: number,
  intervalMs: number
): MinuteLateness[] {
  const minutes: MinuteLateness[] = [];
  for (let start = from; start + minuteMs <= to; start += minuteMs) {
    const inside = lateness
      .filter(({ at }) => at >= start && at < start + minuteMs)
      .map(({ ms }) => ms);
    if (inside.length > 0) {
      minutes.push({
        checks: inside.length,
        late: inside.filter((ms) => ms > lateBoundMs(intervalMs)).length,
        medianMs: middle(inside),
        minute: start - from,
      });
    }
  }
  return minutes;
}

/**
 * How late a check may start before it is late: one interval, and one tick, since the scheduler finds due checks once a tick and a
 * check due just after one waits for the next by design. At the accelerated
 * day's 1 s interval the tick is the whole interval.
 */
export function lateBoundMs(intervalMs: number): number {
  return intervalMs + tickPeriodMs;
}

/** The median lateness of the checks that started in a span of any length; nothing when none did. */
export function medianLateness(
  lateness: readonly Lateness[],
  from: number,
  to: number
): number | null {
  const inside = lateness
    .filter(({ at }) => at >= from && at < to)
    .map(({ ms }) => ms);
  return inside.length === 0 ? null : middle(inside);
}

/** One value sampled at a time. */
export interface Timed {
  readonly at: number;
  readonly value: number;
}

/** The mean of each quarter of a span; `null` for a quarter with no sample. */
export function quarterMeans(
  samples: readonly Timed[],
  from: number,
  to: number
): (number | null)[] {
  const length = (to - from) / 4;
  return [0, 1, 2, 3].map((quarter) => {
    const values = samples
      .filter(
        ({ at }) =>
          at >= from + quarter * length && at < from + (quarter + 1) * length
      )
      .map(({ value }) => value);
    return values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  });
}

/** How far RSS may climb from the second quarter to the last before the day reads as a leak (research report, section 6). */
export const rssRiseBytes = 5 * 2 ** 20;

/** Whether RSS is still rising in the day's last quarter: each quarter from the second above the one before, and the last at least `rssRiseBytes` above the second. */
export function stillRising(quarters: readonly (number | null)[]): boolean {
  const [, second, third, last] = quarters;
  if (
    second === null ||
    second === undefined ||
    third === null ||
    third === undefined ||
    last === null ||
    last === undefined
  ) {
    return false;
  }
  return third > second && last > third && last - second >= rssRiseBytes;
}

/** A script tag's source, or a module preload's address; nothing for any other tag. */
function sourceOf(tag: string, script: boolean): string | undefined {
  if (script) {
    return srcPattern.exec(tag)?.[1];
  }
  return modulePreloadPattern.test(tag)
    ? hrefPattern.exec(tag)?.[1]
    : undefined;
}

/** The same-origin scripts a page loads: its script sources and module preloads, each once, in order. */
export function scriptUrls(html: string): string[] {
  const urls: string[] = [];
  for (const [tag, name] of html.matchAll(tagPattern)) {
    const attribute = sourceOf(tag, name?.toLowerCase() === "script");
    if (
      attribute?.startsWith("/") &&
      !attribute.startsWith("//") &&
      !urls.includes(attribute)
    ) {
      urls.push(attribute);
    }
  }
  return urls;
}

/** What a set of scripts weighs compressed: with gzip and with zstd, each at its default level. */
export interface CompressedBytes {
  readonly gzip: number;
  readonly zstd: number;
}

/** The scripts' bytes compressed one by one and summed, as a server sends each file on its own; zstd at level 3, Bun's default and Caddy's. */
export function compressedBytes(
  scripts: readonly Uint8Array<ArrayBuffer>[]
): CompressedBytes {
  return scripts.reduce(
    (sum, bytes) => ({
      gzip: sum.gzip + Bun.gzipSync(bytes).length,
      zstd: sum.zstd + Bun.zstdCompressSync(bytes, { level: 3 }).length,
    }),
    { gzip: 0, zstd: 0 }
  );
}

/** One table's bytes in the database file, from `dbstat`. */
export interface TableBytes {
  readonly bytes: number;
  readonly name: string;
}

/** The tables a closed day lives in once sealed: its chunk and its rollups. */
export const sealedTables = [
  "sealed_days",
  "hourly_rollups",
  "daily_rollups",
] as const;

/** Bytes per monitor per day of history: the sealed tables' pages over the monitor-days they hold; nothing with none. */
export function diskPerMonitorDay(
  tables: readonly TableBytes[],
  monitorDays: number
): number | null {
  if (monitorDays <= 0) {
    return null;
  }
  // SQLite keeps each composite primary key in an index of its own, named after the table.
  const counts = (name: string) =>
    sealedTables.some(
      (table) => name === table || name.startsWith(`sqlite_autoindex_${table}_`)
    );
  const bytes = tables
    .filter((table) => counts(table.name))
    .reduce((sum, table) => sum + table.bytes, 0);
  return Math.round(bytes / monitorDays);
}

/** What decides whether a capacity step fit. */
export interface StepReading {
  readonly coldStartMs: number | null;
  readonly medianLatenessMs: number | null;
  readonly oom: "killed" | "none" | "not-captured";
}

/** A count fits when the install started, was never killed, and the median lateness over its measured span stayed within the late bound (with one tick). */
export function stepFits(step: StepReading, intervalMs: number): boolean {
  return (
    step.oom === "none" &&
    step.coldStartMs !== null &&
    step.medianLatenessMs !== null &&
    step.medianLatenessMs <= lateBoundMs(intervalMs)
  );
}

/** The largest count that fit below every count that did not, whichever way the sweep went; nothing when none did. */
export function monitorsThatFit(
  steps: readonly { readonly fits: boolean; readonly monitors: number }[]
): number | null {
  const smallestMiss = Math.min(
    ...steps.filter((step) => !step.fits).map((step) => step.monitors)
  );
  const fitted = steps
    .filter((step) => step.fits && step.monitors < smallestMiss)
    .map((step) => step.monitors);
  return fitted.length === 0 ? null : Math.max(...fitted);
}

/** Where the capacity sweep starts and how far it may go. */
export interface CapacityBounds {
  /** The largest count it doubles up to. */
  readonly ceiling: number;
  /** The first count: the previous release's count that fit, or the sweep's own first. */
  readonly first: number;
  /** The smallest count it halves down to. */
  readonly floor: number;
}

/** The next count of the capacity sweep: doubling while every count fits, halving while none does, nothing once a count that fits sits beside one that does not or a bound is reached. */
export function nextCapacityCount(
  steps: readonly { readonly fits: boolean; readonly monitors: number }[],
  bounds: CapacityBounds
): number | undefined {
  const last = steps.at(-1);
  if (!last) {
    return Math.min(Math.max(bounds.first, bounds.floor), bounds.ceiling);
  }
  const fitted = steps.some((step) => step.fits);
  const missed = steps.some((step) => !step.fits);
  if (fitted && missed) {
    return;
  }
  const next = fitted ? last.monitors * 2 : Math.floor(last.monitors / 2);
  return next >= bounds.floor && next <= bounds.ceiling ? next : undefined;
}

/** Whether every count fit up to the sweep's largest, so it found no count that does not. */
export function atCeiling(
  steps: readonly { readonly fits: boolean; readonly monitors: number }[],
  largest: number
): boolean {
  const last = steps.at(-1);
  return (
    last !== undefined &&
    steps.every((step) => step.fits) &&
    last.monitors * 2 > largest
  );
}

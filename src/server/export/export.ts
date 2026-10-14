/**
 * Export (CONTEXT.md "Export"): the
 * install as one streamed `raaqeb-export.jsonl.zst`. The header line holds
 * the configuration with every credential opened with the install key;
 * in the full mode each monitor's history follows, its outages first and
 * then its days oldest first, each day in the finest kind it still has:
 * checks (sealed days decoded), else hourly rollups, else the daily one.
 * The stream pulls one monitor-day of checks at a time, so the history never
 * sits in memory; a monitor's rollups and outages are read whole, beside it. One monitor's history over a range is the same records, for the
 * detail page's download. One export downloads at a time.
 */
import { z } from "zod";
import { decrypt, type InstallKey } from "@/server/boot/installkey.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import type { Check } from "@/shared/schemas/check.ts";
import {
  type ChartRange,
  type ChartSpan,
  chartRangeMs,
} from "@/shared/schemas/detail.ts";
import {
  type Configuration,
  type ExportMode,
  type ExportRecord,
  exportVersion,
  headerSchema,
  recordSchema,
} from "@/shared/schemas/export.ts";
import type {
  ExportRefusal,
  ExportSizes,
} from "@/shared/schemas/export-page.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import { type ReasonCode, reasonName } from "@/shared/schemas/reason.ts";
import { rollupSpanMs } from "@/shared/schemas/rollup.ts";
import { compressLines } from "./lines.ts";

const dayMs = rollupSpanMs.day;

/** A download that started, or why it could not: before the first byte, so the page can say why. */
export type ExportStart =
  | { readonly ok: true; readonly body: ReadableStream<Uint8Array> }
  | {
      readonly ok: false;
      readonly reason: ExportRefusal;
      /** For credentials the key cannot open: the monitor, channel or subscription holding them. */
      readonly record?: string;
    };

/** Thrown while opening credentials: the key cannot open those of this record. */
class UnreadableCredentialsError extends Error {
  readonly record: string;
  constructor(record: string) {
    super(`the install key cannot open the credentials of ${record}`);
    this.name = "UnreadableCredentialsError";
    this.record = record;
  }
}

/** Every sealed credential of the configuration opened with the install key. */
async function opened(
  key: InstallKey,
  configuration: Configuration
): Promise<Configuration> {
  const open = async <Row extends { id: string; credentials: string | null }>(
    row: Row
  ): Promise<Row> => {
    if (row.credentials === null) {
      return row;
    }
    const text = await decrypt(key, row.credentials);
    if (text === undefined) {
      throw new UnreadableCredentialsError(row.id);
    }
    return { ...row, credentials: text };
  };
  return {
    ...configuration,
    channels: await Promise.all(configuration.channels.map(open)),
    monitors: await Promise.all(configuration.monitors.map(open)),
    subscriptions: await Promise.all(configuration.subscriptions.map(open)),
  };
}

/** The record a stored row this version cannot write names: the row's id where it has one, else its table. */
function recordOf(configuration: Configuration, error: z.ZodError): string {
  const [, table, index] = error.issues[0]?.path ?? [];
  if (typeof table !== "string" || typeof index !== "number") {
    return "configuration";
  }
  const rows = new Map<string, unknown>(Object.entries(configuration)).get(
    table
  );
  const row: unknown = Array.isArray(rows) ? rows[index] : undefined;
  const id =
    typeof row === "object" && row !== null
      ? new Map<string, unknown>(Object.entries(row)).get("id")
      : undefined;
  return typeof id === "string" ? id : table;
}

/** The install's export in this mode, zstd-compressed JSON Lines; refused as busy while another of the install's exports downloads, until its stream ends or is cancelled. */
export async function exportInstall(
  storage: Storage | undefined,
  key: InstallKey,
  mode: ExportMode,
  now: number
): Promise<ExportStart> {
  if (!storage) {
    return { ok: false, reason: "unavailable" };
  }
  if (downloading.has(storage)) {
    return { ok: false, reason: "busy" };
  }
  downloading.add(storage);
  let held = true;
  // Once only, so a late cancel cannot free the download after this one.
  const release = () => {
    if (held) {
      held = false;
      downloading.delete(storage);
    }
  };
  let started: Awaited<ReturnType<typeof exportLines>> | undefined;
  try {
    started = await exportLines(storage, key, mode, now);
  } finally {
    // A refusal or a throw writes nothing, so the next download may start.
    if (!started?.ok) {
      release();
    }
  }
  if (!started.ok) {
    return started;
  }
  return { body: compressLines(until(started.lines, release)), ok: true };
}

// One export downloads at a time, since each holds tens of megabytes while it streams.
const downloading = new WeakSet<Storage>();

/** The lines, then `done` once they end, fail or are cancelled; a generator's `finally` would not run on a cancel before its first line. */
function until(
  lines: AsyncGenerator<string>,
  done: () => void
): AsyncIterableIterator<string> {
  return {
    next: () =>
      lines.next().then(
        (next) => {
          if (next.done) {
            done();
          }
          return next;
        },
        (error: unknown) => {
          done();
          throw error;
        }
      ),
    return: () => {
      done();
      return lines.return(undefined);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** The export's lines in this mode, or why it cannot start. */
async function exportLines(
  storage: Storage,
  key: InstallKey,
  mode: ExportMode,
  now: number
): Promise<
  | { readonly ok: true; readonly lines: AsyncGenerator<string> }
  | Extract<ExportStart, { ok: false }>
> {
  let configuration: Configuration;
  try {
    configuration = await opened(key, await storage.transfer.configuration());
  } catch (error) {
    if (error instanceof UnreadableCredentialsError) {
      return { ok: false, reason: "unreadable", record: error.record };
    }
    logError(`the export could not read the configuration: ${reasonOf(error)}`);
    return { ok: false, reason: "unavailable" };
  }
  let header: string;
  try {
    header = JSON.stringify(
      headerSchema.encode({
        configuration,
        exportedAt: now,
        mode,
        raaqeb: "export",
        version: exportVersion,
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        reason: "unreadable",
        record: recordOf(configuration, error),
      };
    }
    throw error;
  }
  async function* lines(): AsyncGenerator<string> {
    yield header;
    if (mode === "configuration") {
      return;
    }
    for (const monitor of configuration.monitors) {
      // biome-ignore lint/performance/noAwaitInLoops: one monitor after another, so the file is grouped by monitor
      for await (const record of historyRecords(
        storage,
        monitor.id,
        0,
        Number.MAX_SAFE_INTEGER
      )) {
        yield lineOf(record);
      }
    }
  }
  return { lines: lines(), ok: true };
}

/** A record as its line in the file. */
function lineOf(record: ExportRecord): string {
  return JSON.stringify(recordSchema.encode(record));
}

/**
 * The bytes each mode's file holds, so the operator can choose by size:
 * the configuration's exactly, the full one's
 * estimated from counts and samples, since writing the whole file pinned a
 * small install's CPU and memory. An install's answer is kept for
 * five minutes, by `now`, and callers that ask while it is read share that read.
 */
export async function exportSizes(
  storage: Storage | undefined,
  key: InstallKey,
  now: number
): Promise<ExportSizes> {
  if (!storage) {
    return { ok: false, reason: "unavailable" };
  }
  const kept = keptSizes.get(storage);
  if (kept && now - kept.at < sizesKeptMs) {
    return kept.sizes;
  }
  const sizes = readSizes(storage, key, now).catch(
    (error: unknown): ExportSizes => {
      logError(`the export sizes could not be read: ${reasonOf(error)}`);
      return { ok: false, reason: "unavailable" };
    }
  );
  keptSizes.set(storage, { at: now, sizes });
  const answer = await sizes;
  // A refusal is not kept, so the next visit asks again.
  if (!answer.ok && keptSizes.get(storage)?.sizes === sizes) {
    keptSizes.delete(storage);
  }
  return answer;
}

/** Drops an install's kept sizes, for a write that changes what the file holds at once (an import). */
export function forgetExportSizes(storage: Storage): void {
  keptSizes.delete(storage);
}

const sizesKeptMs = 5 * 60_000;
// ponytail: one answer per open storage, in memory; a restart reads it again.
const keptSizes = new WeakMap<
  Storage,
  { readonly at: number; readonly sizes: Promise<ExportSizes> }
>();

/** How many of a monitor's newest checks are compressed to learn what each of its check lines costs: 2,000 came within 3% of the file where 500 overshot by 12%. */
const sampleChecks = 2000;
/** How far back the rollups compressed to learn what a rollup line costs reach. */
const sampleRollupsMs = 7 * dayMs;

async function readSizes(
  storage: Storage,
  key: InstallKey,
  now: number
): Promise<ExportSizes> {
  const header = await exportLines(storage, key, "configuration", now);
  if (!header.ok) {
    return header;
  }
  const configuration = await byteLength(compressLines(header.lines));
  return {
    configuration,
    full: configuration + Math.round(await historyBytes(storage, now)),
    ok: true,
  };
}

/** The bytes the full export's history lines take, estimated: each monitor's checks at what its newest cost compressed, the rollups at what recent ones cost, the outages compressed whole. */
async function historyBytes(storage: Storage, now: number): Promise<number> {
  const counts = await storage.transfer.historyCounts();
  let total = 0;
  for (const [monitorId, count] of counts) {
    if (count.checks > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: one monitor's sample at a time, so only one sits in memory
      const newest = await storage.checks.recent(monitorId, sampleChecks);
      total +=
        count.checks *
        (await lineBytes(
          newest.reverse().map((check) => checkRecord(check, monitorId))
        ));
    }
  }
  const monitorIds = [...counts.keys()];
  for (const [span, kind] of [
    ["hour", "hourly"],
    ["day", "daily"],
  ] as const) {
    const lines = [...counts.values()].reduce(
      (sum, count) => sum + count[kind],
      0
    );
    if (lines === 0) {
      continue;
    }
    // A monitor checked no more holds older rollups alone.
    // biome-ignore lint/performance/noAwaitInLoops: one span's sample at a time, so only one sits in memory
    const sample = await storage.checks
      .rollupsOf(monitorIds, span, now - sampleRollupsMs, now)
      .then(async (recent) =>
        recent.size > 0
          ? recent
          : await storage.checks.rollupsOf(monitorIds, span, 0, now)
      );
    total +=
      lines *
      (await lineBytes(
        [...sample].flatMap(([monitor, rollups]) =>
          rollups.map(
            (rollup): ExportRecord => ({
              ...rollupFields(rollup),
              kind,
              monitor,
            })
          )
        )
      ));
  }
  // Every monitor's: outages are never purged, so one checked no more still has them.
  const outages = await storage.outages.since(
    (await storage.monitors.list()).map((monitor) => monitor.id),
    0
  );
  const records = [...outages.values()].flat().map(outageRecord);
  return total + (await lineBytes(records)) * records.length;
}

/** What one of these records' lines costs compressed, on average. */
async function lineBytes(records: readonly ExportRecord[]): Promise<number> {
  if (records.length === 0) {
    return 0;
  }
  return (
    (await byteLength(compressLines(records.map(lineOf)))) / records.length
  );
}

/** The bytes a stream holds, counted as they pass, none kept. */
async function byteLength(body: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
  }
  return total;
}

/** A monitor's download, or why there is none. */
export type HistoryDownload =
  | { readonly ok: true; readonly body: ReadableStream<Uint8Array> }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };

/** One monitor's records over the chart's range ending now, or over the span zoomed into, zstd-compressed JSON Lines. */
export async function historyDownload(
  storage: Storage | undefined,
  monitorId: string,
  range: ChartRange,
  now: number,
  span?: ChartSpan
): Promise<HistoryDownload> {
  if (!storage) {
    return { ok: false, reason: "unavailable" };
  }
  try {
    if (!(await storage.monitors.find(monitorId))) {
      return { ok: false, reason: "not_found" };
    }
  } catch (error) {
    logError(
      `the history download could not read the monitor ${monitorId}: ${reasonOf(error)}`
    );
    return { ok: false, reason: "unavailable" };
  }
  // A zoomed span is downloaded as it is, cut to the chart's longest range and to now.
  const zoomFrom = span && Math.max(span.from, now - chartRangeMs["90d"]);
  const zoomTo = span && Math.min(span.to, now);
  const zoomed =
    zoomFrom !== undefined && zoomTo !== undefined && zoomFrom < zoomTo;
  const from = zoomed ? zoomFrom : now - chartRangeMs[range];
  const to = zoomed ? zoomTo : now;
  async function* lines(open: Storage): AsyncGenerator<string> {
    for await (const record of historyRecords(open, monitorId, from, to)) {
      yield JSON.stringify(recordSchema.encode(record));
    }
  }
  return { body: compressLines(lines(storage)), ok: true };
}

/** A stored reason's name; a code this version does not know cannot be written. */
function nameOf(
  reason: ReasonCode
): NonNullable<ReturnType<typeof reasonName>> {
  const name = reasonName(reason);
  if (name === undefined) {
    throw new Error(`the reason code ${reason} has no name in this version`);
  }
  return name;
}

/** An outage as a line of history, with when it was acknowledged or null. */
function outageRecord(outage: Outage): ExportRecord {
  return {
    acknowledgedAt: outage.acknowledgedAt ?? null,
    endedAt: outage.endedAt ?? null,
    kind: "outage",
    monitor: outage.monitorId,
    reason: nameOf(outage.reason),
    startedAt: outage.startedAt,
  };
}

/**
 * One monitor's records with `from <= at < to`: the outages that overlap
 * the span, then each UTC day in the finest kind it has, oldest first.
 */
export async function* historyRecords(
  storage: Storage,
  monitorId: string,
  from: number,
  to: number
): AsyncGenerator<ExportRecord> {
  // ponytail: one monitor's outages, hourly rollups (90 days at most) and daily rollups are read whole; outages are never purged, so a monitor that flaps for years holds them all while its records stream. Page them when the benchmark shows one.
  const outages = await storage.outages.list(monitorId, from);
  for (const outage of outages.reverse()) {
    if (outage.startedAt < to) {
      yield outageRecord(outage);
    }
  }
  const first = utcDayStart(from);
  const checked = new Set(await storage.checks.days(monitorId, first, to));
  const hours = new Map<number, ExportRecord[]>();
  for (const rollup of await storage.checks.rollups(
    monitorId,
    "hour",
    first,
    to
  )) {
    const day = utcDayStart(rollup.at);
    if (rollup.at >= from) {
      hours.set(day, [
        ...(hours.get(day) ?? []),
        { ...rollupFields(rollup), kind: "hourly", monitor: monitorId },
      ]);
    }
  }
  const days = new Map<number, ExportRecord>();
  for (const rollup of await storage.checks.rollups(
    monitorId,
    "day",
    first,
    to
  )) {
    days.set(rollup.at, {
      ...rollupFields(rollup),
      kind: "daily",
      monitor: monitorId,
    });
  }
  const every = [
    ...new Set([...checked, ...hours.keys(), ...days.keys()]),
  ].sort((a, b) => a - b);
  for (const day of every) {
    if (checked.has(day)) {
      // biome-ignore lint/performance/noAwaitInLoops: one day at a time, so the history never sits in memory
      const checks = await storage.checks.range(
        monitorId,
        Math.max(day, from),
        Math.min(day + dayMs, to)
      );
      for (const check of checks) {
        yield checkRecord(check, monitorId);
      }
      continue;
    }
    const daily = days.get(day);
    yield* hours.get(day) ?? (daily ? [daily] : []);
  }
}

/** A check as a line of history. */
function checkRecord(check: Check, monitorId: string): ExportRecord {
  return {
    at: check.startedAt,
    attempts: check.attempts,
    bytes: check.bytes,
    kind: "check",
    monitor: monitorId,
    reason: nameOf(check.reason),
    responseMs: check.responseMs ?? null,
    result: check.result,
    statusCode: check.statusCode ?? null,
  };
}

function rollupFields(rollup: {
  readonly at: number;
  readonly averageMs: number | undefined;
  readonly checks: number;
  readonly degraded: number;
  readonly failed: number;
  readonly maxMs: number | undefined;
  readonly minMs: number | undefined;
  readonly observedMs: number;
}) {
  return {
    at: rollup.at,
    averageMs: rollup.averageMs ?? null,
    checks: rollup.checks,
    degraded: rollup.degraded,
    failed: rollup.failed,
    maxMs: rollup.maxMs ?? null,
    minMs: rollup.minMs ?? null,
    observedMs: rollup.observedMs,
  };
}

/**
 * The noise band: the same build run several times, ten for the
 * stored band, and each history column's spread across those runs. The
 * report draws a release's difference against it. A band is only good for
 * the machine, image and commit it was measured on, so runs that differ in
 * any of them are refused. A wiring band proves the mode works and is never
 * quoted; only a full, clean band is written to `bench/floor/band.json`.
 */
import type { Machine } from "./host.ts";
import {
  defaultRunFlags,
  type HistoryColumn,
  historyColumns,
  median,
  type RunFlags,
  type RunResult,
  rowValues,
  sqliteOf,
} from "./results.ts";

/** One column's spread across the runs. */
export interface BandRange {
  readonly high: number;
  readonly low: number;
  readonly median: number;
}

/** The band file's shape. */
export interface NoiseBand {
  /** Only the columns every run measured. */
  readonly columns: Partial<Readonly<Record<HistoryColumn, BandRange>>>;
  readonly commit: string;
  readonly dirty: boolean;
  /** What the runs were asked to do. */
  readonly flags: RunFlags;
  readonly image: string;
  readonly machine: Machine;
  readonly measuredAt: string;
  readonly runs: number;
  readonly schema: 1;
  /** True when the runs measured the stand-in, not a shipped image. */
  readonly standIn: boolean;
  readonly wiring: boolean;
}

export type NoiseBandResult =
  | { readonly band: NoiseBand; readonly ok: true }
  | { readonly message: string; readonly ok: false };

/** The band of two or more runs of one build on one machine. */
export function noiseBand(
  results: readonly RunResult[],
  measuredAt: string
): NoiseBandResult {
  const [first] = results;
  if (!first || results.length < 2) {
    return { message: "a band needs two runs or more", ok: false };
  }
  const same = (pick: (result: RunResult) => unknown, what: string) =>
    results.every((result) => Bun.deepEquals(pick(result), pick(first)))
      ? undefined
      : `the runs differ in ${what}; a band is of one build on one machine`;
  const differs =
    same((result) => result.commit, "commit") ??
    same(
      (result) => result.variants.map((variant) => variant.image),
      "image"
    ) ??
    same((result) => result.machine, "machine") ??
    same((result) => result.cores, "cores") ??
    same((result) => result.flags, "flags");
  if (differs) {
    return { message: differs, ok: false };
  }
  const rows = results.map(rowValues);
  const columns: Partial<Record<HistoryColumn, BandRange>> = {};
  for (const column of historyColumns) {
    const values = rows.map((row) => row[column]);
    if (values.every((value) => value !== null)) {
      const sorted = values.toSorted((a, b) => a - b);
      columns[column] = {
        high: sorted.at(-1) ?? 0,
        low: sorted[0] ?? 0,
        median: median(sorted),
      };
    }
  }
  return {
    band: {
      columns,
      commit: first.commit,
      dirty: results.some((result) => result.dirty),
      image: sqliteOf(first)?.image ?? "",
      machine: first.machine,
      measuredAt,
      flags: first.flags,
      runs: results.length,
      schema: 1,
      standIn: first.standIn,
      wiring: results.some((result) => result.wiring),
    },
    ok: true,
  };
}

/** How many runs the stored band is measured over. */
export const storedBandRuns = 10;

/** Whether a band may be stored beside the history: ten runs or more of a release's full profile on a shipped image, at full length, on a clean tree, every column measured. */
export function storable(band: NoiseBand): boolean {
  return (
    band.runs >= storedBandRuns &&
    !(band.wiring || band.dirty || band.standIn) &&
    Bun.deepEquals(band.flags, defaultRunFlags) &&
    historyColumns.every((column) => band.columns[column] !== undefined)
  );
}

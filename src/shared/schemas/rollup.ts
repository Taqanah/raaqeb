/**
 * A rollup (CONTEXT.md "Rollup"): one hour or one UTC day of a
 * monitor's checks summed by the nightly sealing job. Long-range charts read
 * its response times; uptime reads only its observed time, never a count.
 */

/** The two spans a rollup sums, in milliseconds; every one starts on a UTC boundary. */
export const rollupSpanMs = { day: 86_400_000, hour: 3_600_000 } as const;
export type RollupSpan = keyof typeof rollupSpanMs;

export interface Rollup {
  /** The span's start, UTC milliseconds. */
  readonly at: number;
  /** The mean response time of the up and degraded checks, whole milliseconds; none when every check was down or had no time. */
  readonly averageMs: number | undefined;
  readonly checks: number;
  readonly degraded: number;
  /** The down checks. */
  readonly failed: number;
  readonly maxMs: number | undefined;
  readonly minMs: number | undefined;
  readonly monitorId: string;
  /** The part of the span Raaqeb had checks to judge the monitor by (CONTEXT.md "Observed time"). */
  readonly observedMs: number;
}

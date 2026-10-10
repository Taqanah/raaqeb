/**
 * The results file of one run, written as JSON to the gitignored
 * `bench/floor/results/`, and the history row a release run appends to
 * `bench/floor/history.jsonl`, one JSON object a line. Every result carries
 * the commit, a dirty flag, a wiring flag, the image and the machine.
 * Numbers are bytes, milliseconds or seconds as their names
 * say; `null` is a figure this shape of the harness does not measure yet or
 * a run that could not take it.
 */
import { z } from "zod";
import type { Cores, HostReading, Machine, Placement } from "./host.ts";
import type { MinuteLateness } from "./measure.ts";

// The sampler's marker, repeated rather than imported: importing the sampler
// would start it in the harness whenever the variable is set in the shell.
// The sampler's test reads its own line back through insideSamples.
const sampleMarker = "raaqeb-bench-sample";

/** The version of the results file's shape; a change of shape raises it. */
export const resultsSchema = 5;

/** A span of host time, `from` included and `to` not, in milliseconds. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** One host reading and when it was taken. */
export interface HostSample extends HostReading {
  readonly at: number;
}

/** One line of the preload sampler. */
export interface InsideSample {
  readonly at: number;
  readonly heapSize: number;
  readonly rss: number;
}

/** A series of one phase reduced to two numbers. */
export interface Stat {
  readonly max: number;
  readonly median: number;
}

/** What one phase measured. A series with no sample is `null`. */
export interface PhaseSummary {
  /** CPU seconds the container spent between the phase's first and last host reading. */
  readonly cpuSeconds: number | null;
  /** The share of its one core the container used between the same two readings, 1 for all of it. */
  readonly cpuShare: number | null;
  /** The inside JavaScript heap. */
  readonly heapSize: Stat | null;
  readonly memoryCurrent: Stat | null;
  /** Inside RSS minus the heap, sample by sample: native memory. */
  readonly native: Stat | null;
  /** The inside RSS. */
  readonly rss: Stat | null;
  readonly seconds: number;
  /** Seconds the CPU quota held the container back between the same two readings. */
  readonly throttledSeconds: number | null;
  /** PID 1's VmRSS read from the host. */
  readonly vmRss: Stat | null;
}

/** What `oha` reported for the load phase. */
export interface LoadSummary {
  /** `oha`'s own failures by kind: timeouts, refused and dropped connections. */
  readonly errors: Readonly<Record<string, number>>;
  /** `null` when no request got a response. */
  readonly latencyMs: {
    readonly max: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  } | null;
  /** Requests that got a response, whatever its status. */
  readonly requests: number;
  readonly requestsPerSecond: number;
  /** Responses with a 5xx status. */
  readonly serverErrors: number;
  readonly statusCodes: Readonly<Record<string, number>>;
}

/** Whether the kernel killed the install at the limit; "not-captured" when the harness could not ask. */
export type OomVerdict = "killed" | "none" | "not-captured";

/** What every container of a run reports, whatever it measured. */
export interface ContainerRun {
  /** Milliseconds from Docker's record of the container's start to the first 200 from GET /health. */
  readonly coldStartMs: number | null;
  /** The install's exit code after the harness stopped it. */
  readonly exitCode: number | null;
  /** The cgroup's `memory.peak` over the container's life. */
  readonly memoryPeak: number | null;
  readonly oom: OomVerdict;
  readonly samples: {
    readonly host: readonly HostSample[];
    readonly inside: readonly InsideSample[];
  };
}

/** Notifications the stand-ins received: messages in Mailpit, posts at the webhook sink; `null` when the stand-in could not be asked. */
export interface Sends {
  readonly email: number | null;
  readonly webhook: number | null;
}

/** The fixed run: the fleet at its interval, idle and then under a fixed arrival rate. */
export interface FixedRun extends ContainerRun {
  /** Bytes in the data directory at the end; `null` on Postgres, whose files are not the install's. */
  readonly dataBytes: number | null;
  /** The median lateness of each minute of both phases. */
  readonly lateness: readonly MinuteLateness[];
  readonly load: LoadSummary | null;
  readonly phases: {
    readonly idle: PhaseSummary;
    readonly load: PhaseSummary;
  };
  readonly sends: Sends;
}

/** The accelerated day: the fleet of `dayMonitors` at 1 s for ten minutes, over a seeded yesterday the install seals as it starts. */
export interface DayRun extends ContainerRun {
  /** Check rows the day wrote for the monitors at 1 s; the heartbeat monitors' windows are not among them. */
  readonly checks: number;
  /** The sealed tables' bytes per monitor-day after the install sealed yesterday. */
  readonly diskBytesPerMonitorPerDay: number | null;
  readonly lateness: readonly MinuteLateness[];
  readonly phase: PhaseSummary;
  /** VmRSS's mean in each quarter of the day. */
  readonly quarters: readonly (number | null)[];
  /** Monitor-days of yesterday the install sealed during the day. */
  readonly sealedMonitorDays: number;
  readonly sends: Sends;
}

/** One count of the capacity sweep. */
export interface CapacityStep {
  /** The share of its one core the install used over the measured span. */
  readonly cpuShare: number | null;
  /** Whether the count ran with no OOM kill and its measured span's median lateness within one interval and one tick. */
  readonly fits: boolean;
  /** The median lateness over the measured span at the step's end; `null` when no check started in it. */
  readonly medianLatenessMs: number | null;
  readonly memoryPeak: number | null;
  readonly monitors: number;
  readonly oom: OomVerdict;
  readonly vmRssMax: number | null;
}

/** The capacity sweep: from the previous release's count, doubled while counts fit and halved while none does, until a count that fits sits beside one that does not. */
export interface CapacitySweep {
  /** Every count fit up to the sweep's largest, so the count that fits is at least `monitorsThatFit`. */
  readonly atCeiling: boolean;
  readonly intervalSeconds: number;
  /** The largest count that fit below every count that did not; `null` when none fit. */
  readonly monitorsThatFit: number | null;
  readonly steps: readonly CapacityStep[];
}

/** The public page's serving paths the throughput sweep measures. */
export const throughputPaths = [
  "hit",
  "notModified",
  "perChange",
  "uncached",
] as const;
export type ThroughputPath = (typeof throughputPaths)[number];

/** The throughput sweep: each path at as many requests a second as it answers. */
export interface Throughput {
  /** The share of its one core the install used over each path's span, which takes in the second or so oha's container needs to start and stop. */
  readonly cpuShare: Readonly<Record<ThroughputPath, number | null>>;
  readonly memoryPeak: number | null;
  readonly oom: OomVerdict;
  readonly paths: Readonly<Record<ThroughputPath, LoadSummary | null>>;
  /** Seconds each path was held. */
  readonly seconds: number;
}

/** The database the install runs on, and the C library of its binary. */
export const variants = ["sqlite", "postgres", "musl"] as const;
export type Variant = (typeof variants)[number];

/** What one variant measured. Only SQLite runs the full profile; the others hold the fixed run alone. */
export interface VariantResult {
  readonly capacity: CapacitySweep | null;
  readonly day: DayRun | null;
  readonly fixed: FixedRun;
  readonly image: string;
  /** The gzip bytes of every script the public page loads. */
  readonly publicJavaScriptBytes: number | null;
  /** The zstd bytes of the same scripts. */
  readonly publicJavaScriptZstdBytes: number | null;
  readonly throughput: Throughput | null;
  readonly variant: Variant;
}

/** Why a run broke the floor; the report's banner names each. */
export type FloorBreak =
  | { readonly kind: "oom"; readonly part: string; readonly variant: Variant }
  | {
      /** A rule this part could not judge: the OOM state, the load phase, lateness or the day's RSS. */
      readonly kind: "unmeasured";
      readonly part: string;
      readonly variant: Variant;
      readonly what: "lateness" | "load" | "oom" | "rss";
    }
  | {
      readonly intervalMs: number;
      readonly kind: "late";
      readonly medianMs: number;
      readonly part: string;
      readonly variant: Variant;
    }
  | {
      readonly errors: number;
      readonly kind: "load_errors";
      readonly serverErrors: number;
      readonly variant: Variant;
    }
  | {
      readonly kind: "rss_rising";
      readonly quarters: readonly (number | null)[];
      readonly variant: Variant;
    };

/** What the run was asked to do, so a band never mixes two kinds of run. */
export interface RunFlags {
  readonly dayMonitors: number;
  readonly daySeconds: number;
  readonly idleSeconds: number;
  readonly intervalSeconds: number;
  readonly loadSeconds: number;
  readonly monitors: number;
  readonly rate: number;
  readonly short: boolean;
}

/** The flags of a release's run: the only run that becomes a history row, and the only one whose band is stored beside the history. The day's 1,500 monitors at 1 s are 65 % of the checks an efficiency core of the maintainer's i5-13600KF starts at most. */
export const defaultRunFlags: RunFlags = {
  dayMonitors: 1500,
  daySeconds: 600,
  idleSeconds: 300,
  intervalSeconds: 20,
  loadSeconds: 300,
  monitors: 200,
  rate: 20,
  short: false,
};

/** The shape of one run's results file. */
export interface RunResult {
  readonly commit: string;
  /** The cores the installs ran on, and which install took which. */
  readonly cores: {
    readonly kind: Cores["kind"];
    readonly measured: readonly number[];
    readonly placement: Placement;
  };
  readonly dirty: boolean;
  readonly flags: RunFlags;
  readonly floor: readonly FloorBreak[];
  readonly machine: Machine;
  readonly schema: typeof resultsSchema;
  /** True when the image is the stand-in over this checkout, not a shipped image. */
  readonly standIn: boolean;
  readonly startedAt: string;
  readonly variants: readonly VariantResult[];
  readonly wiring: boolean;
}

/** The sampler's lines among the install's log lines, oldest first; any other line is skipped. */
export function insideSamples(log: string): InsideSample[] {
  return log.split("\n").flatMap((line) => {
    if (!line.includes(sampleMarker)) {
      return [];
    }
    try {
      const parsed = insideSampleSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

const insideSampleSchema = z.object({
  at: z.number(),
  heapSize: z.number(),
  rss: z.number(),
});

/** The median of values sorted ascending; the mean of the middle two for an even count. */
export function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1
    ? upper
    : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

function stat(values: readonly number[]): Stat | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  return { max: sorted.at(-1) ?? 0, median: median(sorted) };
}

/** One phase's figures from the samples taken inside its span. */
export function summarizePhase(
  span: Span,
  host: readonly HostSample[],
  inside: readonly InsideSample[]
): PhaseSummary {
  const within = ({ at }: { readonly at: number }) =>
    at >= span.from && at < span.to;
  const hosts = host.filter(within);
  const insides = inside.filter(within);
  const [first] = hosts;
  const last = hosts.at(-1);
  const grew = (key: "cpuThrottledUsec" | "cpuUsageUsec") =>
    first && last && hosts.length > 1 ? (last[key] - first[key]) / 1e6 : null;
  const cpuSeconds = grew("cpuUsageUsec");
  const readSeconds = first && last ? (last.at - first.at) / 1000 : 0;
  return {
    cpuSeconds,
    cpuShare:
      cpuSeconds === null || readSeconds <= 0 ? null : cpuSeconds / readSeconds,
    heapSize: stat(insides.map((sample) => sample.heapSize)),
    memoryCurrent: stat(hosts.map((sample) => sample.memoryCurrent)),
    native: stat(insides.map((sample) => sample.rss - sample.heapSize)),
    rss: stat(insides.map((sample) => sample.rss)),
    seconds: (span.to - span.from) / 1000,
    throttledSeconds: grew("cpuThrottledUsec"),
    vmRss: stat(hosts.flatMap((sample) => sample.vmRss ?? [])),
  };
}

/** One reading of the container's CPU over time: the share of its core it used since the reading before. */
export interface CpuReading {
  readonly at: number;
  readonly share: number;
}

/** The share of its core the container used between each two host readings, at the later one. */
export function cpuOverTime(host: readonly HostSample[]): CpuReading[] {
  return host.flatMap((sample, index) => {
    const before = host[index - 1];
    const seconds = before ? (sample.at - before.at) / 1000 : 0;
    return before && seconds > 0
      ? [
          {
            at: sample.at,
            share: (sample.cpuUsageUsec - before.cpuUsageUsec) / 1e6 / seconds,
          },
        ]
      : [];
  });
}

/** `oha`'s JSON output reduced to the load summary; nothing when it is not what `oha` writes. */
export function loadSummary(output: unknown): LoadSummary | undefined {
  const parsed = ohaSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const {
    errorDistribution,
    latencyPercentiles: { p50, p95, p99 },
    statusCodeDistribution,
    summary,
  } = parsed.data;
  const codes = Object.entries(statusCodeDistribution);
  const count = (entries: [string, number][]) =>
    entries.reduce((sum, [, n]) => sum + n, 0);
  return {
    errors: errorDistribution,
    latencyMs:
      p50 === null || p95 === null || p99 === null || summary.slowest === null
        ? null
        : {
            max: milliseconds(summary.slowest),
            p50: milliseconds(p50),
            p95: milliseconds(p95),
            p99: milliseconds(p99),
          },
    requests: count(codes),
    requestsPerSecond: summary.requestsPerSec,
    serverErrors: count(codes.filter(([code]) => code.startsWith("5"))),
    statusCodes: statusCodeDistribution,
  };
}

const counts = z.record(z.string(), z.number());
const seconds = z.number().nullable();
const ohaSchema = z.object({
  errorDistribution: counts,
  latencyPercentiles: z.object({ p50: seconds, p95: seconds, p99: seconds }),
  statusCodeDistribution: counts,
  summary: z.object({ requestsPerSec: z.number(), slowest: seconds }),
});

/** Seconds to milliseconds, kept to the nanosecond so the figure reads as oha wrote it. */
function milliseconds(value: number): number {
  return Math.round(value * 1e9) / 1e6;
}

/** The nine columns of a history row, in the order the report shows them. */
export const historyColumns = [
  "idleRssBytes",
  "loadRssBytes",
  "cgroupPeakBytes",
  "monitorsThatFit",
  "diskBytesPerMonitorPerDay",
  "coldStartMs",
  "publicJavaScriptBytes",
  "publicJavaScriptZstdBytes",
  "cachedRequestsPerSecond",
] as const;
export type HistoryColumn = (typeof historyColumns)[number];

/** The nine figures of one run; `null` where this shape of the harness does not measure one yet. */
export type RowValues = Readonly<Record<HistoryColumn, number | null>>;

/** One line of `history.jsonl`: one release's figures. */
export interface HistoryRow extends RowValues {
  readonly commit: string;
  /** The UTC day of the run, YYYY-MM-DD. */
  readonly date: string;
  readonly image: string;
  readonly release: string;
}

export type HistoryRowResult =
  | { readonly ok: true; readonly row: HistoryRow }
  | { readonly message: string; readonly ok: false };

/** The run's SQLite variant, which alone runs the full profile and fills the history row. */
export function sqliteOf(result: RunResult): VariantResult | undefined {
  return result.variants.find((variant) => variant.variant === "sqlite");
}

/** The nine figures a run measured, all from its SQLite variant; `null` where it did not run or could not take one. */
export function rowValues(result: RunResult): RowValues {
  const sqlite = sqliteOf(result);
  if (!sqlite) {
    return {
      cachedRequestsPerSecond: null,
      cgroupPeakBytes: null,
      coldStartMs: null,
      diskBytesPerMonitorPerDay: null,
      idleRssBytes: null,
      loadRssBytes: null,
      monitorsThatFit: null,
      publicJavaScriptBytes: null,
      publicJavaScriptZstdBytes: null,
    };
  }
  const { day, fixed } = sqlite;
  // The capacity sweep is meant to break the container, so its peaks are its own.
  const peaks = [
    fixed.memoryPeak,
    day?.memoryPeak ?? null,
    sqlite.throughput?.memoryPeak ?? null,
  ].filter((peak) => peak !== null);
  return {
    cachedRequestsPerSecond:
      sqlite.throughput?.paths.hit?.requestsPerSecond ?? null,
    cgroupPeakBytes: peaks.length === 0 ? null : Math.max(...peaks),
    coldStartMs: fixed.coldStartMs,
    diskBytesPerMonitorPerDay: day?.diskBytesPerMonitorPerDay ?? null,
    idleRssBytes: fixed.phases.idle.vmRss?.median ?? null,
    loadRssBytes: fixed.phases.load.vmRss?.max ?? null,
    monitorsThatFit: sqlite.capacity?.monitorsThatFit ?? null,
    publicJavaScriptBytes: sqlite.publicJavaScriptBytes,
    publicJavaScriptZstdBytes: sqlite.publicJavaScriptZstdBytes,
  };
}

/** A release's history row; refused for a wiring run or a dirty tree, whose numbers are never quoted. */
export function historyRow(
  result: RunResult,
  release: string
): HistoryRowResult {
  if (result.wiring) {
    return { message: "a wiring run is never a history row", ok: false };
  }
  if (result.dirty) {
    return {
      message: "a run of a dirty tree is never a history row",
      ok: false,
    };
  }
  if (
    result.standIn ||
    !sqliteOf(result) ||
    !Bun.deepEquals(result.flags, defaultRunFlags)
  ) {
    return {
      message:
        "only a release's full profile on a shipped image is a history row",
      ok: false,
    };
  }
  return {
    ok: true,
    row: {
      ...rowValues(result),
      commit: result.commit,
      date: result.startedAt.slice(0, 10),
      image: sqliteOf(result)?.image ?? "",
      release,
    },
  };
}

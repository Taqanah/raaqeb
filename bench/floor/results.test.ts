import { describe, expect, test } from "bun:test";
import { fixedRun, phase, runResult, sqliteResult } from "./fixture.ts";
import type { HostReading } from "./host.ts";
import {
  cpuOverTime,
  type HostSample,
  historyColumns,
  historyRow,
  type InsideSample,
  insideSamples,
  type LoadSummary,
  loadSummary,
  rowValues,
  summarizePhase,
} from "./results.ts";
import { sampleLine } from "./sampler.ts";

const reading: HostReading = {
  cpuThrottledUsec: 0,
  cpuUsageUsec: 0,
  memoryCurrent: 0,
  memoryPeak: 0,
  oomKills: 0,
  vmRss: 0,
};

function host(at: number, fields: Partial<HostReading>): HostSample {
  return { ...reading, at, ...fields };
}

function inside(at: number, rss: number, heapSize: number): InsideSample {
  return { at, heapSize, rss };
}

describe("the sampler's lines among the install's log", () => {
  test("only the sampler's lines are read, oldest first", () => {
    const log = [
      "raaqeb: listening",
      sampleLine(1000, 80, 10),
      "raaqeb: check of Bench 001 took 12 ms",
      sampleLine(3000, 90, 12),
      "",
    ].join("\n");
    expect(insideSamples(log)).toEqual([
      inside(1000, 80, 10),
      inside(3000, 90, 12),
    ]);
  });

  test("a marked line whose figures are not numbers is skipped", () => {
    const odd = JSON.stringify({
      at: "soon",
      heapSize: 1,
      "raaqeb-bench-sample": 1,
      rss: 2,
    });
    expect(insideSamples(`${odd}\n${sampleLine(1000, 80, 10)}`)).toEqual([
      inside(1000, 80, 10),
    ]);
  });

  test("a line cut off by a kill is skipped, not an error", () => {
    const cut = sampleLine(3000, 90, 12).slice(0, 20);
    expect(insideSamples(`${sampleLine(1000, 80, 10)}\n${cut}`)).toEqual([
      inside(1000, 80, 10),
    ]);
  });
});

describe("one phase's figures", () => {
  const span = { from: 10_000, to: 20_000 };

  test("reads only the samples inside the phase, its end excluded", () => {
    const summary = summarizePhase(
      span,
      [
        host(9000, { vmRss: 500 }),
        host(10_000, { vmRss: 100 }),
        host(15_000, { vmRss: 300 }),
        host(20_000, { vmRss: 900 }),
      ],
      [inside(9999, 500, 1), inside(12_000, 80, 20), inside(20_000, 900, 1)]
    );
    expect(summary.vmRss).toEqual({ max: 300, median: 200 });
    expect(summary.rss).toEqual({ max: 80, median: 80 });
  });

  test("the median of an even count is the mean of the middle two", () => {
    const summary = summarizePhase(
      span,
      [1, 4, 2, 3].map((value, index) =>
        host(10_000 + index, { memoryCurrent: value })
      ),
      []
    );
    expect(summary.memoryCurrent).toEqual({ max: 4, median: 2.5 });
  });

  test("native memory is the inside RSS less the heap, sample by sample", () => {
    const summary = summarizePhase(
      span,
      [],
      [
        inside(11_000, 100, 30),
        inside(12_000, 110, 60),
        inside(13_000, 150, 50),
      ]
    );
    expect(summary.native).toEqual({ max: 100, median: 70 });
    expect(summary.heapSize).toEqual({ max: 60, median: 50 });
  });

  test("CPU and throttled seconds are what the counters grew by inside the phase", () => {
    const summary = summarizePhase(
      span,
      [
        host(10_000, { cpuThrottledUsec: 1_000_000, cpuUsageUsec: 5_000_000 }),
        host(14_000, { cpuThrottledUsec: 1_500_000, cpuUsageUsec: 6_000_000 }),
        host(19_000, { cpuThrottledUsec: 3_000_000, cpuUsageUsec: 9_500_000 }),
      ],
      []
    );
    expect(summary.cpuSeconds).toBe(4.5);
    expect(summary.throttledSeconds).toBe(2);
  });

  test("the share of its core is the CPU time over the time between the phase's first and last reading", () => {
    const summary = summarizePhase(
      span,
      [
        host(10_000, { cpuUsageUsec: 5_000_000 }),
        host(14_000, { cpuUsageUsec: 6_000_000 }),
        host(19_000, { cpuUsageUsec: 9_500_000 }),
      ],
      []
    );
    expect(summary.cpuShare).toBe(0.5);
  });

  test("one host sample in a phase gives no CPU figure, since a counter needs two readings", () => {
    const summary = summarizePhase(
      span,
      [host(12_000, { cpuUsageUsec: 7_000_000 })],
      []
    );
    expect(summary.cpuSeconds).toBeNull();
    expect(summary.cpuShare).toBeNull();
    expect(summary.throttledSeconds).toBeNull();
  });

  test("a phase's length is its span in seconds", () => {
    expect(summarizePhase(span, [], []).seconds).toBe(10);
  });

  test("a phase with no samples has no figures rather than zeros", () => {
    expect(summarizePhase(span, [host(1, {})], [])).toMatchObject({
      cpuSeconds: null,
      cpuShare: null,
      heapSize: null,
      memoryCurrent: null,
      native: null,
      rss: null,
      throttledSeconds: null,
      vmRss: null,
    });
  });

  test("a sample whose VmRSS could not be read is left out of VmRSS only", () => {
    const summary = summarizePhase(
      span,
      [
        host(11_000, { memoryCurrent: 5, vmRss: null }),
        host(12_000, { memoryCurrent: 7, vmRss: 40 }),
      ],
      []
    );
    expect(summary.vmRss).toEqual({ max: 40, median: 40 });
    expect(summary.memoryCurrent).toEqual({ max: 7, median: 6 });
  });
});

describe("CPU over time", () => {
  test("each reading after the first carries the share of its core the container used since the one before", () => {
    expect(
      cpuOverTime([
        host(0, { cpuUsageUsec: 0 }),
        host(1000, { cpuUsageUsec: 250_000 }),
        host(3000, { cpuUsageUsec: 1_250_000 }),
      ])
    ).toEqual([
      { at: 1000, share: 0.25 },
      { at: 3000, share: 0.5 },
    ]);
  });

  test("two readings at one moment give no share rather than a division by zero", () => {
    expect(
      cpuOverTime([
        host(1000, { cpuUsageUsec: 0 }),
        host(1000, { cpuUsageUsec: 10 }),
      ])
    ).toEqual([]);
  });

  test("no readings, or one, give no series", () => {
    expect(cpuOverTime([])).toEqual([]);
    expect(cpuOverTime([host(0, {})])).toEqual([]);
  });
});

describe("what oha reported", () => {
  const output = {
    errorDistribution: { "connection closed before message completed": 2 },
    latencyPercentiles: {
      p10: 0.0016,
      p50: 0.001_915_825,
      p95: 0.002_851_287,
      p99: 0.003_549_666,
    },
    statusCodeDistribution: { "200": 95, "503": 3 },
    summary: {
      requestsPerSec: 20.194_964_070_667_538,
      slowest: 0.0042,
      successRate: 0.98,
    },
  };

  test("counts the responses, the 5xx among them and oha's own errors", () => {
    expect(loadSummary(output)).toMatchObject({
      errors: { "connection closed before message completed": 2 },
      requests: 98,
      requestsPerSecond: 20.194_964_070_667_538,
      serverErrors: 3,
      statusCodes: { "200": 95, "503": 3 },
    });
  });

  test("latencies are in milliseconds", () => {
    expect(loadSummary(output)?.latencyMs).toEqual({
      max: 4.2,
      p50: 1.915_825,
      p95: 2.851_287,
      p99: 3.549_666,
    });
  });

  test("a run with no responses has no latency percentiles and still reads", () => {
    expect(
      loadSummary({
        errorDistribution: { "connection refused": 40 },
        latencyPercentiles: { p50: null, p95: null, p99: null },
        statusCodeDistribution: {},
        summary: { requestsPerSec: 0, slowest: null, successRate: 0 },
      })
    ).toMatchObject({
      errors: { "connection refused": 40 },
      latencyMs: null,
      requests: 0,
    });
  });

  test("output that is not oha's is not read", () => {
    expect(loadSummary("error: connect refused")).toBeUndefined();
    expect(loadSummary({ summary: {} })).toBeUndefined();
  });
});

describe("a run's history row", () => {
  test("the public page's JavaScript is a column with gzip and a column with zstd, side by side", () => {
    const gzip = historyColumns.indexOf("publicJavaScriptBytes");
    expect(historyColumns[gzip + 1]).toBe("publicJavaScriptZstdBytes");
  });

  const hit: LoadSummary = {
    errors: {},
    latencyMs: { max: 9, p50: 1, p95: 2, p99: 3 },
    requests: 90_000,
    requestsPerSecond: 3000,
    serverErrors: 0,
    statusCodes: { "200": 90_000 },
  };

  test("idle RSS is the fixed run's idle median VmRSS and RSS under load its load phase's highest", () => {
    const values = rowValues(runResult());
    expect(values.idleRssBytes).toBe(100_000_000);
    expect(values.loadRssBytes).toBe(125_000_000);
    expect(values.coldStartMs).toBe(850);
  });

  test("the cgroup peak takes the throughput sweep's too, never the capacity sweep's, which is meant to break the container", () => {
    const base = sqliteResult();
    const values = rowValues(
      runResult({
        variants: [
          sqliteResult({
            capacity: base.capacity && {
              ...base.capacity,
              steps: [
                {
                  cpuShare: null,
                  fits: false,
                  medianLatenessMs: null,
                  memoryPeak: 250_000_000,
                  monitors: 400,
                  oom: "killed",
                  vmRssMax: null,
                },
              ],
            },
            throughput: base.throughput && {
              ...base.throughput,
              memoryPeak: 190_000_000,
            },
          }),
        ],
      })
    );
    expect(values.cgroupPeakBytes).toBe(190_000_000);
  });

  test("the cgroup peak is the highest of the fixed run and the accelerated day", () => {
    expect(rowValues(runResult()).cgroupPeakBytes).toBe(160_000_000);
    const result = sqliteResult();
    expect(
      rowValues(
        runResult({
          variants: [
            sqliteResult({
              fixed: fixedRun({ memoryPeak: 170_000_000 }),
              day: result.day,
            }),
          ],
        })
      ).cgroupPeakBytes
    ).toBe(170_000_000);
  });

  test("the sweeps, the day and the public page fill the other five columns", () => {
    const base = sqliteResult();
    const values = rowValues(
      runResult({
        variants: [
          sqliteResult({
            throughput: base.throughput && {
              ...base.throughput,
              paths: { ...base.throughput.paths, hit },
            },
          }),
        ],
      })
    );
    expect(values.monitorsThatFit).toBe(6400);
    expect(values.diskBytesPerMonitorPerDay).toBe(9000);
    expect(values.publicJavaScriptBytes).toBe(180_000);
    expect(values.publicJavaScriptZstdBytes).toBe(170_000);
    expect(values.cachedRequestsPerSecond).toBe(3000);
  });

  test("the row is read from the SQLite variant, whatever order the variants ran in", () => {
    const values = rowValues(
      runResult({
        variants: [
          sqliteResult({
            fixed: fixedRun({ coldStartMs: 1 }),
            variant: "musl",
          }),
          sqliteResult(),
        ],
      })
    );
    expect(values.coldStartMs).toBe(850);
  });

  test("a run without SQLite has no figures", () => {
    const values = rowValues(
      runResult({ variants: [sqliteResult({ variant: "postgres" })] })
    );
    expect(Object.values(values).every((value) => value === null)).toBe(true);
  });

  test("a short run has no figures for the parts it left out", () => {
    const values = rowValues(
      runResult({
        variants: [
          sqliteResult({ capacity: null, day: null, throughput: null }),
        ],
      })
    );
    expect(values.monitorsThatFit).toBeNull();
    expect(values.diskBytesPerMonitorPerDay).toBeNull();
    expect(values.cachedRequestsPerSecond).toBeNull();
    expect(values.cgroupPeakBytes).toBe(140_000_000);
  });

  test("a run that took no VmRSS has no RSS columns", () => {
    const values = rowValues(
      runResult({
        variants: [
          sqliteResult({
            fixed: fixedRun({
              phases: {
                idle: { ...phase, vmRss: null },
                load: { ...phase, vmRss: null },
              },
            }),
          }),
        ],
      })
    );
    expect(values.idleRssBytes).toBeNull();
    expect(values.loadRssBytes).toBeNull();
  });

  test("the row carries the nine columns, the release, the run's UTC day, the commit and the SQLite image", () => {
    const result = runResult({
      startedAt: "2026-09-23T23:59:59.000Z",
      variants: [sqliteResult({ image: "raaqeb:0.2.0" })],
    });
    expect(historyRow(result, "0.2.0")).toEqual({
      ok: true,
      row: {
        ...rowValues(result),
        commit: "e996f72",
        date: "2026-09-23",
        image: "raaqeb:0.2.0",
        release: "0.2.0",
      },
    });
    expect(historyColumns).toHaveLength(9);
  });

  test("only a release's full profile on a shipped image becomes a history row", () => {
    expect(historyRow(runResult(), "1.0.0").ok).toBe(true);
    expect(historyRow(runResult({ standIn: true }), "1.0.0").ok).toBe(false);
    expect(
      historyRow(
        runResult({ flags: { ...runResult().flags, short: true } }),
        "1.0.0"
      ).ok
    ).toBe(false);
    expect(
      historyRow(
        runResult({ flags: { ...runResult().flags, monitors: 400 } }),
        "1.0.0"
      ).ok
    ).toBe(false);
    expect(
      historyRow(
        runResult({ variants: [sqliteResult({ variant: "postgres" })] }),
        "1.0.0"
      ).ok
    ).toBe(false);
  });

  test("a wiring run never becomes a history row", () => {
    expect(historyRow(runResult({ wiring: true }), "1.0.0").ok).toBe(false);
  });

  test("a run of a dirty tree never becomes a history row", () => {
    expect(historyRow(runResult({ dirty: true }), "1.0.0").ok).toBe(false);
  });
});

/**
 * Test support: a finished run's results with every figure set, which a
 * test overrides where its behaviour lives. Not harness code.
 */
import type { Machine } from "./host.ts";
import {
  defaultRunFlags,
  type FixedRun,
  type PhaseSummary,
  type RunResult,
  resultsSchema,
  type VariantResult,
} from "./results.ts";

export const machine: Machine = {
  cores: 16,
  cpu: "AMD Ryzen 7 7840HS w/ Radeon 780M Graphics",
  kernel: "7.2.6-1-cachyos",
  memoryBytes: 32_562_248 * 1024,
};

export const phase: PhaseSummary = {
  cpuSeconds: 4,
  cpuShare: 0.0134,
  heapSize: { max: 30_000_000, median: 24_000_000 },
  memoryCurrent: { max: 130_000_000, median: 110_000_000 },
  native: { max: 80_000_000, median: 70_000_000 },
  rss: { max: 110_000_000, median: 95_000_000 },
  seconds: 300,
  throttledSeconds: 0,
  vmRss: { max: 120_000_000, median: 100_000_000 },
};

export function fixedRun(overrides: Partial<FixedRun> = {}): FixedRun {
  return {
    coldStartMs: 850,
    dataBytes: 1_000_000,
    exitCode: 0,
    lateness: [{ checks: 600, late: 0, medianMs: 400, minute: 0 }],
    load: {
      errors: {},
      latencyMs: { max: 40, p50: 5, p95: 12, p99: 20 },
      requests: 6000,
      requestsPerSecond: 20,
      serverErrors: 0,
      statusCodes: { "200": 6000 },
    },
    memoryPeak: 140_000_000,
    oom: "none",
    phases: {
      idle: phase,
      load: { ...phase, vmRss: { max: 125_000_000, median: 115_000_000 } },
    },
    samples: { host: [], inside: [] },
    sends: { email: 4, webhook: 4 },
    ...overrides,
  };
}

/** The SQLite variant with every part measured. */
export function sqliteResult(
  overrides: Partial<VariantResult> = {}
): VariantResult {
  return {
    capacity: {
      atCeiling: false,
      intervalSeconds: 20,
      monitorsThatFit: 6400,
      steps: [],
    },
    day: {
      checks: 360_000,
      coldStartMs: 900,
      diskBytesPerMonitorPerDay: 9000,
      exitCode: 0,
      lateness: [{ checks: 12_000, late: 0, medianMs: 500, minute: 0 }],
      memoryPeak: 160_000_000,
      oom: "none",
      phase: { ...phase, seconds: 1800 },
      quarters: [130_000_000, 128_000_000, 129_000_000, 128_500_000],
      samples: { host: [], inside: [] },
      sealedMonitorDays: 195,
      sends: { email: 60, webhook: 60 },
    },
    fixed: fixedRun(),
    image: "raaqeb:0.1.0",
    publicJavaScriptBytes: 180_000,
    publicJavaScriptZstdBytes: 170_000,
    throughput: {
      cpuShare: {
        hit: null,
        notModified: null,
        perChange: null,
        uncached: null,
      },
      memoryPeak: 150_000_000,
      oom: "none",
      paths: { hit: null, notModified: null, perChange: null, uncached: null },
      seconds: 30,
    },
    variant: "sqlite",
    ...overrides,
  };
}

export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    commit: "e996f72",
    cores: {
      kind: "efficiency",
      measured: [12, 13, 14, 15, 16, 17, 18, 19],
      placement: {
        alone: 12,
        day: 12,
        fixed: { musl: 18, postgres: 16, sqlite: 14 },
      },
    },
    dirty: false,
    flags: defaultRunFlags,
    floor: [],
    machine,
    schema: resultsSchema,
    standIn: false,
    startedAt: "2026-09-23T10:15:00.000Z",
    variants: [sqliteResult()],
    wiring: false,
    ...overrides,
  };
}

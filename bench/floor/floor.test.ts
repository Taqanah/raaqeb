import { describe, expect, test } from "bun:test";
import { fixedRun, runResult, sqliteResult } from "./fixture.ts";
import { floorBreaks } from "./floor.ts";
import type { LoadSummary } from "./results.ts";

const load: LoadSummary = {
  errors: {},
  latencyMs: { max: 40, p50: 5, p95: 12, p99: 20 },
  requests: 6000,
  requestsPerSecond: 20,
  serverErrors: 0,
  statusCodes: { "200": 6000 },
};

describe("the floor broken banner", () => {
  const held = runResult({
    variants: [sqliteResult({ fixed: fixedRun({ load }) })],
  });

  test("a run that held the floor breaks nothing", () => {
    expect(floorBreaks(held)).toEqual([]);
  });

  test("an OOM state that could not be read, a load phase oha did not report, or no minute of lateness is unmeasured, never held", () => {
    const result = runResult({
      variants: [
        sqliteResult({
          fixed: fixedRun({ lateness: [], load: null, oom: "not-captured" }),
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([
      { kind: "unmeasured", part: "fixed", variant: "sqlite", what: "oom" },
      {
        kind: "unmeasured",
        part: "fixed",
        variant: "sqlite",
        what: "lateness",
      },
      { kind: "unmeasured", part: "fixed", variant: "sqlite", what: "load" },
    ]);
  });

  test("a day with a quarter of no RSS is unmeasured", () => {
    const base = sqliteResult({ fixed: fixedRun({ load }) });
    const result = runResult({
      variants: [
        {
          ...base,
          day: base.day && { ...base.day, quarters: [1, 2, null, 4] },
        },
      ],
    });
    expect(floorBreaks(result)).toEqual([
      { kind: "unmeasured", part: "day", variant: "sqlite", what: "rss" },
    ]);
  });

  test("a short run that had no day leaves nothing unmeasured for it", () => {
    const result = runResult({
      variants: [
        sqliteResult({
          capacity: null,
          day: null,
          fixed: fixedRun({ load }),
          throughput: null,
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([]);
  });

  test("an OOM kill in the fixed run breaks it", () => {
    const result = runResult({
      variants: [
        sqliteResult(),
        sqliteResult({
          fixed: fixedRun({ oom: "killed" }),
          variant: "postgres",
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([
      { kind: "oom", part: "fixed", variant: "postgres" },
    ]);
  });

  test("an OOM kill in the accelerated day or the throughput sweep breaks it", () => {
    const base = sqliteResult();
    const result = runResult({
      variants: [
        sqliteResult({
          day: base.day && { ...base.day, oom: "killed" },
          throughput: base.throughput && { ...base.throughput, oom: "killed" },
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([
      { kind: "oom", part: "day", variant: "sqlite" },
      { kind: "oom", part: "throughput", variant: "sqlite" },
    ]);
  });

  test("the capacity sweep is meant to break the container and never breaks the floor", () => {
    const result = runResult({
      variants: [
        sqliteResult({
          capacity: {
            atCeiling: false,
            intervalSeconds: 20,
            monitorsThatFit: 200,
            steps: [
              {
                cpuShare: null,
                fits: false,
                medianLatenessMs: null,
                memoryPeak: 251_658_240,
                monitors: 400,
                oom: "killed",
                vmRssMax: null,
              },
            ],
          },
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([]);
  });

  test("a minute of the fixed run whose median lateness passes one interval and one tick breaks it", () => {
    const result = runResult({
      variants: [
        sqliteResult({
          fixed: fixedRun({
            lateness: [
              { checks: 600, late: 0, medianMs: 300, minute: 0 },
              { checks: 600, late: 400, medianMs: 21_001, minute: 60_000 },
            ],
          }),
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([
      {
        intervalMs: 20_000,
        kind: "late",
        medianMs: 21_001,
        part: "fixed",
        variant: "sqlite",
      },
    ]);
  });

  test("lateness of exactly one interval and one tick is not late", () => {
    const result = runResult({
      variants: [
        sqliteResult({
          fixed: fixedRun({
            lateness: [{ checks: 1, late: 0, medianMs: 21_000, minute: 0 }],
          }),
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([]);
  });

  test("the accelerated day is judged against its own one-second interval and one tick, so a median just under the interval is on time", () => {
    const base = sqliteResult();
    const onTime = runResult({
      variants: [
        sqliteResult({
          day: base.day && {
            ...base.day,
            lateness: [{ checks: 12_000, late: 0, medianMs: 1500, minute: 0 }],
          },
        }),
      ],
    });
    expect(floorBreaks(onTime)).toEqual([]);
  });

  test("the accelerated day is late past its own one-second interval and one tick", () => {
    const base = sqliteResult();
    const result = runResult({
      variants: [
        sqliteResult({
          day: base.day && {
            ...base.day,
            lateness: [
              { checks: 12_000, late: 7000, medianMs: 2001, minute: 120_000 },
            ],
          },
        }),
      ],
    });
    expect(floorBreaks(result)).toEqual([
      {
        intervalMs: 1000,
        kind: "late",
        medianMs: 2001,
        part: "day",
        variant: "sqlite",
      },
    ]);
  });

  test("a 5xx or a dropped connection under load breaks it, in any variant", () => {
    const result = runResult({
      variants: [
        sqliteResult({
          fixed: fixedRun({ load: { ...load, serverErrors: 3 } }),
        }),
        sqliteResult({
          fixed: fixedRun({
            load: { ...load, errors: { "connection closed": 2, timeout: 1 } },
          }),
          variant: "musl",
        }),
        sqliteResult({ fixed: fixedRun({ load }), variant: "postgres" }),
      ],
    });
    expect(floorBreaks(result)).toEqual([
      { errors: 0, kind: "load_errors", serverErrors: 3, variant: "sqlite" },
      { errors: 3, kind: "load_errors", serverErrors: 0, variant: "musl" },
    ]);
  });

  test("RSS still rising in the day's last quarter breaks it", () => {
    const base = sqliteResult();
    const mb = 2 ** 20;
    const quarters = [100 * mb, 104 * mb, 108 * mb, 112 * mb];
    const result = runResult({
      variants: [sqliteResult({ day: base.day && { ...base.day, quarters } })],
    });
    expect(floorBreaks(result)).toEqual([
      { kind: "rss_rising", quarters, variant: "sqlite" },
    ]);
  });
});

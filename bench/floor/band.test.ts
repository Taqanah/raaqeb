import { describe, expect, test } from "bun:test";
import { type NoiseBand, noiseBand, storable } from "./band.ts";
import { fixedRun, machine, runResult, sqliteResult } from "./fixture.ts";
import type { RunResult } from "./results.ts";

const measuredAt = "2026-09-23T12:00:00.000Z";

/** Ten runs of one build whose cold start moves from 800 to 890 ms. */
function tenRuns(
  each: (index: number) => Partial<RunResult> = () => ({})
): RunResult[] {
  return Array.from({ length: 10 }, (_, index) =>
    runResult({
      variants: [
        sqliteResult({ fixed: fixedRun({ coldStartMs: 800 + index * 10 }) }),
      ],
      ...each(index),
    })
  );
}

/** Ten runs of a release's full profile with every column measured, the memo hit included. */
function fullRuns(overrides: Partial<RunResult> = {}): RunResult[] {
  const full = sqliteResult();
  const hit = {
    errors: {},
    latencyMs: null,
    requests: 1,
    requestsPerSecond: 3000,
    serverErrors: 0,
    statusCodes: { "200": 1 },
  };
  return tenRuns(() => ({
    variants: [
      sqliteResult({
        throughput: full.throughput && {
          ...full.throughput,
          paths: { ...full.throughput.paths, hit },
        },
      }),
    ],
    ...overrides,
  }));
}

function band(results: readonly RunResult[]): NoiseBand {
  const answer = noiseBand(results, measuredAt);
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.band;
}

describe("the noise band of one build", () => {
  test("each column's lowest, median and highest value across the runs", () => {
    expect(band(tenRuns()).columns.coldStartMs).toEqual({
      high: 890,
      low: 800,
      median: 845,
    });
  });

  test("a column no run measured is left out", () => {
    const { columns } = band(
      tenRuns(() => ({ variants: [sqliteResult({ capacity: null })] }))
    );
    expect(columns.monitorsThatFit).toBeUndefined();
    expect(columns.cachedRequestsPerSecond).toBeUndefined();
    expect(Object.keys(columns).length).toBe(7);
  });

  test("a column one run could not measure is left out, since its band would be narrower than the truth", () => {
    const { columns } = band(
      tenRuns((index) =>
        index === 3
          ? {
              variants: [
                sqliteResult({ fixed: fixedRun({ coldStartMs: null }) }),
              ],
            }
          : {}
      )
    );
    expect(columns.coldStartMs).toBeUndefined();
    expect(columns.idleRssBytes).toBeDefined();
  });

  test("the band names the build, the machine, the time and the run count", () => {
    expect(band(tenRuns())).toMatchObject({
      commit: "e996f72",
      dirty: false,
      image: "raaqeb:0.1.0",
      machine,
      measuredAt,
      runs: 10,
      schema: 1,
      wiring: false,
    });
  });

  test("one wiring run makes the band a wiring band", () => {
    expect(band(tenRuns((index) => ({ wiring: index === 9 }))).wiring).toBe(
      true
    );
  });

  test("one run of a dirty tree makes the band dirty", () => {
    expect(band(tenRuns((index) => ({ dirty: index === 0 }))).dirty).toBe(true);
  });

  test("fewer than two runs have no spread and are refused", () => {
    expect(noiseBand([runResult()], measuredAt).ok).toBe(false);
    expect(noiseBand([], measuredAt).ok).toBe(false);
  });

  test("runs of different commits are refused", () => {
    expect(
      noiseBand(
        tenRuns((index) => (index === 5 ? { commit: "abc1234" } : {})),
        measuredAt
      ).ok
    ).toBe(false);
  });

  test("runs of different images are refused", () => {
    expect(
      noiseBand(
        tenRuns((index) =>
          index === 5
            ? { variants: [sqliteResult({ image: "raaqeb:1.0.0" })] }
            : {}
        ),
        measuredAt
      ).ok
    ).toBe(false);
  });

  test("runs on different machines are refused", () => {
    expect(
      noiseBand(
        tenRuns((index) =>
          index === 5 ? { machine: { ...machine, cores: 8 } } : {}
        ),
        measuredAt
      ).ok
    ).toBe(false);
  });

  test("runs whose installs sat on other cores are refused, since a core's kind and neighbours move every figure", () => {
    const { cores } = runResult();
    expect(
      noiseBand(
        tenRuns((index) =>
          index === 5
            ? {
                cores: {
                  ...cores,
                  placement: { ...cores.placement, day: 13 },
                },
              }
            : {}
        ),
        measuredAt
      ).ok
    ).toBe(false);
  });

  test("runs with different flags are refused, since they measured different work", () => {
    expect(
      noiseBand(
        tenRuns((index) =>
          index === 5 ? { flags: { ...runResult().flags, monitors: 400 } } : {}
        ),
        measuredAt
      ).ok
    ).toBe(false);
  });
});

describe("which band is stored beside the history", () => {
  test("a full band of a clean tree is stored", () => {
    expect(storable(band(fullRuns()))).toBe(true);
  });

  test("a band of the stand-in, a short profile, other flags or a run missing a column is never stored", () => {
    expect(storable(band(fullRuns({ standIn: true })))).toBe(false);
    expect(
      storable(band(fullRuns({ flags: { ...runResult().flags, short: true } })))
    ).toBe(false);
    expect(
      storable(
        band(fullRuns({ flags: { ...runResult().flags, monitors: 400 } }))
      )
    ).toBe(false);
    expect(
      storable(
        band(
          tenRuns(() => ({ variants: [sqliteResult({ variant: "postgres" })] }))
        )
      )
    ).toBe(false);
  });

  test("a wiring band is never stored", () => {
    expect(storable(band(tenRuns(() => ({ wiring: true }))))).toBe(false);
  });

  test("a band of fewer than ten runs is never stored, since the stored band is ten runs of one build", () => {
    const nine = tenRuns().slice(0, 9);
    expect(storable(band(nine))).toBe(false);
  });

  test("a band of a dirty tree is never stored", () => {
    expect(storable(band(tenRuns(() => ({ dirty: true }))))).toBe(false);
  });
});

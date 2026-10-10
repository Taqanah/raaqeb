import { describe, expect, test } from "bun:test";
import { spreadWindowMs, tickPeriodMs } from "@/server/scheduler/schedule.ts";
import {
  atCeiling,
  compressedBytes,
  diskPerMonitorDay,
  lateBoundMs,
  latenessByMinute,
  latenessOf,
  medianLateness,
  monitorsThatFit,
  nextCapacityCount,
  quarterMeans,
  rssRiseBytes,
  type StartedCheck,
  scriptUrls,
  stepFits,
  stillRising,
} from "./measure.ts";

const interval = 20_000;
const boot = 1_000_000;

/** The checks of monitors started at given offsets from their due times: `late[m][k]` for monitor m's k-th check on cadence. */
function onCadence(late: readonly (readonly number[])[]): StartedCheck[] {
  const step = spreadWindowMs / late.length;
  return late.flatMap((checks, index) =>
    checks.map((ms, k) => ({
      monitorId: `m${index}`,
      startedAt: boot + Math.min(index * step, interval) + k * interval + ms,
    }))
  );
}

const order = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

describe("lateness from the check rows", () => {
  test("checks that start when due are not late", () => {
    const rows = onCadence([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(latenessOf(rows, order(3), interval).map((l) => l.ms)).toEqual(
      Array.from({ length: 9 }, () => 0)
    );
  });

  test("a check that starts late counts its lateness, and the next is due on the cadence, not after it", () => {
    const rows = onCadence([
      [0, 700, 0],
      [0, 0, 0],
    ]);
    const lateness = latenessOf(rows, order(2), interval);
    const first = lateness.filter((l) =>
      rows.some((r) => r.monitorId === "m0" && r.startedAt === l.at)
    );
    expect(first.map((l) => l.ms)).toEqual([0, 700, 0]);
  });

  test("the least late first run sets the boot, so a scheduler late from the start still reads late", () => {
    const rows = onCadence([
      [3000, 3000, 3000],
      [0, 0, 0],
    ]);
    const lateness = latenessOf(rows, order(2), interval);
    expect(Math.max(...lateness.map((l) => l.ms))).toBe(3000);
    expect(Math.min(...lateness.map((l) => l.ms))).toBe(0);
  });

  test("lateness keeps growing while the scheduler falls behind", () => {
    const rows = onCadence([
      [0, 5000, 10_000, 14_000],
      [0, 0, 0, 0],
    ]);
    const m0 = latenessOf(rows, order(2), interval)
      .filter((l) =>
        rows.some((r) => r.monitorId === "m0" && r.startedAt === l.at)
      )
      .map((l) => l.ms);
    expect(m0).toEqual([0, 5000, 10_000, 14_000]);
  });

  test("a check more than an interval late anchors the next one on its own start, as the scheduler does", () => {
    const m0 = [
      { monitorId: "m0", startedAt: boot },
      { monitorId: "m0", startedAt: boot + interval + 25_000 },
      { monitorId: "m0", startedAt: boot + 2 * interval + 25_000 + 1000 },
    ];
    const lateness = latenessOf(m0, ["m0"], interval).map((l) => l.ms);
    expect(lateness).toEqual([0, 25_000, 1000]);
  });

  test("at a short interval the first runs spread no further than one interval, as the scheduler caps them", () => {
    const short = 1000;
    const rows = Array.from({ length: 60 }, (_, index) => ({
      monitorId: `m${index}`,
      startedAt: boot + short,
    }));
    rows.push({ monitorId: "m0", startedAt: boot });
    const lateness = latenessOf(rows, order(60), short);
    // Monitor 1 is due half a second after the boot; every later one at the cap, one interval.
    expect(Math.max(...lateness.map((l) => l.ms))).toBe(500);
  });

  test("a check is placed at its start time", () => {
    const rows = onCadence([[0, 0]]);
    expect(latenessOf(rows, ["m0"], interval).map((l) => l.at)).toEqual(
      rows.map((r) => r.startedAt)
    );
  });

  test("a monitor with no rows is skipped", () => {
    expect(latenessOf(onCadence([[0]]), ["m0", "m9"], interval)).toHaveLength(
      1
    );
  });

  test("no rows give no lateness", () => {
    expect(latenessOf([], ["m0", "m1"], interval)).toEqual([]);
  });

  test("the median over a span shorter than a minute, such as a capacity step's measure", () => {
    const lateness = [
      { at: 5, ms: 900 },
      { at: 10, ms: 100 },
      { at: 15, ms: 300 },
      { at: 25, ms: 5000 },
    ];
    expect(medianLateness(lateness, 0, 20)).toBe(300);
    expect(medianLateness(lateness, 30, 50)).toBeNull();
  });

  test("each whole minute's median, with minutes that had no check left out", () => {
    const minutes = latenessByMinute(
      [
        { at: 0, ms: 10 },
        { at: 1000, ms: 30 },
        { at: 2000, ms: 20 },
        { at: 61_000, ms: 100 },
        { at: 181_000, ms: 5 },
        { at: 185_000, ms: 7 },
      ],
      0,
      240_000,
      interval
    );
    expect(minutes).toEqual([
      { checks: 3, late: 0, medianMs: 20, minute: 0 },
      { checks: 1, late: 0, medianMs: 100, minute: 60_000 },
      { checks: 2, late: 0, medianMs: 6, minute: 180_000 },
    ]);
  });

  test("a minute counts the checks that started past one interval and one tick", () => {
    const [minute] = latenessByMinute(
      [
        { at: 0, ms: 900 },
        { at: 1000, ms: 1999 },
        { at: 2000, ms: 2000 },
        { at: 3000, ms: 2001 },
        { at: 4000, ms: 5000 },
      ],
      0,
      60_000,
      1000
    );
    expect(minute?.late).toBe(2);
  });

  test("a check may start one interval and one tick after it was due before it is late, since the scheduler finds due checks once a tick", () => {
    expect(lateBoundMs(20_000)).toBe(20_000 + tickPeriodMs);
    expect(lateBoundMs(1000)).toBe(1000 + tickPeriodMs);
  });

  test("checks outside the span and in a last partial minute are left out", () => {
    const minutes = latenessByMinute(
      [
        { at: -1, ms: 99 },
        { at: 10, ms: 1 },
        { at: 60_000, ms: 50 },
        { at: 90_000, ms: 50 },
      ],
      0,
      90_000,
      interval
    );
    expect(minutes).toEqual([{ checks: 1, late: 0, medianMs: 1, minute: 0 }]);
  });
});

describe("RSS across the accelerated day", () => {
  test("the mean of each quarter of the span", () => {
    const samples = [0, 10, 20, 30, 40, 50, 60, 70].map((at, index) => ({
      at,
      value: index,
    }));
    expect(quarterMeans(samples, 0, 80)).toEqual([0.5, 2.5, 4.5, 6.5]);
  });

  test("a quarter with no sample is null", () => {
    expect(quarterMeans([{ at: 1, value: 5 }], 0, 80)).toEqual([
      5,
      null,
      null,
      null,
    ]);
  });

  test("still rising: each quarter from the second above the one before, the last at least the threshold above the second", () => {
    const mb = 2 ** 20;
    expect(stillRising([100 * mb, 101 * mb, 104 * mb, 107 * mb])).toBe(true);
    expect(stillRising([100 * mb, 120 * mb, 121 * mb, 122 * mb])).toBe(false);
    expect(stillRising([100 * mb, 101 * mb, 100 * mb, 108 * mb])).toBe(false);
    expect(
      stillRising([0, 100, 100 + rssRiseBytes - 2, 100 + rssRiseBytes - 1])
    ).toBe(false);
    expect(stillRising([0, 100, 101, 100 + rssRiseBytes])).toBe(true);
  });

  test("a quarter with no figure never reads as rising", () => {
    expect(stillRising([null, 1, 2 ** 30, null])).toBe(false);
    expect(stillRising([1, null, 2, 2 ** 30])).toBe(false);
  });
});

describe("the public page's scripts", () => {
  test("its script sources and module preloads, each once, in order", () => {
    const html = `<html><head>
      <link rel="modulepreload" href="/assets/a.js">
      <link rel="stylesheet" href="/assets/s.css">
      <script type="module" src="/assets/main.js"></script>
      <link rel="modulepreload" href="/assets/a.js"/>
      <link href="/assets/b.js" rel="modulepreload">
    </head><body><script>inline()</script></body></html>`;
    expect(scriptUrls(html)).toEqual([
      "/assets/a.js",
      "/assets/main.js",
      "/assets/b.js",
    ]);
  });

  test("single-quoted attributes and capitals read the same", () => {
    expect(
      scriptUrls(
        "<SCRIPT SRC='/assets/a.js'></SCRIPT><link rel='modulepreload' href='/assets/b.js'>"
      )
    ).toEqual(["/assets/a.js", "/assets/b.js"]);
  });

  test("a script on another origin is not the page's own", () => {
    const html =
      '<script src="https://cdn.example/x.js"></script><script src="//cdn.example/z.js"></script><script src="/assets/y.js"></script>';
    expect(scriptUrls(html)).toEqual(["/assets/y.js"]);
  });
});

describe("disk per monitor per day", () => {
  test("the sealed tables' bytes over the monitor-days they hold", () => {
    expect(
      diskPerMonitorDay(
        [
          { bytes: 400_000, name: "sealed_days" },
          { bytes: 300_000, name: "hourly_rollups" },
          { bytes: 100_000, name: "daily_rollups" },
          { bytes: 9_000_000, name: "checks" },
        ],
        100
      )
    ).toBe(8000);
  });

  test("the sealed tables' own primary-key indexes count with them, and no other table's", () => {
    expect(
      diskPerMonitorDay(
        [
          { bytes: 400_000, name: "sealed_days" },
          { bytes: 100_000, name: "sqlite_autoindex_sealed_days_1" },
          { bytes: 300_000, name: "hourly_rollups" },
          { bytes: 200_000, name: "sqlite_autoindex_hourly_rollups_1" },
          { bytes: 100_000, name: "daily_rollups" },
          { bytes: 50_000, name: "sqlite_autoindex_daily_rollups_1" },
          { bytes: 7_000_000, name: "sqlite_autoindex_checks_1" },
        ],
        100
      )
    ).toBe(11_500);
  });

  test("no monitor-day sealed gives no figure", () => {
    expect(
      diskPerMonitorDay([{ bytes: 4096, name: "sealed_days" }], 0)
    ).toBeNull();
  });
});

describe("the capacity sweep's rule", () => {
  const fine = {
    coldStartMs: 400,
    medianLatenessMs: 300,
    oom: "none",
  } as const;

  test("a count fits while its last minute's median lateness stays within one interval and one tick", () => {
    expect(stepFits(fine, 20_000)).toBe(true);
    expect(stepFits({ ...fine, medianLatenessMs: 21_000 }, 20_000)).toBe(true);
    expect(stepFits({ ...fine, medianLatenessMs: 21_001 }, 20_000)).toBe(false);
  });

  test("a count the kernel killed, that never answered, or that started no check does not fit", () => {
    expect(stepFits({ ...fine, oom: "killed" }, 20_000)).toBe(false);
    expect(stepFits({ ...fine, oom: "not-captured" }, 20_000)).toBe(false);
    expect(stepFits({ ...fine, coldStartMs: null }, 20_000)).toBe(false);
    expect(stepFits({ ...fine, medianLatenessMs: null }, 20_000)).toBe(false);
  });

  test.each([
    {
      expected: 400,
      steps: [
        [1600, false],
        [800, false],
        [400, true],
      ],
    },
    {
      expected: 3200,
      steps: [
        [1600, true],
        [3200, true],
        [6400, false],
      ],
    },
    {
      expected: 200,
      steps: [
        [200, true],
        [400, false],
        [800, true],
      ],
    },
    { expected: null, steps: [[200, false]] },
  ] as const)(
    "monitors that fit is the largest count that fit below every count that did not, whichever way the sweep went: $expected",
    ({ expected, steps }) => {
      expect(
        monitorsThatFit(steps.map(([monitors, fits]) => ({ fits, monitors })))
      ).toBe(expected);
    }
  );
});

describe("the capacity sweep's counts", () => {
  const bounds = { ceiling: 51_200, first: 1600, floor: 200 };
  const fit = (monitors: number) => ({ fits: true, monitors });
  const miss = (monitors: number) => ({ fits: false, monitors });

  test("starts at the first count", () => {
    expect(nextCapacityCount([], bounds)).toBe(1600);
  });

  test("a first count outside the bounds is brought inside them", () => {
    expect(nextCapacityCount([], { ...bounds, first: 100 })).toBe(200);
    expect(nextCapacityCount([], { ...bounds, first: 80_000 })).toBe(51_200);
  });

  test("doubles while every count fits", () => {
    expect(nextCapacityCount([fit(1600)], bounds)).toBe(3200);
    expect(nextCapacityCount([fit(1600), fit(3200)], bounds)).toBe(6400);
  });

  test("halves while no count fits", () => {
    expect(nextCapacityCount([miss(1600)], bounds)).toBe(800);
    expect(nextCapacityCount([miss(1600), miss(800)], bounds)).toBe(400);
  });

  test("stops once a count that fits sits beside one that does not, either way", () => {
    expect(nextCapacityCount([fit(1600), miss(3200)], bounds)).toBeUndefined();
    expect(nextCapacityCount([miss(1600), fit(800)], bounds)).toBeUndefined();
  });

  test("stops at the ceiling and below the floor", () => {
    expect(nextCapacityCount([fit(51_200)], bounds)).toBeUndefined();
    expect(
      nextCapacityCount([fit(12_800), fit(25_600)], {
        ...bounds,
        ceiling: 40_000,
      })
    ).toBeUndefined();
    expect(nextCapacityCount([miss(200)], bounds)).toBeUndefined();
  });

  test("a previous release's count that fits again takes two steps to find the next that does not", () => {
    const steps = [fit(12_800)];
    const next = nextCapacityCount(steps, { ...bounds, first: 12_800 });
    expect(next).toBe(25_600);
    expect(
      nextCapacityCount([...steps, miss(25_600)], { ...bounds, first: 12_800 })
    ).toBeUndefined();
  });
});

describe("the capacity sweep's ceiling", () => {
  test("every count fitting up to the largest is the ceiling, so the count that fits is a lower bound", () => {
    const steps = [200, 400, 800].map((monitors) => ({ fits: true, monitors }));
    expect(atCeiling(steps, 800)).toBe(true);
    expect(atCeiling(steps, 1600)).toBe(false);
    expect(atCeiling([...steps, { fits: false, monitors: 1600 }], 1600)).toBe(
      false
    );
    expect(atCeiling([], 800)).toBe(false);
  });
});

describe("the public page's JavaScript compressed", () => {
  const scripts = [
    new TextEncoder().encode("export const a = 1;\n".repeat(400)),
    new TextEncoder().encode("function b(x){return x*2}\n".repeat(300)),
  ];

  test("each script is compressed on its own and the sizes summed, as a server sends each file", () => {
    const sizes = compressedBytes(scripts);
    const each = (compress: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array) =>
      scripts.reduce((sum, bytes) => sum + compress(bytes).length, 0);
    expect(sizes.gzip).toBe(each((bytes) => Bun.gzipSync(bytes)));
    expect(sizes.zstd).toBe(
      each((bytes) => Bun.zstdCompressSync(bytes, { level: 3 }))
    );
  });

  test("zstd runs at level 3, neither a weaker nor a stronger level", async () => {
    // Real source, where the levels give different sizes; the repeated lines above compress alike at every level.
    const source = await Bun.file(`${import.meta.dir}/measure.ts`).bytes();
    const at = (level: number) =>
      Bun.zstdCompressSync(source, { level }).length;
    expect(new Set([at(1), at(3), at(19)]).size).toBe(3);
    expect(compressedBytes([source]).zstd).toBe(at(3));
  });

  test("no scripts weigh nothing", () => {
    expect(compressedBytes([])).toEqual({ gzip: 0, zstd: 0 });
  });
});

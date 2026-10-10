import { describe, expect, test } from "bun:test";
import {
  coverageOf,
  displayedUptime,
  downtimeWithin,
  type ObservedHour,
  observedSpans,
  rawFromOf,
  rawWindowMs,
  spansLength,
  uptimeReadings,
  uptimeWindowMs,
  without,
} from "./uptime.ts";

const t0 = 1_700_000_000_000;
const minute = 60_000;
const hour = 3_600_000;
const day = 86_400_000;
const limit = 2 * minute;

describe("observed time", () => {
  test("a monitor checked on time is observed from its first check to now", () => {
    const observed = observedSpans(
      { first: t0, gaps: [], last: t0 + 59 * minute },
      { from: t0 - hour, to: t0 + hour },
      limit,
      []
    );
    expect(observed).toEqual([{ from: t0, to: t0 + hour }]);
  });

  test("before the first check there is no data", () => {
    const observed = observedSpans(
      { first: t0 + 30 * minute, gaps: [], last: t0 + 59 * minute },
      { from: t0, to: t0 + hour },
      limit,
      []
    );
    expect(spansLength(observed)).toBe(30 * minute);
  });

  test("a gap longer than twice the interval is no data, whole", () => {
    const observed = observedSpans(
      {
        first: t0,
        gaps: [{ from: t0 + 10 * minute, to: t0 + 40 * minute }],
        last: t0 + 59 * minute,
      },
      { from: t0, to: t0 + hour },
      limit,
      []
    );
    expect(observed).toEqual([
      { from: t0, to: t0 + 10 * minute },
      { from: t0 + 40 * minute, to: t0 + hour },
    ]);
  });

  test("the time since the last check is observed while it is within the gap limit, and none of it once it is longer", () => {
    const window = { from: t0, to: t0 + hour };
    const recent = observedSpans(
      { first: t0, gaps: [], last: t0 + hour - limit },
      window,
      limit,
      []
    );
    expect(spansLength(recent)).toBe(hour);
    const silent = observedSpans(
      { first: t0, gaps: [], last: t0 + hour - limit - 1 },
      window,
      limit,
      []
    );
    expect(spansLength(silent)).toBe(hour - limit - 1);
  });

  test("a check before the window covers the window's start, so a window edge is not a gap", () => {
    const observed = observedSpans(
      { first: t0 - 5 * minute, gaps: [], last: t0 + 59 * minute },
      { from: t0, to: t0 + hour },
      limit,
      []
    );
    expect(observed).toEqual([{ from: t0, to: t0 + hour }]);
  });

  test("a maintenance window is not observed time", () => {
    const observed = observedSpans(
      { first: t0, gaps: [], last: t0 + 59 * minute },
      { from: t0, to: t0 + hour },
      limit,
      [
        { from: t0 + 10 * minute, to: t0 + 20 * minute },
        { from: t0 + 50 * minute, to: t0 + 2 * hour },
      ]
    );
    expect(observed).toEqual([
      { from: t0, to: t0 + 10 * minute },
      { from: t0 + 20 * minute, to: t0 + 50 * minute },
    ]);
  });

  test("no checks at all is no observed time", () => {
    expect(
      observedSpans(undefined, { from: t0, to: t0 + hour }, limit, [])
    ).toEqual([]);
  });
});

describe("downtime", () => {
  const observed = [
    { from: t0, to: t0 + 10 * minute },
    { from: t0 + 40 * minute, to: t0 + hour },
  ];

  test("is the outage time inside observed time", () => {
    expect(
      downtimeWithin(
        [{ endedAt: t0 + 5 * minute, startedAt: t0 + 2 * minute }],
        observed,
        t0 + hour
      )
    ).toBe(3 * minute);
  });

  test("an outage across a gap counts only its observed part", () => {
    expect(
      downtimeWithin(
        [{ endedAt: t0 + 45 * minute, startedAt: t0 + 5 * minute }],
        observed,
        t0 + hour
      )
    ).toBe(10 * minute);
  });

  test("an open outage runs to now", () => {
    expect(
      downtimeWithin(
        [{ endedAt: undefined, startedAt: t0 + 50 * minute }],
        observed,
        t0 + 55 * minute
      )
    ).toBe(5 * minute);
  });

  test("an outage inside a maintenance window is not downtime", () => {
    const maintained = observedSpans(
      { first: t0, gaps: [], last: t0 + 59 * minute },
      { from: t0, to: t0 + hour },
      limit,
      [{ from: t0 + 10 * minute, to: t0 + 20 * minute }]
    );
    expect(
      downtimeWithin(
        [{ endedAt: t0 + 20 * minute, startedAt: t0 + 10 * minute }],
        maintained,
        t0 + hour
      )
    ).toBe(0);
  });

  test("outages outside the window are not downtime", () => {
    expect(
      downtimeWithin(
        [{ endedAt: t0 - minute, startedAt: t0 - hour }],
        observed,
        t0 + hour
      )
    ).toBe(0);
  });
});

describe("the displayed uptime never flatters", () => {
  test("100% appears only with no downtime", () => {
    expect(displayedUptime({ downtimeMs: 0, observedMs: day })).toEqual({
      decimals: 0,
      percent: 100,
    });
    const one = displayedUptime({ downtimeMs: 1, observedMs: 90 * day });
    expect(one?.percent).toBeLessThan(100);
  });

  test("uptime is rounded down, never up", () => {
    // 99.98766...% reads 99.98, not 99.99.
    expect(
      displayedUptime({ downtimeMs: 1234, observedMs: 10_000_000 })
    ).toEqual({ decimals: 2, percent: 99.98 });
  });

  test("decimals grow from 2 up to 5 while the figure is all nines, so a small outage shows how small it was", () => {
    // 99.996%: at two places it would read 99.99, all nines.
    expect(displayedUptime({ downtimeMs: 4, observedMs: 100_000 })).toEqual({
      decimals: 3,
      percent: 99.996,
    });
    // 99.9999%: all nines at two, three and four places; at five it is 99.99990.
    expect(displayedUptime({ downtimeMs: 1, observedMs: 1_000_000 })).toEqual({
      decimals: 5,
      percent: 99.9999,
    });
    expect(displayedUptime({ downtimeMs: 1, observedMs: 10_000_000 })).toEqual({
      decimals: 5,
      percent: 99.999_99,
    });
    // Past five decimals it stops at the largest number under 100.
    expect(displayedUptime({ downtimeMs: 1, observedMs: 90 * day })).toEqual({
      decimals: 5,
      percent: 99.999_99,
    });
  });

  test("a whole outage reads 0%", () => {
    expect(displayedUptime({ downtimeMs: day, observedMs: day })).toEqual({
      decimals: 2,
      percent: 0,
    });
  });

  test("no observed time is no uptime", () => {
    expect(displayedUptime({ downtimeMs: 0, observedMs: 0 })).toBeUndefined();
  });
});

describe("the four windows", () => {
  test("each window ends now and reads the same coverage", () => {
    const now = t0 + 100 * day;
    const readings = uptimeReadings({
      coverage: { first: now - 10 * day, gaps: [], last: now - minute },
      excluded: [],
      gapLimitMs: limit,
      hours: [],
      now,
      outages: [{ endedAt: now - 2 * day + hour, startedAt: now - 2 * day }],
      rawFrom: now - 90 * day,
    });
    expect(readings.map((reading) => reading.window)).toEqual([
      "24h",
      "7d",
      "30d",
      "90d",
    ]);
    expect(readings[0]).toEqual({
      downtimeMs: 0,
      observedMs: uptimeWindowMs["24h"],
      window: "24h",
    });
    expect(readings[1]).toEqual({
      downtimeMs: hour,
      observedMs: uptimeWindowMs["7d"],
      window: "7d",
    });
    // The monitor is ten days old: the longer windows observe those ten days only.
    expect(readings[2]?.observedMs).toBe(10 * day);
    expect(readings[3]).toEqual({
      downtimeMs: hour,
      observedMs: 10 * day,
      window: "90d",
    });
  });
});

describe("the coverage of check times", () => {
  test("names the first and the last check and only the gaps longer than the limit", () => {
    expect(coverageOf([0, 10, 20, 100, 110, 200], 30)).toEqual({
      first: 0,
      gaps: [
        { from: 20, to: 100 },
        { from: 110, to: 200 },
      ],
      last: 200,
    });
  });

  test("a gap of exactly the limit is observed; only a longer one is not", () => {
    expect(coverageOf([0, 30, 60], 30)).toEqual({
      first: 0,
      gaps: [],
      last: 60,
    });
  });

  test("a time read twice is one check, and no times is no coverage", () => {
    expect(coverageOf([0, 10, 10, 20], 5)).toEqual({
      first: 0,
      gaps: [
        { from: 0, to: 10 },
        { from: 10, to: 20 },
      ],
      last: 20,
    });
    expect(coverageOf([], 5)).toBeUndefined();
  });
});

describe("uptime beyond the raw window", () => {
  /** A UTC day's start. */
  const now = 1_700_006_400_000;
  const rawFrom = now - rawWindowMs;

  function hours(from: number, count: number, observedMs: number) {
    return Array.from(
      { length: count },
      (_, index): ObservedHour => ({ at: from + index * hour, observedMs })
    );
  }

  test("the raw window is 30 days", () => {
    expect(rawWindowMs).toBe(30 * day);
  });

  test("before the raw window, observed time is the hourly rollups' observed time; inside it, the checks'", () => {
    const readings = uptimeReadings({
      coverage: { first: now - 31 * day, gaps: [], last: now - minute },
      excluded: [],
      gapLimitMs: limit,
      hours: hours(now - 90 * day, 60 * 24, 30 * minute),
      now,
      outages: [],
      rawFrom,
    });
    expect(readings.map((reading) => reading.observedMs)).toEqual([
      day,
      7 * day,
      30 * day,
      30 * day + 30 * day,
    ]);
  });

  test("an hour's downtime is its outage time, capped at its observed time", () => {
    const [reading] = uptimeReadings({
      coverage: undefined,
      excluded: [],
      gapLimitMs: limit,
      hours: [
        { at: rawFrom - 10 * hour, observedMs: 20 * minute },
        { at: rawFrom - 5 * hour, observedMs: hour },
      ],
      now,
      outages: [
        {
          endedAt: rawFrom - 9 * hour + 5 * minute,
          startedAt: rawFrom - 10 * hour - 5 * minute,
        },
        {
          endedAt: rawFrom - 5 * hour + 30 * minute,
          startedAt: rawFrom - 5 * hour + 15 * minute,
        },
      ],
      rawFrom,
    }).slice(3);
    expect(reading).toEqual({
      downtimeMs: 20 * minute + 15 * minute,
      observedMs: 20 * minute + hour,
      window: "90d",
    });
  });

  test("an hour the window's start cuts counts in proportion, its downtime too", () => {
    const later = now + 30 * minute;
    const edge = now - 90 * day;
    const [reading] = uptimeReadings({
      coverage: undefined,
      excluded: [],
      gapLimitMs: limit,
      hours: [
        { at: edge, observedMs: hour },
        { at: edge + hour, observedMs: 40 * minute },
      ],
      now: later,
      outages: [{ endedAt: edge + hour, startedAt: edge }],
      rawFrom: later - rawWindowMs,
    }).slice(3);
    expect(reading).toEqual({
      downtimeMs: 30 * minute,
      observedMs: 30 * minute + 40 * minute,
      window: "90d",
    });
  });

  test("the checks take over at the raw window's start: an hour after it is not read, and one across it counts only its part before", () => {
    const readings = uptimeReadings({
      coverage: undefined,
      excluded: [],
      gapLimitMs: limit,
      hours: [
        { at: rawFrom - 2 * hour, observedMs: hour },
        { at: rawFrom - 30 * minute, observedMs: hour },
        { at: rawFrom, observedMs: hour },
      ],
      now,
      outages: [],
      rawFrom,
    });
    expect(readings[2]?.observedMs).toBe(0);
    expect(readings[3]?.observedMs).toBe(hour + 30 * minute);
  });

  test("an hour partly observed and cut at a millisecond that is not a whole hour still reads whole milliseconds, which the displayed figure can take", () => {
    const later = now + 1_234_567;
    const edge = Math.floor((later - 90 * day) / hour) * hour;
    const [reading] = uptimeReadings({
      coverage: undefined,
      excluded: [],
      gapLimitMs: limit,
      hours: [
        { at: edge, observedMs: 3_599_000 },
        { at: edge + hour, observedMs: hour },
      ],
      now: later,
      outages: [{ endedAt: edge + hour + minute, startedAt: edge + hour }],
      rawFrom: later - rawWindowMs,
    }).slice(3);
    expect(Number.isInteger(reading?.observedMs)).toBe(true);
    expect(Number.isInteger(reading?.downtimeMs)).toBe(true);
    expect(reading && displayedUptime(reading)).toBeDefined();
  });
});

describe("where uptime's checks take over from the rollups", () => {
  /** A UTC day's start. */
  const now = 1_700_006_400_000 + 5 * hour;

  test("with checks from before the raw window, at the raw window's start", () => {
    expect(
      rawFromOf(
        { first: now - 31 * day, gaps: [], last: now - minute },
        now,
        rawWindowMs
      )
    ).toBe(now - rawWindowMs);
  });

  test("when a size-budget delete took the oldest raw days, at the start of the UTC day of the oldest check still kept", () => {
    expect(
      rawFromOf(
        { first: now - 12 * day + hour, gaps: [], last: now - minute },
        now,
        rawWindowMs
      )
    ).toBe(1_700_006_400_000 - 12 * day);
  });

  test("with no check at all, at now: the whole window reads the rollups", () => {
    expect(rawFromOf(undefined, now, rawWindowMs)).toBe(now);
  });
});

describe("spans with holes cut out", () => {
  test("every hole is cut out of every span it meets, and spans it misses stay whole", () => {
    expect(
      without(
        [
          { from: 0, to: 10 },
          { from: 20, to: 30 },
          { from: 40, to: 50 },
        ],
        [
          { from: 5, to: 22 },
          { from: 25, to: 26 },
        ]
      )
    ).toEqual([
      { from: 0, to: 5 },
      { from: 22, to: 25 },
      { from: 26, to: 30 },
      { from: 40, to: 50 },
    ]);
  });

  test("a hole that covers a span takes it whole, and no hole leaves the spans as they were", () => {
    expect(without([{ from: 10, to: 20 }], [{ from: 0, to: 30 }])).toEqual([]);
    expect(without([{ from: 10, to: 20 }], [])).toEqual([{ from: 10, to: 20 }]);
  });
});

describe("an outage inside a maintenance window beyond the raw window", () => {
  test("beyond the raw window, an outage inside a maintenance window is no downtime in the hour the rollups carry", () => {
    const hourAt = t0;
    const now = t0 + uptimeWindowMs["90d"];
    const readings = uptimeReadings({
      coverage: undefined,
      excluded: [{ from: hourAt, to: hourAt + 30 * minute }],
      gapLimitMs: limit,
      hours: [{ at: hourAt, observedMs: 30 * minute }],
      now,
      outages: [{ endedAt: hourAt + 30 * minute, startedAt: hourAt }],
      rawFrom: now,
    });
    expect(readings.find((each) => each.window === "90d")).toEqual({
      downtimeMs: 0,
      observedMs: 30 * minute,
      window: "90d",
    });
  });
});

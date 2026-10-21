import { describe, expect, test } from "bun:test";
import type { Outage } from "@/shared/schemas/outage.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  type CountedOutage,
  combine,
  countedOutages,
  figuresOf,
  type Measured,
  measure,
  worstOutages,
} from "./report.ts";

const hour = 3_600_000;
const minute = 60_000;
const day = 24 * hour;
const d0 = Date.UTC(2026, 8, 1);
/** Two UTC days: 1 and 2 September. */
const range = { from: d0, to: d0 + 2 * day };

function outage(
  startedAt: number,
  endedAt: number | undefined,
  more: Partial<Outage> = {}
): Outage {
  return {
    endedAt,
    monitorId: "m1",
    reason: reasons.timeout,
    startedAt,
    ...more,
  };
}

describe("the outages a report counts", () => {
  test("an outage inside the range counts its whole length, with when it was acknowledged and why it began", () => {
    const [counted] = countedOutages({
      covered: [],
      outages: [
        outage(d0 + 10 * hour, d0 + 12 * hour, {
          acknowledgedAt: d0 + 11 * hour,
        }),
      ],
      range,
    });
    expect(counted).toEqual({
      acknowledgedAt: d0 + 11 * hour,
      downtimeMs: 2 * hour,
      endedAt: d0 + 12 * hour,
      monitorId: "m1",
      reason: reasons.timeout,
      startedAt: d0 + 10 * hour,
    });
  });

  test("one across the range's start counts only the time inside it, and one across its end the same", () => {
    const counted = countedOutages({
      covered: [],
      outages: [
        outage(d0 - 3 * hour, d0 + hour),
        outage(range.to - 2 * hour, range.to + 5 * hour),
      ],
      range,
    });
    expect(counted.map((each) => each.downtimeMs)).toEqual([hour, 2 * hour]);
    // The record itself keeps its true start and end.
    expect(counted[0]).toMatchObject({
      endedAt: d0 + hour,
      startedAt: d0 - 3 * hour,
    });
  });

  test("one wholly before the range or wholly after it, or one that ended as the range began, is not counted", () => {
    expect(
      countedOutages({
        covered: [],
        outages: [
          outage(d0 - 5 * hour, d0 - 4 * hour),
          outage(d0 - 5 * hour, d0),
          outage(range.to, range.to + hour),
        ],
        range,
      })
    ).toEqual([]);
  });

  test("an open outage runs to the end of the range", () => {
    const [counted] = countedOutages({
      covered: [],
      outages: [outage(range.to - 90 * minute, undefined)],
      range,
    });
    expect(counted?.downtimeMs).toBe(90 * minute);
    expect(counted?.endedAt).toBeUndefined();
  });

  test("the time a maintenance window covered the monitor is cut out, and an outage wholly under one is not counted", () => {
    const counted = countedOutages({
      covered: [
        { from: d0 + 11 * hour, to: d0 + 13 * hour },
        { from: d0 + 20 * hour, to: d0 + 22 * hour },
      ],
      outages: [
        outage(d0 + 10 * hour, d0 + 12 * hour),
        outage(d0 + 20 * hour + 10 * minute, d0 + 21 * hour),
      ],
      range,
    });
    expect(counted).toHaveLength(1);
    expect(counted[0]?.downtimeMs).toBe(hour);
  });

  test("an outage never counts more of a day than the monitor was observed that day: no data is not downtime in the list either", () => {
    // Opened at 02:00 on the first day, still open, and the checks stopped after 5 hours observed that day.
    const [counted] = countedOutages({
      covered: [],
      observed: new Map([[d0, 5 * hour]]),
      outages: [outage(d0 + 2 * hour, undefined)],
      range,
    });
    expect(counted?.downtimeMs).toBe(5 * hour);
  });

  test("a day's observed time is shared among its outages in proportion, so their sum is the bars' day figure", () => {
    const counted = countedOutages({
      covered: [],
      observed: new Map([[d0, 6 * hour]]),
      outages: [
        outage(d0, d0 + 6 * hour),
        outage(d0 + 10 * hour, d0 + 16 * hour),
      ],
      range,
    });
    expect(counted.map((each) => each.downtimeMs)).toEqual([
      3 * hour,
      3 * hour,
    ]);
  });

  test("a day observed for longer than its outages leaves them whole, and an outage with no observed day at all is not counted", () => {
    const counted = countedOutages({
      covered: [],
      observed: new Map([[d0, 24 * hour]]),
      outages: [
        outage(d0 + hour, d0 + 3 * hour),
        outage(d0 + day + hour, d0 + day + 3 * hour),
      ],
      range,
    });
    expect(counted.map((each) => each.downtimeMs)).toEqual([2 * hour]);
  });

  test("they come oldest first whatever order they were read in", () => {
    const counted = countedOutages({
      covered: [],
      outages: [
        outage(d0 + 20 * hour, d0 + 21 * hour),
        outage(d0 + 2 * hour, d0 + 3 * hour),
      ],
      range,
    });
    expect(counted.map((each) => each.startedAt)).toEqual([
      d0 + 2 * hour,
      d0 + 20 * hour,
    ]);
  });
});

describe("what a range measures", () => {
  const days = [
    { day: d0, downtimeMs: hour, observedMs: 24 * hour },
    { day: d0 + day, downtimeMs: 30 * minute, observedMs: 20 * hour },
  ];

  function measured(over: Partial<Parameters<typeof measure>[0]> = {}) {
    return measure({
      days,
      degradedMs: 10 * minute,
      incidentIds: ["i1"],
      maintenance: [],
      outages: [],
      range,
      ...over,
    });
  }

  test("downtime and observed time are the days' sums, and the rest of the range is time with no data", () => {
    expect(measured()).toMatchObject({
      degradedMs: 10 * minute,
      downtimeMs: hour + 30 * minute,
      incidentIds: ["i1"],
      maintenanceMs: 0,
      noDataMs: 4 * hour,
      observedMs: 44 * hour,
    });
  });

  test("maintenance overlapping itself is counted once and cut to the range, and leaves the time with no data", () => {
    const result = measured({
      maintenance: [
        { from: d0 - 5 * hour, to: d0 + hour },
        { from: d0 + 30 * minute, to: d0 + 2 * hour },
        { from: range.to - hour, to: range.to + 3 * hour },
      ],
    });
    // 00:00 to 02:00 and the last hour: three hours of the four left over.
    expect(result.maintenanceMs).toBe(3 * hour);
    expect(result.noDataMs).toBe(hour);
  });

  test("a day with nothing observed adds no downtime, and a range with none is all no data", () => {
    const result = measured({
      days: [
        { day: d0, downtimeMs: 0, observedMs: 0 },
        { day: d0 + day, downtimeMs: 0, observedMs: 0 },
      ],
      degradedMs: 0,
    });
    expect(result).toMatchObject({
      downtimeMs: 0,
      noDataMs: 2 * day,
      observedMs: 0,
    });
  });

  test("time with no data is never negative, though observed time and maintenance may overlap in a gap", () => {
    const result = measured({
      days: [
        { day: d0, downtimeMs: 0, observedMs: 24 * hour },
        { day: d0 + day, downtimeMs: 0, observedMs: 24 * hour },
      ],
      maintenance: [{ from: d0, to: d0 + hour }],
    });
    expect(result.noDataMs).toBe(0);
  });
});

describe("members added up", () => {
  const shared: CountedOutage = {
    acknowledgedAt: undefined,
    downtimeMs: hour,
    endedAt: d0 + 2 * hour,
    monitorId: "m1",
    reason: reasons.timeout,
    startedAt: d0 + hour,
  };
  const own: CountedOutage = { ...shared, monitorId: "m2" };
  const a: Measured = {
    degradedMs: 1,
    downtimeMs: 10,
    incidentIds: ["i1", "i2"],
    maintenanceMs: 3,
    noDataMs: 4,
    observedMs: 100,
    outages: [shared],
  };
  const b: Measured = {
    degradedMs: 2,
    downtimeMs: 20,
    incidentIds: ["i2", "i3"],
    maintenanceMs: 5,
    noDataMs: 6,
    observedMs: 200,
    outages: [shared, own],
  };

  test("times are summed, so a member with more observed time weighs more", () => {
    expect(combine([a, b])).toMatchObject({
      degradedMs: 3,
      downtimeMs: 30,
      maintenanceMs: 8,
      noDataMs: 10,
      observedMs: 300,
    });
  });

  test("an outage or an incident two members share is counted once", () => {
    const sum = combine([a, b]);
    expect(sum.outages).toHaveLength(2);
    expect([...sum.incidentIds].sort()).toEqual(["i1", "i2", "i3"]);
  });

  test("nothing added up is nothing measured", () => {
    expect(combine([])).toEqual({
      degradedMs: 0,
      downtimeMs: 0,
      incidentIds: [],
      maintenanceMs: 0,
      noDataMs: 0,
      observedMs: 0,
      outages: [],
    });
  });
});

describe("the figures of a measurement", () => {
  function counted(
    startedAt: number,
    endedAt: number | undefined,
    acknowledgedAt?: number
  ): CountedOutage {
    return {
      acknowledgedAt,
      downtimeMs: (endedAt ?? range.to) - startedAt,
      endedAt,
      monitorId: "m1",
      reason: reasons.timeout,
      startedAt,
    };
  }
  const base = {
    degradedMs: 0,
    downtimeMs: 0,
    incidentIds: ["i1", "i2"],
    maintenanceMs: 0,
    noDataMs: 0,
    observedMs: day,
  };

  test("outages and incidents are counted, and time to recovery is the mean length of the outages that recovered", () => {
    const figures = figuresOf(
      {
        ...base,
        outages: [
          counted(d0 + hour, d0 + hour + 10 * minute),
          counted(d0 + 5 * hour, d0 + 5 * hour + 20 * minute),
          counted(d0 + 8 * hour, undefined),
        ],
      },
      range
    );
    expect(figures.outages).toBe(3);
    expect(figures.incidents).toBe(2);
    expect(figures.recoveryMs).toBe(15 * minute);
  });

  test("an outage that recovered after the range ended is not a recovery inside it", () => {
    const figures = figuresOf(
      {
        ...base,
        outages: [
          counted(d0 + hour, d0 + hour + 10 * minute),
          counted(range.to - hour, range.to + 5 * hour),
        ],
      },
      range
    );
    expect(figures.outages).toBe(2);
    expect(figures.recoveryMs).toBe(10 * minute);
  });

  test("one that began before the range and recovered inside it counts its whole length", () => {
    const figures = figuresOf(
      { ...base, outages: [counted(d0 - 2 * hour, d0 + hour)] },
      range
    );
    expect(figures.recoveryMs).toBe(3 * hour);
  });

  test("time to acknowledge is the mean wait of the outages that were acknowledged, open ones included", () => {
    const figures = figuresOf(
      {
        ...base,
        outages: [
          counted(d0 + hour, d0 + 2 * hour, d0 + hour + 2 * minute),
          counted(d0 + 5 * hour, d0 + 6 * hour, d0 + 5 * hour + 4 * minute),
          counted(d0 + 8 * hour, undefined, d0 + 8 * hour + 6 * minute),
          counted(d0 + 9 * hour, d0 + 10 * hour),
        ],
      },
      range
    );
    expect(figures.acknowledgeMs).toBe(4 * minute);
  });

  test("a mean with nothing to read is left out, not shown as zero", () => {
    const figures = figuresOf({ ...base, outages: [] }, range);
    expect(figures.recoveryMs).toBeUndefined();
    expect(figures.acknowledgeMs).toBeUndefined();
    expect(figures.outages).toBe(0);
  });

  test("the sums pass through unchanged", () => {
    expect(
      figuresOf(
        {
          degradedMs: 7,
          downtimeMs: 8,
          incidentIds: [],
          maintenanceMs: 9,
          noDataMs: 10,
          observedMs: 11,
          outages: [],
        },
        range
      )
    ).toMatchObject({
      degradedMs: 7,
      downtimeMs: 8,
      maintenanceMs: 9,
      noDataMs: 10,
      observedMs: 11,
    });
  });
});

describe("the worst outages", () => {
  function counted(startedAt: number, downtimeMs: number): CountedOutage {
    return {
      acknowledgedAt: undefined,
      downtimeMs,
      endedAt: startedAt + downtimeMs,
      monitorId: "m1",
      reason: reasons.timeout,
      startedAt,
    };
  }

  test("the longest come first, the earlier of two equal ones before the later, up to the limit", () => {
    const worst = worstOutages(
      [
        counted(d0 + 6 * hour, hour),
        counted(d0 + hour, 5 * hour),
        counted(d0 + 3 * hour, hour),
        counted(d0 + 9 * hour, 30 * minute),
      ],
      3
    );
    expect(worst.map((each) => each.startedAt)).toEqual([
      d0 + hour,
      d0 + 3 * hour,
      d0 + 6 * hour,
    ]);
  });
});

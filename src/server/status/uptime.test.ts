import { describe, expect, test } from "bun:test";
import type {
  Incident,
  IncidentStage,
  IncidentStatus,
} from "@/shared/schemas/incident.ts";
import {
  type ComponentDay,
  componentDays,
  dayDetails,
  incidentDowntime,
  type MonitorHistory,
  monitorObservedDays,
} from "./uptime.ts";

const day = 86_400_000;
const hour = 3_600_000;
const minute = 60_000;
/** A UTC midnight. */
const d0 = Date.UTC(2026, 8, 1);
const d1 = d0 + day;
const d2 = d1 + day;

describe("a monitor's observed time per UTC day", () => {
  test("today's observed time runs from the checks to now while the last check is recent", () => {
    const days = monitorObservedDays({
      coverage: { first: d1, gaps: [], last: d1 + 50 * minute },
      coverageFrom: d1,
      days: [],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + 50 * minute + 30_000,
    });
    expect(days.get(d1)).toBe(50 * minute + 30_000);
  });

  test("the time since the last check is not observed once it passes the gap limit, as while paused", () => {
    const days = monitorObservedDays({
      coverage: { first: d1, gaps: [], last: d1 + 10 * minute },
      coverageFrom: d1,
      days: [],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + 2 * hour,
    });
    expect(days.get(d1)).toBe(10 * minute);
  });

  test("a long gap between two checks is not observed", () => {
    const days = monitorObservedDays({
      coverage: {
        first: d1,
        gaps: [{ from: d1 + hour, to: d1 + 2 * hour }],
        last: d1 + 3 * hour,
      },
      coverageFrom: d1,
      days: [],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + 3 * hour,
    });
    expect(days.get(d1)).toBe(2 * hour);
  });

  test("a closed day no pass sealed yet reads from its checks, split at the UTC day boundary", () => {
    const days = monitorObservedDays({
      coverage: { first: d0 + 23 * hour, gaps: [], last: d1 + hour },
      coverageFrom: d0,
      days: [],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + hour,
    });
    expect(days.get(d0)).toBe(hour);
    expect(days.get(d1)).toBe(hour);
  });

  test("the rollups and the checks meet at the day the checks take over", () => {
    const days = monitorObservedDays({
      coverage: { first: d1, gaps: [], last: d1 + hour },
      coverageFrom: d1,
      days: [{ at: d0, observedMs: day }],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + hour,
    });
    expect([...days.entries()].toSorted(([a], [b]) => a - b)).toEqual([
      [d0, day],
      [d1, hour],
    ]);
  });

  test("a sealed day reads its rollup alone, whatever the checks' coverage says about it", () => {
    const days = monitorObservedDays({
      coverage: { first: d0 + 20 * hour, gaps: [], last: d1 + hour },
      coverageFrom: d1,
      days: [{ at: d0, observedMs: 10 * hour }],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + hour,
    });
    expect(days.get(d0)).toBe(10 * hour);
    expect(days.get(d1)).toBe(hour);
  });

  test("a day from where the checks take over reads the checks alone, never a rollup beside them", () => {
    const days = monitorObservedDays({
      coverage: { first: d1, gaps: [], last: d1 + hour },
      coverageFrom: d1,
      days: [{ at: d1, observedMs: 5 * hour }],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + hour,
    });
    expect(days.get(d1)).toBe(hour);
  });

  test("nothing before the range is read, and a day with no observed time is absent", () => {
    const days = monitorObservedDays({
      coverage: { first: d0 - hour, gaps: [], last: d0 + hour },
      coverageFrom: d0,
      days: [{ at: d0 - day, observedMs: day }],
      excluded: [],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + hour,
    });
    expect([...days.entries()]).toEqual([[d0, hour]]);
  });
});

function history(
  observed: readonly [number, number][],
  outages: MonitorHistory["outages"] = []
): MonitorHistory {
  return { covered: [], observed: new Map(observed), outages };
}

function cell(days: readonly ComponentDay[], at: number): ComponentDay {
  const found = days.find((each) => each.day === at);
  if (!found) {
    throw new Error(`no cell for ${at}`);
  }
  return found;
}

describe("a component's days", () => {
  test("the days run from the range's start through today, oldest first, today ending now", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [],
      now: d2 + 5 * hour,
    });
    expect(days.map((each) => each.day)).toEqual([d0, d1, d2]);
    expect(cell(days, d2).observedMs).toBe(5 * hour);
  });

  test("a day of a linked component observes as much as its most observed monitor", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [history([[d0, 10 * hour]]), history([[d0, 20 * hour]])],
      now: d1,
    });
    expect(cell(days, d0).observedMs).toBe(20 * hour);
  });

  test("downtime is the union of the linked monitors' outages, counted once where they overlap", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [
        history(
          [[d0, day]],
          [{ endedAt: d0 + 3 * hour, startedAt: d0 + hour }]
        ),
        history(
          [[d0, day]],
          [{ endedAt: d0 + 4 * hour, startedAt: d0 + 2 * hour }]
        ),
      ],
      now: d1,
    });
    expect(cell(days, d0).downtimeMs).toBe(3 * hour);
  });

  test("one monitor's outage is the component's downtime even while another linked monitor is up", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [
        history([[d0, day]], [{ endedAt: d0 + hour, startedAt: d0 }]),
        history([[d0, day]]),
      ],
      now: d1,
    });
    expect(cell(days, d0).downtimeMs).toBe(hour);
  });

  test("a day's downtime never exceeds its observed time", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [history([[d0, 5 * hour]], [{ endedAt: d1, startedAt: d0 }])],
      now: d1,
    });
    expect(cell(days, d0)).toEqual({
      day: d0,
      downtimeMs: 5 * hour,
      observedMs: 5 * hour,
    });
  });

  test("an open outage runs to now", () => {
    const days = componentDays({
      createdAt: d0,
      from: d1,
      incidents: [],
      maintenance: [],
      monitors: [
        history(
          [[d1, 2 * hour]],
          [{ endedAt: undefined, startedAt: d1 + hour }]
        ),
      ],
      now: d1 + 2 * hour,
    });
    expect(cell(days, d1).downtimeMs).toBe(hour);
  });

  test("an outage across midnight counts in each day it covers", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [
        history(
          [
            [d0, day],
            [d1, day],
          ],
          [{ endedAt: d1 + hour, startedAt: d0 + 23 * hour }]
        ),
      ],
      now: d2,
    });
    expect(cell(days, d0).downtimeMs).toBe(hour);
    expect(cell(days, d1).downtimeMs).toBe(hour);
  });

  test("a day on which every linked monitor was paused is no data (scenario 4)", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [history([[d0, day]])],
      now: d1 + 12 * hour,
    });
    expect(cell(days, d1)).toEqual({ day: d1, downtimeMs: 0, observedMs: 0 });
  });

  test("an unlinked component counts every moment since its creation as observed", () => {
    const days = componentDays({
      createdAt: d1 + 6 * hour,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [],
      now: d2 + 5 * hour,
    });
    expect(days.map((each) => each.observedMs)).toEqual([
      0,
      18 * hour,
      5 * hour,
    ]);
    expect(days.every((each) => each.downtimeMs === 0)).toBe(true);
  });

  test("the time an incident held an unlinked component down is its downtime", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [{ endedAt: d0 + 2 * hour, startedAt: d0 + hour }],
      maintenance: [],
      monitors: [],
      now: d1,
    });
    expect(cell(days, d0).downtimeMs).toBe(hour);
  });

  test("an incident's time is observed even where the linked monitors saw nothing", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [{ endedAt: d0 + 2 * hour, startedAt: d0 + hour }],
      maintenance: [],
      monitors: [history([])],
      now: d1,
    });
    expect(cell(days, d0)).toEqual({
      day: d0,
      downtimeMs: hour,
      observedMs: hour,
    });
  });

  test("an incident overlapping an outage counts once", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [{ endedAt: d0 + 3 * hour, startedAt: d0 + hour }],
      maintenance: [],
      monitors: [
        history([[d0, day]], [{ endedAt: d0 + 2 * hour, startedAt: d0 }]),
      ],
      now: d1,
    });
    expect(cell(days, d0).downtimeMs).toBe(3 * hour);
  });

  test("two components linked to the same monitor have the same days (scenario 1)", () => {
    const shared = history(
      [[d0, day]],
      [{ endedAt: d0 + hour, startedAt: d0 }]
    );
    const input = {
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [shared],
      now: d1,
    };
    expect(componentDays({ ...input, createdAt: d0 })).toEqual(
      componentDays({ ...input, createdAt: d0 + 12 * hour })
    );
  });
});

/** An incident from its updates, each at its time with its stage and statuses; resolved when its last update is. */
function incidentOf(
  id: string,
  updates: readonly [number, IncidentStage, readonly IncidentStatus[]][]
): Incident {
  const last = updates.at(-1);
  return {
    createdAt: updates[0]?.[0] ?? d0,
    id,
    impact: "major",
    resolvedAt: last?.[1] === "resolved" ? last[0] : undefined,
    title: { ar: id },
    updatedAt: d0,
    updates: updates.map(([createdAt, stage, statuses], index) => ({
      author: "owner@example.com",
      createdAt,
      id: `${id}-${index}`,
      message: { ar: "تحديث" },
      stage,
      statuses,
    })),
  };
}

const major = (componentId: string): IncidentStatus => ({
  componentId,
  status: "major_outage",
});

describe("the time incidents held a component down", () => {
  test("an update's status holds from its time to the incident's next update", () => {
    const spans = incidentDowntime([
      incidentOf("i", [
        [d0 + hour, "investigating", [major("web")]],
        [
          d0 + 3 * hour,
          "identified",
          [{ componentId: "web", status: "operational" }],
        ],
      ]),
    ]);
    expect(spans.get("web")).toEqual([
      { endedAt: d0 + 3 * hour, startedAt: d0 + hour },
    ]);
  });

  test("the latest update of an open incident holds on, with no end", () => {
    const spans = incidentDowntime([
      incidentOf("i", [[d0 + hour, "investigating", [major("web")]]]),
    ]);
    expect(spans.get("web")).toEqual([
      { endedAt: undefined, startedAt: d0 + hour },
    ]);
  });

  test("resolving ends the hold, even when the resolving update keeps the status", () => {
    const spans = incidentDowntime([
      incidentOf("i", [
        [d0 + hour, "investigating", [major("web")]],
        [d0 + 2 * hour, "resolved", [major("web")]],
      ]),
    ]);
    expect(spans.get("web")).toEqual([
      { endedAt: d0 + 2 * hour, startedAt: d0 + hour },
    ]);
  });

  test("partial outage is downtime as major outage is", () => {
    const spans = incidentDowntime([
      incidentOf("i", [
        [
          d0,
          "investigating",
          [{ componentId: "web", status: "partial_outage" }],
        ],
        [d0 + hour, "identified", [major("web")]],
        [d0 + 2 * hour, "resolved", [major("web")]],
      ]),
    ]);
    const held = (spans.get("web") ?? []).reduce(
      (total, span) => total + ((span.endedAt ?? 0) - span.startedAt),
      0
    );
    expect(held).toBe(2 * hour);
  });

  test("degraded performance and operational are never downtime, as a degraded monitor is never down", () => {
    const spans = incidentDowntime([
      incidentOf("i", [
        [
          d0,
          "investigating",
          [{ componentId: "web", status: "degraded_performance" }],
        ],
        [
          d0 + hour,
          "monitoring",
          [{ componentId: "web", status: "operational" }],
        ],
      ]),
    ]);
    expect(spans.get("web") ?? []).toEqual([]);
  });

  test("a component an update adds is held from that update on", () => {
    const spans = incidentDowntime([
      incidentOf("i", [
        [d0, "investigating", [major("web")]],
        [d0 + hour, "identified", [major("web"), major("api")]],
      ]),
    ]);
    expect(spans.get("api")).toEqual([
      { endedAt: undefined, startedAt: d0 + hour },
    ]);
  });

  test("each incident holds its own components, and a component nothing holds is absent", () => {
    const spans = incidentDowntime([
      incidentOf("a", [[d0, "investigating", [major("web")]]]),
      incidentOf("b", [
        [d0 + hour, "investigating", [major("api")]],
        [d0 + 2 * hour, "resolved", [major("api")]],
      ]),
    ]);
    expect(spans.get("web")).toEqual([{ endedAt: undefined, startedAt: d0 }]);
    expect(spans.get("api")).toEqual([
      { endedAt: d0 + 2 * hour, startedAt: d0 + hour },
    ]);
    expect(spans.has("other")).toBe(false);
  });

  test("an incident's hold is its component's downtime on the bar (scenario 2)", () => {
    const spans = incidentDowntime([
      incidentOf("i", [
        [d0 + hour, "investigating", [major("web")]],
        [
          d0 + 4 * hour,
          "resolved",
          [{ componentId: "web", status: "operational" }],
        ],
      ]),
    ]);
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: spans.get("web") ?? [],
      maintenance: [],
      monitors: [],
      now: d1,
    });
    expect(cell(days, d0)).toEqual({
      day: d0,
      downtimeMs: 3 * hour,
      observedMs: day,
    });
  });
});

describe("maintenance on a component's days", () => {
  test("the time a window covered a monitor leaves the monitor's observed time on the days its checks are read", () => {
    const days = monitorObservedDays({
      coverage: { first: d1, gaps: [], last: d1 + 10 * hour },
      coverageFrom: d1,
      days: [],
      excluded: [{ from: d1 + 2 * hour, to: d1 + 5 * hour }],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + 10 * hour,
    });
    expect(days.get(d1)).toBe(7 * hour);
  });

  test("a sealed day's observed time stays its rollup's, which left the covered time out when it was sealed", () => {
    const days = monitorObservedDays({
      coverage: undefined,
      coverageFrom: d1,
      days: [{ at: d0, observedMs: 20 * hour }],
      excluded: [{ from: d0 + 2 * hour, to: d0 + 6 * hour }],
      from: d0,
      gapLimitMs: 2 * minute,
      now: d1 + hour,
    });
    expect(days.get(d0)).toBe(20 * hour);
  });

  test("a window on the component is neither observed time nor downtime, though its monitor was down through it", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [{ from: d0 + 2 * hour, to: d0 + 5 * hour }],
      monitors: [
        {
          covered: [{ from: d0 + 2 * hour, to: d0 + 5 * hour }],
          observed: new Map([[d0, 21 * hour]]),
          outages: [{ endedAt: d0 + 6 * hour, startedAt: d0 + 3 * hour }],
        },
      ],
      now: d1,
    });
    expect(cell(days, d0)).toEqual({
      day: d0,
      downtimeMs: hour,
      observedMs: 21 * hour,
    });
  });

  test("an unlinked component under maintenance does not observe the window's time", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [{ from: d0 + 2 * hour, to: d0 + 5 * hour }],
      monitors: [],
      now: d1,
    });
    expect(cell(days, d0).observedMs).toBe(21 * hour);
  });

  test("an incident's hold inside a window on the component is not downtime", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [{ endedAt: d0 + 4 * hour, startedAt: d0 + hour }],
      maintenance: [{ from: d0 + 2 * hour, to: d0 + 5 * hour }],
      monitors: [],
      now: d1,
    });
    expect(cell(days, d0)).toEqual({
      day: d0,
      downtimeMs: hour,
      observedMs: 21 * hour,
    });
  });

  test("a covered monitor's outage is not downtime on another component it drives, where the window does not reach", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [],
      monitors: [
        {
          covered: [{ from: d0 + 2 * hour, to: d0 + 5 * hour }],
          observed: new Map([[d0, 21 * hour]]),
          outages: [{ endedAt: d0 + 6 * hour, startedAt: d0 + 3 * hour }],
        },
        history([[d0, day]]),
      ],
      now: d1,
    });
    expect(cell(days, d0)).toEqual({
      day: d0,
      downtimeMs: hour,
      observedMs: day,
    });
  });
});

describe("edges of maintenance on a component's days", () => {
  test("a window across midnight leaves each day its part", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [],
      maintenance: [{ from: d0 + 22 * hour, to: d1 + 3 * hour }],
      monitors: [],
      now: d2,
    });
    expect(cell(days, d0).observedMs).toBe(22 * hour);
    expect(cell(days, d1).observedMs).toBe(21 * hour);
  });
});

describe("an incident under maintenance on a day its monitors saw nothing", () => {
  test("its hold inside a window on the component is neither observed time nor downtime", () => {
    const days = componentDays({
      createdAt: d0,
      from: d0,
      incidents: [{ endedAt: d0 + 4 * hour, startedAt: d0 + hour }],
      maintenance: [{ from: d0 + 2 * hour, to: d0 + 5 * hour }],
      monitors: [history([])],
      now: d1,
    });
    expect(cell(days, d0)).toEqual({
      day: d0,
      downtimeMs: hour,
      observedMs: hour,
    });
  });
});

describe("what a day of the bar shows beside its uptime", () => {
  const none = { incidents: [], maintenance: [] };

  test("a day's response time weighs every timed check of its monitors the same", () => {
    const details = dayDetails({
      from: d0,
      notices: none,
      now: d0 + hour,
      response: [
        new Map([[d0, { averageMs: 100, timed: 3 }]]),
        new Map([[d0, { averageMs: 300, timed: 1 }]]),
      ],
    });
    expect(details.map((each) => each.responseMs)).toEqual([150]);
  });

  test("a day no monitor timed a check has no response time", () => {
    const details = dayDetails({
      from: d0,
      notices: none,
      now: d1 + hour,
      response: [new Map([[d1, { averageMs: 80, timed: 2 }]])],
    });
    expect(details.map((each) => each.responseMs)).toEqual([undefined, 80]);
  });

  test("a day's response time is whole milliseconds", () => {
    const details = dayDetails({
      from: d0,
      notices: none,
      now: d0 + hour,
      response: [
        new Map([[d0, { averageMs: 100, timed: 2 }]]),
        new Map([[d0, { averageMs: 101, timed: 1 }]]),
      ],
    });
    expect(details[0]?.responseMs).toBe(100);
  });

  test("an incident is named on every day it ran, from its creation to its resolution", () => {
    const details = dayDetails({
      from: d0,
      notices: {
        incidents: [
          {
            endedAt: d1 + hour,
            id: "i1",
            startedAt: d0 + 20 * hour,
            title: { ar: "بطء" },
          },
        ],
        maintenance: [],
      },
      now: d2 + hour,
      response: [],
    });
    expect(details.map((each) => each.incidents)).toEqual([
      [{ id: "i1", title: { ar: "بطء" } }],
      [{ id: "i1", title: { ar: "بطء" } }],
      [],
    ]);
  });

  test("an open incident is named on every day from its creation to today", () => {
    const details = dayDetails({
      from: d0,
      notices: {
        incidents: [
          {
            endedAt: undefined,
            id: "i1",
            startedAt: d1,
            title: { ar: "انقطاع" },
          },
        ],
        maintenance: [],
      },
      now: d2 + hour,
      response: [],
    });
    expect(details.map((each) => each.incidents.length)).toEqual([0, 1, 1]);
  });

  test("an incident resolved at midnight is not named on the day after", () => {
    const details = dayDetails({
      from: d0,
      notices: {
        incidents: [
          { endedAt: d1, id: "i1", startedAt: d0 + hour, title: { ar: "بطء" } },
        ],
        maintenance: [],
      },
      now: d1 + hour,
      response: [],
    });
    expect(details.map((each) => each.incidents.length)).toEqual([1, 0]);
  });

  test("an incident created and resolved at the same moment is named on its day", () => {
    const details = dayDetails({
      from: d0,
      notices: {
        incidents: [
          { endedAt: d1, id: "i1", startedAt: d1, title: { ar: "بطء" } },
        ],
        maintenance: [],
      },
      now: d1 + hour,
      response: [],
    });
    expect(details.map((each) => each.incidents.length)).toEqual([0, 1]);
  });

  test("a maintenance window is named on the days it ran, in the order given", () => {
    const details = dayDetails({
      from: d0,
      notices: {
        incidents: [],
        maintenance: [
          {
            endedAt: d0 + 3 * hour,
            id: "w1",
            startedAt: d0 + hour,
            title: { ar: "أ" },
          },
          {
            endedAt: d0 + 5 * hour,
            id: "w2",
            startedAt: d0 + 4 * hour,
            title: { ar: "ب" },
          },
        ],
      },
      now: d1 + hour,
      response: [],
    });
    expect(details.map((each) => each.maintenance.map((w) => w.id))).toEqual([
      ["w1", "w2"],
      [],
    ]);
  });

  test("a notice that ran before the bar's first day is not named", () => {
    const details = dayDetails({
      from: d1,
      notices: {
        incidents: [
          {
            endedAt: d0 + 2 * hour,
            id: "i1",
            startedAt: d0,
            title: { ar: "بطء" },
          },
        ],
        maintenance: [],
      },
      now: d1 + hour,
      response: [],
    });
    expect(details).toEqual([
      { incidents: [], maintenance: [], responseMs: undefined },
    ]);
  });
});

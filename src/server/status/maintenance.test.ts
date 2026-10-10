import { describe, expect, test } from "bun:test";
import type { MaintenanceStage } from "@/shared/schemas/maintenance.ts";
import {
  type ComponentLinks,
  coveredMonitors,
  coveredSpans,
  maintenanceSpans,
  nextEdge,
  underMaintenance,
  type WindowReach,
} from "./maintenance.ts";

const hour = 3_600_000;
const t0 = Date.UTC(2026, 8, 26, 10);

function window(
  stage: MaintenanceStage,
  componentIds: readonly string[],
  startsAt: number,
  endsAt: number
): WindowReach {
  return { componentIds, endsAt, stage, startsAt };
}

const links: readonly ComponentLinks[] = [
  { id: "web", monitorIds: ["site", "shared"] },
  { id: "api", monitorIds: ["shared", "gateway"] },
  { id: "docs", monitorIds: [] },
];

describe("the components under maintenance", () => {
  test("a window in progress puts every component it affects under maintenance", () => {
    expect(
      underMaintenance([window("in_progress", ["web", "docs"], t0, t0 + hour)])
    ).toEqual(new Set(["web", "docs"]));
  });

  test("a scheduled or completed window puts none under maintenance", () => {
    expect(
      underMaintenance([
        window("scheduled", ["web"], t0 + hour, t0 + 2 * hour),
        window("completed", ["api"], t0 - 2 * hour, t0 - hour),
      ])
    ).toEqual(new Set());
  });
});

describe("the monitors a window covers", () => {
  test("a window in progress covers every monitor linked to one of its components, whatever their other components show", () => {
    expect(
      coveredMonitors([window("in_progress", ["web"], t0, t0 + hour)], links)
    ).toEqual(new Set(["site", "shared"]));
  });

  test("a component linked to nothing covers no monitor", () => {
    expect(
      coveredMonitors([window("in_progress", ["docs"], t0, t0 + hour)], links)
    ).toEqual(new Set());
  });

  test("a window not in progress covers nothing", () => {
    expect(
      coveredMonitors(
        [
          window("scheduled", ["web"], t0 + hour, t0 + 2 * hour),
          window("completed", ["api"], t0 - 2 * hour, t0 - hour),
        ],
        links
      )
    ).toEqual(new Set());
  });
});

describe("the time a window held its components and covered its monitors", () => {
  const windows = [
    window("completed", ["web"], t0 - 5 * hour, t0 - 4 * hour),
    window("in_progress", ["web", "docs"], t0 - hour, t0 + hour),
    window("scheduled", ["api"], t0 + 2 * hour, t0 + 3 * hour),
  ];

  test("a started window holds each of its components from its start to its end, or to now while in progress", () => {
    const spans = maintenanceSpans(windows, t0);
    expect(spans.get("web")).toEqual([
      { from: t0 - 5 * hour, to: t0 - 4 * hour },
      { from: t0 - hour, to: t0 },
    ]);
    expect(spans.get("docs")).toEqual([{ from: t0 - hour, to: t0 }]);
  });

  test("a scheduled window holds nothing yet", () => {
    expect(maintenanceSpans(windows, t0).has("api")).toBe(false);
  });

  test("a monitor is covered for the spans of every window on a component linked to it, through the links as they are now", () => {
    const spans = coveredSpans(windows, links, t0);
    expect(spans.get("site")).toEqual([
      { from: t0 - 5 * hour, to: t0 - 4 * hour },
      { from: t0 - hour, to: t0 },
    ]);
    expect(spans.get("shared")).toEqual([
      { from: t0 - 5 * hour, to: t0 - 4 * hour },
      { from: t0 - hour, to: t0 },
    ]);
    expect(spans.has("gateway")).toBe(false);
  });

  test("a window whose end has passed while it is still in progress holds nothing past its end", () => {
    const late = [window("in_progress", ["web"], t0 - 2 * hour, t0 - hour)];
    expect(maintenanceSpans(late, t0).get("web")).toEqual([
      { from: t0 - 2 * hour, to: t0 - hour },
    ]);
  });
});

describe("when the scheduler next moves a window", () => {
  test("the soonest start of a scheduled window or end of one in progress", () => {
    expect(
      nextEdge([
        window("scheduled", ["web"], t0 + 3 * hour, t0 + 4 * hour),
        window("in_progress", ["api"], t0 - hour, t0 + 2 * hour),
        window("scheduled", ["docs"], t0 + hour, t0 + 5 * hour),
      ])
    ).toBe(t0 + hour);
    expect(
      nextEdge([window("in_progress", ["api"], t0 - hour, t0 + 2 * hour)])
    ).toBe(t0 + 2 * hour);
  });

  test("nothing when every window has completed", () => {
    expect(
      nextEdge([window("completed", ["web"], t0 - 2 * hour, t0 - hour)])
    ).toBeUndefined();
    expect(nextEdge([])).toBeUndefined();
  });
});

describe("edges of a window's reach", () => {
  test("a monitor linked to two components under two windows is covered for both, in start order", () => {
    const spans = coveredSpans(
      [
        window("completed", ["api"], t0 - 2 * hour, t0 - hour),
        window("completed", ["web"], t0 - 5 * hour, t0 - 4 * hour),
      ],
      links,
      t0
    );
    expect(spans.get("shared")).toEqual([
      { from: t0 - 5 * hour, to: t0 - 4 * hour },
      { from: t0 - 2 * hour, to: t0 - hour },
    ]);
  });

  test("a window that has not reached its start holds nothing, whatever its stage says", () => {
    expect(
      maintenanceSpans(
        [window("in_progress", ["web"], t0 + hour, t0 + 2 * hour)],
        t0
      ).has("web")
    ).toBe(false);
  });
});

describe("a window's reach follows its stage", () => {
  test("a scheduled window whose start has passed holds nothing until the scheduler starts it", () => {
    const due = [window("scheduled", ["web"], t0 - hour, t0 + hour)];
    expect(maintenanceSpans(due, t0).has("web")).toBe(false);
    expect(coveredMonitors(due, links)).toEqual(new Set());
  });
});

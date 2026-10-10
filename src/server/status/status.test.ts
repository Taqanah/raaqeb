import { describe, expect, test } from "bun:test";
import type { CheckResult } from "@/shared/schemas/check.ts";
import type { Component } from "@/shared/schemas/component.ts";
import type { Incident, IncidentStatus } from "@/shared/schemas/incident.ts";
import { type Monitor, monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { handSetLevels } from "@/shared/schemas/status.ts";
import {
  componentStatus,
  componentStatuses,
  derivedStatus,
  incidentStatuses,
  type LinkedMonitor,
  stateAtPause,
  summaryIndicator,
} from "./status.ts";

const t0 = 1_700_000_000_000;

function running(state: CheckResult | undefined): LinkedMonitor {
  return { paused: false, pausedAt: undefined, state };
}

function paused(state: CheckResult | undefined, at: number): LinkedMonitor {
  return { paused: true, pausedAt: at, state };
}

describe("the derived status of a component's linked monitors", () => {
  test("a component with no linked monitor has no derived status", () => {
    expect(derivedStatus([])).toBeUndefined();
  });

  test("every linked monitor down is a major outage", () => {
    expect(derivedStatus([running("down")])).toBe("major_outage");
    expect(derivedStatus([running("down"), running("down")])).toBe(
      "major_outage"
    );
  });

  test("some linked monitors down is a partial outage", () => {
    expect(derivedStatus([running("down"), running("up")])).toBe(
      "partial_outage"
    );
    expect(derivedStatus([running("degraded"), running("down")])).toBe(
      "partial_outage"
    );
  });

  test("none down but one degraded is degraded performance", () => {
    expect(derivedStatus([running("up"), running("degraded")])).toBe(
      "degraded_performance"
    );
  });

  test("every linked monitor up is operational", () => {
    expect(derivedStatus([running("up"), running("up")])).toBe("operational");
  });

  test("a monitor with no check yet counts as not down, so it keeps an outage partial", () => {
    expect(derivedStatus([running(undefined)])).toBe("operational");
    expect(derivedStatus([running("down"), running(undefined)])).toBe(
      "partial_outage"
    );
  });

  test("a paused monitor is ignored while another linked monitor runs", () => {
    expect(derivedStatus([paused("down", t0), running("up")])).toBe(
      "operational"
    );
    expect(derivedStatus([paused("up", t0), running("down")])).toBe(
      "major_outage"
    );
  });

  test("with every linked monitor paused, the last derived status stands", () => {
    expect(derivedStatus([paused("down", t0)])).toBe("major_outage");
    expect(derivedStatus([paused("degraded", t0)])).toBe(
      "degraded_performance"
    );
  });

  test("the last derived status is the one the monitors paused last derive, not a monitor paused long before", () => {
    // A was paused while down last week; B ran up until it was paused today, so the component read operational.
    expect(
      derivedStatus([paused("down", t0), paused("up", t0 + 7 * 86_400_000)])
    ).toBe("operational");
  });

  test("monitors paused in the same instant derive together", () => {
    expect(derivedStatus([paused("down", t0), paused("up", t0)])).toBe(
      "partial_outage"
    );
  });

  test("a paused monitor with no pause time counts as paused before any other", () => {
    expect(
      derivedStatus([
        { paused: true, pausedAt: undefined, state: "down" },
        paused("up", t0),
      ])
    ).toBe("operational");
  });
});

describe("the precedence of a component's status", () => {
  test("an active maintenance window shows under maintenance over everything", () => {
    expect(
      componentStatus({
        derived: "major_outage",
        handSet: "major_outage",
        incident: "major_outage",
        maintenance: true,
      })
    ).toBe("under_maintenance");
  });

  test("a linked component shows its derived status", () => {
    expect(
      componentStatus({
        derived: "partial_outage",
        handSet: "operational",
        incident: undefined,
        maintenance: false,
      })
    ).toBe("partial_outage");
  });

  test("a linked component ignores its hand-set status", () => {
    expect(
      componentStatus({
        derived: "operational",
        handSet: "major_outage",
        incident: undefined,
        maintenance: false,
      })
    ).toBe("operational");
  });

  test("the worse of the incident-set status and the derived status wins", () => {
    expect(
      componentStatus({
        derived: "major_outage",
        handSet: "operational",
        incident: "degraded_performance",
        maintenance: false,
      })
    ).toBe("major_outage");
    expect(
      componentStatus({
        derived: "operational",
        handSet: "operational",
        incident: "partial_outage",
        maintenance: false,
      })
    ).toBe("partial_outage");
  });

  test("an unlinked component with no incident keeps its hand-set status", () => {
    for (const level of handSetLevels) {
      expect(
        componentStatus({
          derived: undefined,
          handSet: level,
          incident: undefined,
          maintenance: false,
        })
      ).toBe(level);
    }
  });

  test("an unlinked component under an incident shows the incident's status, not its hand-set one", () => {
    expect(
      componentStatus({
        derived: undefined,
        handSet: "major_outage",
        incident: "degraded_performance",
        maintenance: false,
      })
    ).toBe("degraded_performance");
  });
});

function monitor(id: string, overrides: Partial<Monitor> = {}): Monitor {
  return {
    channels: [],
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "off",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: "https://example.test/",
    },
    createdAt: t0,
    events: [...monitorEventKinds],
    id,
    intervalMs: 60_000,
    name: id,
    paused: false,
    retries: 2,
    tags: [],
    target: "https://example.test/",
    timeoutMs: 10_000,
    updatedAt: t0,
    ...overrides,
  };
}

function component(id: string, overrides: Partial<Component> = {}): Component {
  return {
    createdAt: t0,
    description: undefined,
    id,
    monitorIds: [],
    name: { ar: id },
    status: "operational",
    updatedAt: t0,
    ...overrides,
  };
}

describe("every component's status now", () => {
  test("one monitor down drives every component linked to it (scenario 1)", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      incidents: new Map(),
      components: [
        component("web", { monitorIds: ["m"] }),
        component("api", { monitorIds: ["m"] }),
      ],
      monitors: [monitor("m")],
      states: new Map([["m", "down"]]),
    });
    expect(statuses.get("web")).toBe("major_outage");
    expect(statuses.get("api")).toBe("major_outage");
  });

  test("a component reads its own links' states and pause times", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      incidents: new Map(),
      components: [component("c", { monitorIds: ["a", "b"] })],
      monitors: [
        monitor("a", { paused: true, pausedAt: t0 }),
        monitor("b", { paused: true, pausedAt: t0 + 1000 }),
        monitor("x"),
      ],
      states: new Map<string, CheckResult>([
        ["a", "down"],
        ["b", "degraded"],
        ["x", "down"],
      ]),
    });
    expect(statuses.get("c")).toBe("degraded_performance");
  });

  test("an unlinked component shows its hand-set status", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      incidents: new Map(),
      components: [component("c", { status: "partial_outage" })],
      monitors: [],
      states: new Map(),
    });
    expect(statuses.get("c")).toBe("partial_outage");
  });

  test("a monitor with no check yet leaves a component it drives operational", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      incidents: new Map(),
      components: [component("c", { monitorIds: ["m"] })],
      monitors: [monitor("m")],
      states: new Map(),
    });
    expect(statuses.get("c")).toBe("operational");
  });

  test("a link to a monitor the list does not hold counts as no link", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      incidents: new Map(),
      components: [
        component("c", { monitorIds: ["gone"], status: "major_outage" }),
      ],
      monitors: [],
      states: new Map(),
    });
    expect(statuses.get("c")).toBe("major_outage");
  });

  test("every component gets a status", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      incidents: new Map(),
      components: [component("a"), component("b"), component("c")],
      monitors: [],
      states: new Map(),
    });
    expect([...statuses.keys()]).toEqual(["a", "b", "c"]);
  });
});

describe("a paused monitor's state once its checks are gone", () => {
  test("down when its newest outage ended the moment it was paused, as pausing ends an open one", () => {
    expect(stateAtPause(t0, { endedAt: t0 })).toBe("down");
  });

  test("nothing when its newest outage ended before the pause, is open, or there is none, or it has no pause time", () => {
    expect(stateAtPause(t0, { endedAt: t0 - 1 })).toBeUndefined();
    expect(stateAtPause(t0, { endedAt: undefined })).toBeUndefined();
    expect(stateAtPause(t0, undefined)).toBeUndefined();
    expect(stateAtPause(undefined, { endedAt: t0 })).toBeUndefined();
  });
});

/** An incident whose updates set these statuses in turn, a minute apart; resolved when `resolvedAt` is given. */
function incidentOf(
  id: string,
  updates: readonly (readonly IncidentStatus[])[],
  resolvedAt?: number
): Incident {
  return {
    createdAt: t0,
    id,
    impact: "major",
    resolvedAt,
    title: { ar: id },
    updatedAt: t0,
    updates: updates.map((statuses, index) => ({
      author: "owner@example.com",
      createdAt: t0 + index * 60_000,
      id: `${id}-${index}`,
      message: { ar: "تحديث" },
      stage:
        resolvedAt !== undefined && index === updates.length - 1
          ? "resolved"
          : "investigating",
      statuses,
    })),
  };
}

describe("the status open incidents set", () => {
  test("an open incident sets its latest update's status on each component it names", () => {
    const statuses = incidentStatuses([
      incidentOf("i", [
        [{ componentId: "web", status: "major_outage" }],
        [
          { componentId: "web", status: "degraded_performance" },
          { componentId: "api", status: "partial_outage" },
        ],
      ]),
    ]);
    expect(statuses).toEqual(
      new Map([
        ["web", "degraded_performance"],
        ["api", "partial_outage"],
      ])
    );
  });

  test("a resolved incident sets no status", () => {
    const statuses = incidentStatuses([
      incidentOf(
        "i",
        [
          [{ componentId: "web", status: "major_outage" }],
          [{ componentId: "web", status: "major_outage" }],
        ],
        t0 + 60_000
      ),
    ]);
    expect(statuses.size).toBe(0);
  });

  test("two open incidents on one component set the worse of their statuses", () => {
    const statuses = incidentStatuses([
      incidentOf("a", [[{ componentId: "web", status: "partial_outage" }]]),
      incidentOf("b", [[{ componentId: "web", status: "major_outage" }]]),
      incidentOf("c", [
        [{ componentId: "web", status: "degraded_performance" }],
      ]),
    ]);
    expect(statuses.get("web")).toBe("major_outage");
  });

  test("an open incident that sets operational still sets a status, which replaces a hand-set one", () => {
    const incidents = incidentStatuses([
      incidentOf("i", [[{ componentId: "c", status: "operational" }]]),
    ]);
    expect(incidents.get("c")).toBe("operational");
    const statuses = componentStatuses({
      maintenance: new Set(),
      components: [component("c", { status: "major_outage" })],
      incidents,
      monitors: [],
      states: new Map(),
    });
    expect(statuses.get("c")).toBe("operational");
  });

  test("an incident with no monitor sets an unlinked component's status (scenario 2)", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      components: [component("c"), component("other")],
      incidents: new Map([["c", "partial_outage"]]),
      monitors: [],
      states: new Map(),
    });
    expect(statuses.get("c")).toBe("partial_outage");
    expect(statuses.get("other")).toBe("operational");
  });

  test("an incident's status wins over a linked component's derived status only where it is worse", () => {
    const statuses = componentStatuses({
      maintenance: new Set(),
      components: [
        component("calm", { monitorIds: ["up"] }),
        component("red", { monitorIds: ["down"] }),
      ],
      incidents: new Map([
        ["calm", "degraded_performance"],
        ["red", "degraded_performance"],
      ]),
      monitors: [monitor("up"), monitor("down")],
      states: new Map<string, CheckResult>([
        ["up", "up"],
        ["down", "down"],
      ]),
    });
    expect(statuses.get("calm")).toBe("degraded_performance");
    expect(statuses.get("red")).toBe("major_outage");
  });
});

describe("a component under maintenance", () => {
  test("a component a window in progress affects is under maintenance, whatever its monitors and incidents say", () => {
    const statuses = componentStatuses({
      components: [
        component("web", { monitorIds: ["m"] }),
        component("api", { monitorIds: ["m"] }),
        component("docs", { status: "major_outage" }),
      ],
      incidents: new Map([["web", "major_outage"]]),
      maintenance: new Set(["web", "docs"]),
      monitors: [monitor("m")],
      states: new Map([["m", "down"]]),
    });
    expect(statuses.get("web")).toBe("under_maintenance");
    expect(statuses.get("docs")).toBe("under_maintenance");
    // The monitor is covered, but a component the window does not affect still follows it.
    expect(statuses.get("api")).toBe("major_outage");
  });
});

describe("the summary's indicator", () => {
  test("with no open incident it is the page level mapped", () => {
    expect(summaryIndicator("operational", [])).toBe("none");
    expect(summaryIndicator("under_maintenance", [])).toBe("maintenance");
    expect(summaryIndicator("degraded_performance", [])).toBe("minor");
    expect(summaryIndicator("partial_outage", [])).toBe("major");
    expect(summaryIndicator("major_outage", [])).toBe("critical");
  });

  test("an open incident's impact counts when it is worse than the level", () => {
    expect(summaryIndicator("operational", ["minor"])).toBe("minor");
    expect(summaryIndicator("degraded_performance", ["critical"])).toBe(
      "critical"
    );
    expect(summaryIndicator("under_maintenance", ["major"])).toBe("major");
  });

  test("the highest impact among the open incidents counts", () => {
    expect(summaryIndicator("operational", ["minor", "critical", "none"])).toBe(
      "critical"
    );
  });

  test("an incident with no impact never hides a worse page level", () => {
    expect(summaryIndicator("major_outage", ["none"])).toBe("critical");
    expect(summaryIndicator("operational", ["none"])).toBe("none");
  });

  test("maintenance is worse than none and better than any impact", () => {
    expect(summaryIndicator("under_maintenance", ["none"])).toBe("maintenance");
    expect(summaryIndicator("under_maintenance", ["minor"])).toBe("minor");
  });
});

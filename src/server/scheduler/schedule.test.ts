import { describe, expect, test } from "bun:test";
import { longestCheckMs } from "@/shared/domain/checks.ts";
import type { Check, CheckResult } from "@/shared/schemas/check.ts";
import type { Monitor, MonitorConfig } from "@/shared/schemas/monitor.ts";
import {
  monitorEventKinds,
  retriesMax,
  timeoutMaxMs,
} from "@/shared/schemas/monitor.ts";
import { type ReasonCode, reasons } from "@/shared/schemas/reason.ts";
import {
  afterCheck,
  arrivedWhileDown,
  bringForward,
  dueMonitors,
  eventsOf,
  movesCounter,
  reconcileSchedule,
  type Schedule,
  type Settlement,
  schedulable,
  sealingCutoff,
  sealingDelayMs,
  spreadFirstRuns,
  spreadWindowMs,
} from "./schedule.ts";

const t0 = 1_700_000_000_000;

const http: MonitorConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: "https://example.test/",
};

const heartbeat: MonitorConfig = {
  schedule: { everyMs: 3_600_000, kind: "every" },
  type: "heartbeat",
};

function monitor(id: string, overrides: Partial<Monitor> = {}): Monitor {
  return {
    config: http,
    createdAt: t0,
    id,
    intervalMs: 60_000,
    name: id,
    paused: false,
    retries: 2,
    channels: [],
    events: [...monitorEventKinds],
    tags: [],
    target: "https://example.test/",
    timeoutMs: 10_000,
    updatedAt: t0,
    ...overrides,
  };
}

function dueAt(schedule: Schedule, id: string): number | undefined {
  return schedule.get(id)?.nextDueAt;
}

describe("which monitors the scheduler runs", () => {
  test("an active HTTP, TCP or DNS monitor is schedulable", () => {
    expect(schedulable(monitor("a"))).toBe(true);
    expect(
      schedulable(monitor("b", { config: { host: "h", port: 1, type: "tcp" } }))
    ).toBe(true);
    expect(
      schedulable(
        monitor("c", { config: { name: "h", recordType: "A", type: "dns" } })
      )
    ).toBe(true);
  });

  test("a paused monitor runs no checks", () => {
    expect(schedulable(monitor("a", { paused: true }))).toBe(false);
  });

  test("an active heartbeat monitor is on the schedule too: its evaluation is its check", () => {
    expect(schedulable(monitor("a", { config: heartbeat }))).toBe(true);
    expect(schedulable(monitor("b", { config: heartbeat, paused: true }))).toBe(
      false
    );
  });
});

describe("first runs after boot", () => {
  test("are spread evenly over the window in list order, the first at boot", () => {
    const schedule = spreadFirstRuns(
      [monitor("a"), monitor("b"), monitor("c")],
      t0,
      "UTC"
    );
    expect(dueAt(schedule, "a")).toBe(t0);
    expect(dueAt(schedule, "b")).toBe(t0 + spreadWindowMs / 3);
    expect(dueAt(schedule, "c")).toBe(t0 + (2 * spreadWindowMs) / 3);
  });

  test("a first run is never later than the monitor's own interval", () => {
    const schedule = spreadFirstRuns(
      [
        monitor("a"),
        monitor("b"),
        monitor("c"),
        monitor("d", { intervalMs: 20_000 }),
      ],
      t0,
      "UTC"
    );
    expect(dueAt(schedule, "d")).toBe(t0 + 20_000);
    expect(dueAt(schedule, "c")).toBe(t0 + spreadWindowMs / 2);
  });

  test("a lone monitor runs at boot", () => {
    expect(dueAt(spreadFirstRuns([monitor("a")], t0, "UTC"), "a")).toBe(t0);
  });

  test("paused monitors are not on the schedule", () => {
    const schedule = spreadFirstRuns(
      [monitor("a", { paused: true }), monitor("c")],
      t0,
      "UTC"
    );
    expect([...schedule.keys()]).toEqual(["c"]);
    expect(dueAt(schedule, "c")).toBe(t0);
  });

  test("a heartbeat monitor's first window opens at boot and is evaluated a period plus grace later, since nothing could arrive while Raaqeb was stopped", () => {
    const schedule = spreadFirstRuns(
      [monitor("b", { config: heartbeat }), monitor("c"), monitor("d")],
      t0,
      "UTC"
    );
    expect(schedule.get("b")).toMatchObject({
      graceMs: 720_000,
      nextDueAt: t0 + 3_600_000 + 720_000,
      since: t0,
    });
    // Heartbeat monitors take no slot of the spread: the checks spread as if they were alone.
    expect(dueAt(schedule, "c")).toBe(t0);
    expect(dueAt(schedule, "d")).toBe(t0 + spreadWindowMs / 2);
  });

  test("a heartbeat monitor on a cron schedule is evaluated at its next fire time in the install time zone plus grace", () => {
    const daily = monitor("b", {
      config: {
        graceMs: 600_000,
        schedule: { expression: "0 3 * * *", kind: "cron" },
        type: "heartbeat",
      },
    });
    const boot = Date.UTC(2026, 8, 23, 12);
    const schedule = spreadFirstRuns([daily], boot, "Asia/Riyadh");
    expect(dueAt(schedule, "b")).toBe(Date.UTC(2026, 8, 24, 0) + 600_000);
  });

  test("a heartbeat monitor whose cron schedule never fires is never due", () => {
    const never = monitor("b", {
      config: {
        schedule: { expression: "0 0 30 2 *", kind: "cron" },
        type: "heartbeat",
      },
    });
    const schedule = spreadFirstRuns([never], t0, "UTC");
    expect(
      dueMonitors(schedule, new Set(), t0 + 10 * 365 * 86_400_000)
    ).toEqual([]);
  });
});

describe("picking up what the operator changed", () => {
  const before = spreadFirstRuns([monitor("a"), monitor("b")], t0, "UTC");

  test("a monitor new to the schedule is due now", () => {
    const after = reconcileSchedule(
      before,
      [monitor("a"), monitor("b"), monitor("c")],
      t0 + 5000,
      "UTC"
    );
    expect(dueAt(after, "c")).toBe(t0 + 5000);
  });

  test("a monitor edited since is due now; an unchanged one keeps its time", () => {
    const after = reconcileSchedule(
      before,
      [monitor("a", { updatedAt: t0 + 1 }), monitor("b")],
      t0 + 5000,
      "UTC"
    );
    expect(dueAt(after, "a")).toBe(t0 + 5000);
    expect(dueAt(after, "b")).toBe(dueAt(before, "b"));
  });

  test("a heartbeat monitor new to the schedule, edited or resumed opens its window now and is evaluated a period plus grace later", () => {
    const after = reconcileSchedule(
      before,
      [monitor("a"), monitor("b"), monitor("h", { config: heartbeat })],
      t0 + 5000,
      "UTC"
    );
    expect(after.get("h")).toMatchObject({
      nextDueAt: t0 + 5000 + 3_600_000 + 720_000,
      since: t0 + 5000,
    });
    const edited = reconcileSchedule(
      after,
      [
        monitor("a"),
        monitor("b"),
        monitor("h", { config: heartbeat, updatedAt: t0 + 7 }),
      ],
      t0 + 9000,
      "UTC"
    );
    expect(edited.get("h")).toMatchObject({
      nextDueAt: t0 + 9000 + 3_600_000 + 720_000,
      since: t0 + 9000,
    });
  });

  test("an unchanged heartbeat monitor keeps its window", () => {
    const first = reconcileSchedule(
      before,
      [monitor("h", { config: heartbeat })],
      t0 + 5000,
      "UTC"
    );
    const again = reconcileSchedule(
      first,
      [monitor("h", { config: heartbeat })],
      t0 + 60_000,
      "UTC"
    );
    expect(again.get("h")).toEqual(first.get("h"));
  });

  test("a changed time zone moves a cron window's end and keeps when it opened", () => {
    const daily = monitor("h", {
      config: {
        graceMs: 600_000,
        schedule: { expression: "0 3 * * *", kind: "cron" },
        type: "heartbeat",
      },
    });
    const noon = Date.UTC(2026, 8, 23, 12);
    const utc = spreadFirstRuns([daily], noon, "UTC");
    expect(utc.get("h")?.nextDueAt).toBe(Date.UTC(2026, 8, 24, 3) + 600_000);
    const riyadh = reconcileSchedule(utc, [daily], noon + 5000, "Asia/Riyadh");
    expect(riyadh.get("h")).toMatchObject({
      nextDueAt: Date.UTC(2026, 8, 24, 0) + 600_000,
      since: noon,
    });
  });

  test("a monitor deleted or paused leaves the schedule; a resumed one is due now", () => {
    const paused = reconcileSchedule(
      before,
      [monitor("b", { paused: true })],
      t0 + 5000,
      "UTC"
    );
    expect([...paused.keys()]).toEqual([]);
    const resumed = reconcileSchedule(
      paused,
      [monitor("b", { updatedAt: t0 + 2 })],
      t0 + 9000,
      "UTC"
    );
    expect(dueAt(resumed, "b")).toBe(t0 + 9000);
  });
});

describe("what is due", () => {
  const schedule = spreadFirstRuns([monitor("a"), monitor("b")], t0, "UTC");

  test("a monitor whose next run has come is due; one whose run is ahead is not", () => {
    expect(dueMonitors(schedule, new Set(), t0).map((m) => m.id)).toEqual([
      "a",
    ]);
    expect(
      dueMonitors(schedule, new Set(), t0 + spreadWindowMs).map((m) => m.id)
    ).toEqual(["a", "b"]);
  });

  test("a monitor with a check in flight is never due, however late its next run", () => {
    expect(
      dueMonitors(schedule, new Set(["a"]), t0 + spreadWindowMs).map(
        (m) => m.id
      )
    ).toEqual(["b"]);
  });

  test("after a check starts, the next run is one interval after this one was due, not after it started, so the tick's lateness never adds up", () => {
    const after = afterCheck(schedule, "a", t0 + 40, "UTC");
    expect(dueAt(after, "a")).toBe(t0 + 60_000);
    expect(dueAt(after, "b")).toBe(dueAt(schedule, "b"));
  });

  test("a check that starts more than an interval late anchors the next run on its own start, so runs never pile up to catch up", () => {
    const after = afterCheck(schedule, "a", t0 + 70_000, "UTC");
    expect(dueAt(after, "a")).toBe(t0 + 70_000 + 60_000);
  });

  test("a check of a monitor no longer on the schedule changes nothing", () => {
    expect(afterCheck(schedule, "zz", t0, "UTC")).toBe(schedule);
  });

  test("after a heartbeat evaluation the next window opens at it and closes a period plus grace later", () => {
    const beats = spreadFirstRuns(
      [monitor("h", { config: heartbeat })],
      t0,
      "UTC"
    );
    const evaluatedAt = t0 + 4_320_500;
    expect(afterCheck(beats, "h", evaluatedAt, "UTC").get("h")).toMatchObject({
      nextDueAt: evaluatedAt + 3_600_000 + 720_000,
      since: evaluatedAt,
    });
  });
});

describe("a heartbeat while down", () => {
  const schedule = spreadFirstRuns(
    [
      monitor("h", { config: heartbeat }),
      monitor("k", { config: heartbeat }),
      monitor("a"),
    ],
    t0,
    "UTC"
  );
  const down = new Map<string, CheckResult>([
    ["h", "down"],
    ["k", "down"],
    ["a", "down"],
  ]);

  test("a down heartbeat monitor that heard a heartbeat after its window opened is evaluated at once", () => {
    const heard = new Map([
      ["h", t0],
      ["k", t0 - 10],
    ]);
    expect(
      arrivedWhileDown(schedule, down, heard, new Set()).map((m) => m.id)
    ).toEqual(["h"]);
  });

  test("an up monitor, one with an evaluation in flight, and a check monitor are left to their schedule", () => {
    const heard = new Map([
      ["h", t0 + 10],
      ["k", t0 + 10],
      ["a", t0 + 10],
    ]);
    expect(
      arrivedWhileDown(
        schedule,
        new Map<string, CheckResult>([
          ["h", "up"],
          ["k", "down"],
          ["a", "down"],
        ]),
        heard,
        new Set(["k"])
      )
    ).toEqual([]);
  });
});

function check(result: CheckResult, reason: ReasonCode): Check {
  return {
    attempts: 1,
    bytes: 10,
    monitorId: "a",
    reason,
    responseMs: 100,
    result,
    startedAt: t0 + 7,
    statusCode: 200,
  };
}

function settled(
  previous: CheckResult | undefined,
  result: CheckResult,
  outage: { opened?: boolean; closed?: boolean } = {}
): Settlement {
  return {
    check: check(result, result === "down" ? reasons.timeout : reasons.ok),
    // An outage that opened a minute before this check and closed at it.
    closed: outage.closed
      ? {
          endedAt: t0 + 7,
          monitorId: "a",
          reason: reasons.timeout,
          startedAt: t0 + 7 - 60_000,
        }
      : undefined,
    opened: outage.opened ?? false,
    previous,
  };
}

describe("the monitor events a settled check raises", () => {
  test("an opened outage is the down event, carrying the check's time and reason and the outage it opened", () => {
    expect(eventsOf(settled("up", "down", { opened: true }))).toEqual([
      {
        at: t0 + 7,
        kind: "down",
        monitorId: "a",
        outage: {
          endedAt: undefined,
          monitorId: "a",
          reason: reasons.timeout,
          startedAt: t0 + 7,
        },
        reason: reasons.timeout,
      },
    ]);
  });

  test("a closed outage is the recovered event, carrying the outage it closed", () => {
    expect(eventsOf(settled("down", "up", { closed: true }))).toEqual([
      {
        at: t0 + 7,
        kind: "recovered",
        monitorId: "a",
        outage: {
          endedAt: t0 + 7,
          monitorId: "a",
          reason: reasons.timeout,
          startedAt: t0 + 7 - 60_000,
        },
        reason: reasons.ok,
      },
    ]);
  });

  test("a failing check while already down raises nothing", () => {
    expect(eventsOf(settled("down", "down"))).toEqual([]);
  });

  test("slow after fast is degraded started; fast after slow is degraded ended", () => {
    expect(eventsOf(settled("up", "degraded")).map((e) => e.kind)).toEqual([
      "degraded_started",
    ]);
    expect(eventsOf(settled("degraded", "up")).map((e) => e.kind)).toEqual([
      "degraded_ended",
    ]);
    expect(eventsOf(settled("degraded", "degraded"))).toEqual([]);
  });

  test("a first check that is slow starts degraded; a first check that is fast raises nothing", () => {
    expect(eventsOf(settled(undefined, "degraded")).map((e) => e.kind)).toEqual(
      ["degraded_started"]
    );
    expect(eventsOf(settled(undefined, "up"))).toEqual([]);
  });

  test("up after down with no outage to close (a pause closed it) is still recovered, carrying no outage: the state changed", () => {
    const events = eventsOf(settled("down", "up"));
    expect(events.map((e) => e.kind)).toEqual(["recovered"]);
    expect(events[0]).toMatchObject({ outage: undefined });
  });

  test("down after up with no outage opened (the monitor changed under the check) is still the down event, carrying no outage", () => {
    const events = eventsOf(settled("up", "down"));
    expect(events.map((e) => e.kind)).toEqual(["down"]);
    expect(events[0]).toMatchObject({ outage: undefined });
  });

  test("down after slow is the down event alone; slow after down recovers and starts degraded", () => {
    expect(
      eventsOf(settled("degraded", "down", { opened: true })).map((e) => e.kind)
    ).toEqual(["down"]);
    expect(
      eventsOf(settled("down", "degraded", { closed: true })).map((e) => e.kind)
    ).toEqual(["recovered", "degraded_started"]);
  });
});

describe("what moves the change counter", () => {
  test("a state transition does", () => {
    expect(movesCounter(settled("up", "down", { opened: true }))).toBe(true);
    expect(movesCounter(settled("down", "up", { closed: true }))).toBe(true);
    expect(movesCounter(settled("up", "degraded"))).toBe(true);
    expect(movesCounter(settled("degraded", "up"))).toBe(true);
  });

  test("every failing check while down does, so uptime figures and the day bar stay exact", () => {
    expect(movesCounter(settled("down", "down"))).toBe(true);
  });

  test("a first check does, whatever it says: the public page showed no data", () => {
    expect(movesCounter(settled(undefined, "up"))).toBe(true);
    expect(movesCounter(settled(undefined, "degraded"))).toBe(true);
  });

  test("up after down with no outage to close does: the state the page shows changed", () => {
    expect(movesCounter(settled("down", "up"))).toBe(true);
  });

  test("a check that changes nothing does not", () => {
    expect(movesCounter(settled("up", "up"))).toBe(false);
    expect(movesCounter(settled("degraded", "degraded"))).toBe(false);
  });
});

describe("check now brings a monitor's next check forward", () => {
  const boot = spreadFirstRuns(
    [monitor("a"), monitor("b"), monitor("h", { config: heartbeat })],
    t0,
    "UTC"
  );
  const ran = afterCheck(afterCheck(boot, "a", t0, "UTC"), "b", t0, "UTC");

  test("the monitor is due now; the others keep their time", () => {
    const now = t0 + 10_000;
    const next = bringForward(ran, new Set(["a"]), now);
    expect(dueAt(next, "a")).toBe(now);
    expect(dueAt(next, "b")).toBe(dueAt(ran, "b"));
    expect(dueMonitors(next, new Set(), now).map(({ id }) => id)).toEqual([
      "a",
    ]);
  });

  test("the cadence continues one interval after the check it brought forward", () => {
    const now = t0 + 10_000;
    const next = afterCheck(
      bringForward(ran, new Set(["a"]), now),
      "a",
      now,
      "UTC"
    );
    expect(dueAt(next, "a")).toBe(now + 60_000);
  });

  test("a monitor already due keeps its earlier time", () => {
    expect(dueAt(bringForward(boot, new Set(["a"]), t0 + 5000), "a")).toBe(t0);
  });

  test("a heartbeat monitor's window is never brought forward, and a monitor not on the schedule is not added", () => {
    const next = bringForward(ran, new Set(["h", "gone"]), t0 + 10_000);
    expect(dueAt(next, "h")).toBe(dueAt(ran, "h"));
    expect(next.has("gone")).toBe(false);
  });
});

describe("which closed days the sealing job may seal", () => {
  /** A UTC day's start. */
  const today = 1_700_006_400_000;
  const dayMs = 86_400_000;

  test("a day is safely closed once the longest check that could start in it has ended", () => {
    const longestCheck = longestCheckMs({
      retries: retriesMax,
      timeoutMs: timeoutMaxMs,
    });
    expect(sealingDelayMs).toBeGreaterThan(longestCheck);
  });

  test("until the delay has passed after midnight, yesterday stays open; from then on it may be sealed", () => {
    expect(sealingCutoff(today + sealingDelayMs - 1)).toBe(today - dayMs);
    expect(sealingCutoff(today + sealingDelayMs)).toBe(today);
    expect(sealingCutoff(today + dayMs - 1)).toBe(today);
  });
});

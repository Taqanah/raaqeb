import { describe, expect, test } from "bun:test";
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { HeartbeatConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  defaultGraceFraction,
  evaluateHeartbeat,
  evaluationAt,
  gapLimitMs,
  longestWindowMs,
  nextExpectedAt,
  scheduleFires,
} from "./heartbeat.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
// Wednesday 23 September 2026, 12:00 UTC.
const t0 = Date.UTC(2026, 8, 23, 12);

const everyFive: HeartbeatConfig = {
  schedule: { everyMs: 5 * minute, kind: "every" },
  type: "heartbeat",
};
const cron = (expression: string, graceMs?: number): HeartbeatConfig => ({
  graceMs,
  schedule: { expression, kind: "cron" },
  type: "heartbeat",
});

describe("when a heartbeat is expected", () => {
  test("every N expects one N after the window opened", () => {
    expect(nextExpectedAt(everyFive.schedule, t0, "UTC")).toBe(t0 + 5 * minute);
  });

  test("a cron expression expects one at its next fire time, read in the install time zone", () => {
    // 03:00 in Riyadh (UTC+3) is 00:00 UTC.
    expect(nextExpectedAt(cron("0 3 * * *").schedule, t0, "Asia/Riyadh")).toBe(
      Date.UTC(2026, 8, 24, 0)
    );
    expect(nextExpectedAt(cron("0 3 * * *").schedule, t0, "UTC")).toBe(
      Date.UTC(2026, 8, 24, 3)
    );
  });

  test("a fire time is strictly after the moment asked about, so an evaluation at a fire time looks to the next one", () => {
    const three = Date.UTC(2026, 8, 24, 3);
    expect(nextExpectedAt(cron("0 3 * * *").schedule, three, "UTC")).toBe(
      three + day
    );
  });

  test("a cron expression that never fires, 30 February, expects nothing", () => {
    expect(
      nextExpectedAt(cron("0 0 30 2 *").schedule, t0, "UTC")
    ).toBeUndefined();
    expect(scheduleFires(cron("0 0 30 2 *").schedule, t0, "UTC")).toBe(false);
  });

  test("an expression Bun cannot read never fires and never throws", () => {
    expect(scheduleFires(cron("not cron").schedule, t0, "UTC")).toBe(false);
    expect(
      nextExpectedAt(cron("not cron").schedule, t0, "UTC")
    ).toBeUndefined();
  });

  test("every N and a cron expression that fires do fire", () => {
    expect(scheduleFires(everyFive.schedule, t0, "UTC")).toBe(true);
    expect(scheduleFires(cron("@daily").schedule, t0, "UTC")).toBe(true);
  });
});

describe("when a window is evaluated", () => {
  test("the default grace period is a fifth of the period", () => {
    expect(defaultGraceFraction).toBe(0.2);
    expect(evaluationAt(everyFive, t0, "UTC")).toEqual({
      at: t0 + 5 * minute + minute,
      graceMs: minute,
    });
  });

  test("a monitor's own grace period replaces the default", () => {
    expect(evaluationAt({ ...everyFive, graceMs: 30_000 }, t0, "UTC")).toEqual({
      at: t0 + 5 * minute + 30_000,
      graceMs: 30_000,
    });
  });

  test("a cron schedule's default grace is a fifth of the gap from the expected fire to the one after it", () => {
    // Thursday 24 September 10:00: the next weekday fire is Friday 09:00, and the one after it is Monday 09:00.
    const thursday = Date.UTC(2026, 8, 24, 10);
    const friday = Date.UTC(2026, 8, 25, 9);
    expect(evaluationAt(cron("0 9 * * 1-5"), thursday, "UTC")).toEqual({
      at: friday + (3 * day) / 5,
      graceMs: (3 * day) / 5,
    });
    // From Friday 10:00 the next is Monday 09:00, followed a day later by Tuesday's.
    const monday = Date.UTC(2026, 8, 28, 9);
    expect(evaluationAt(cron("0 9 * * 1-5"), friday + hour, "UTC")).toEqual({
      at: monday + 0.2 * day,
      graceMs: 0.2 * day,
    });
  });

  test("a schedule that never fires is never evaluated", () => {
    expect(evaluationAt(cron("0 0 30 2 *"), t0, "UTC")).toBeUndefined();
  });
});

describe("one window's check", () => {
  const window = {
    graceMs: minute,
    monitorId: "m1",
    now: t0 + 6 * minute,
    since: t0,
  };

  test("a heartbeat after the window opened makes it up, with no response time and one attempt", () => {
    expect(
      evaluateHeartbeat({ ...window, lastArrivedAt: t0 + 4 * minute })
    ).toEqual({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: "m1",
        reason: reasons.ok,
        responseMs: undefined,
        result: "up",
        startedAt: t0 + 6 * minute,
        statusCode: undefined,
      },
      detail: undefined,
    });
  });

  test("no heartbeat since the window opened makes it down with heartbeat late and the grace period it allowed", () => {
    const late: CheckOutcome = {
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: "m1",
        reason: reasons.heartbeat_late,
        responseMs: undefined,
        result: "down",
        startedAt: t0 + 6 * minute,
        statusCode: undefined,
      },
      detail: {
        assertion: undefined,
        error: undefined,
        monitorId: "m1",
        params: { graceMs: minute, reason: "heartbeat_late" },
        startedAt: t0 + 6 * minute,
      },
    };
    expect(
      evaluateHeartbeat({ ...window, lastArrivedAt: t0 - minute })
    ).toEqual(late);
    expect(evaluateHeartbeat({ ...window, lastArrivedAt: undefined })).toEqual(
      late
    );
  });

  test("a heartbeat at the very moment the window opened counts for it; one at the moment of the evaluation belongs to the next window", () => {
    expect(
      evaluateHeartbeat({ ...window, lastArrivedAt: t0 }).check.result
    ).toBe("up");
    expect(
      evaluateHeartbeat({ ...window, lastArrivedAt: t0 + 6 * minute }).check
        .result
    ).toBe("down");
  });
});

describe("a heartbeat monitor's longest window, which sets its gap limit", () => {
  test("every N: the period plus the grace period", () => {
    expect(longestWindowMs(everyFive, t0, "UTC")).toBe(6 * minute);
    expect(longestWindowMs({ ...everyFive, graceMs: 30_000 }, t0, "UTC")).toBe(
      5.5 * minute
    );
  });

  test("a cron expression: its longest gap between fires plus the grace, so a weekday job's weekend is one window", () => {
    expect(longestWindowMs(cron("0 9 * * 1-5"), t0, "UTC")).toBe(
      (3 * day * 6) / 5
    );
    expect(longestWindowMs(cron("0 9 * * 1-5", hour), t0, "UTC")).toBe(
      3 * day + hour
    );
    expect(longestWindowMs(cron("* * * * *"), t0, "UTC")).toBe(
      (minute * 6) / 5
    );
  });

  test("a schedule that never fires has no window", () => {
    expect(longestWindowMs(cron("0 0 30 2 *"), t0, "UTC")).toBeUndefined();
  });
});

describe("the gap limit of observed time", () => {
  const tcp = { host: "example.test", port: 443, type: "tcp" } as const;

  test("is twice the interval, or twice a heartbeat monitor's longest window", () => {
    expect(gapLimitMs({ config: tcp, intervalMs: 5 * minute }, t0, "UTC")).toBe(
      10 * minute
    );
    expect(
      gapLimitMs({ config: everyFive, intervalMs: minute }, t0, "UTC")
    ).toBe(12 * minute);
  });

  test("a heartbeat schedule that never fires falls back to twice the interval", () => {
    expect(
      gapLimitMs({ config: cron("0 0 30 2 *"), intervalMs: minute }, t0, "UTC")
    ).toBe(2 * minute);
  });
});

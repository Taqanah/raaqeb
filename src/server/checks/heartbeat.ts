/**
 * A heartbeat monitor's evaluation (CONTEXT.md "Heartbeat monitor", "Grace
 * period"): once per expected period plus
 * grace period it writes one check, up when a heartbeat arrived since the
 * window opened, otherwise down with "heartbeat late" and no response time.
 * "Every N" expects a heartbeat N after the window opens; a cron expression
 * at its next fire time in the install time zone, read by `Bun.cron.parse`.
 * The grace period, when the monitor sets none, is a fifth of the period
 * that follows the expected time. Pure: `now` and the latest heartbeat are
 * parameters.
 */
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type {
  HeartbeatConfig,
  HeartbeatSchedule,
  Monitor,
} from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";

/** A monitor without its own grace period waits this fraction of the period. */
export const defaultGraceFraction = 0.2;

/** Each monitor keeps its latest heartbeats up to this many; the evaluation prunes the rest. */
export const heartbeatsKept = 100;

/** The first time strictly after `after` at which the schedule expects a heartbeat, or nothing when it never fires. */
export function nextExpectedAt(
  schedule: HeartbeatSchedule,
  after: number,
  timeZone: string
): number | undefined {
  if (schedule.kind === "every") {
    return after + schedule.everyMs;
  }
  // Bun answers the next matching minute after the moment given, never the moment itself.
  return nextFire(schedule.expression, after, timeZone)?.getTime();
}

function nextFire(
  expression: string,
  after: number,
  timeZone: string
): Date | null {
  try {
    return Bun.cron.parse(expression, after, { tz: timeZone });
  } catch {
    // A stored expression this Bun cannot read, or a time zone it does not know: the schedule never fires.
    return null;
  }
}

/** When a window opened at `from` is evaluated: the next expected time plus the grace period; nothing when the schedule never fires. */
export function evaluationAt(
  config: HeartbeatConfig,
  from: number,
  timeZone: string
): { readonly at: number; readonly graceMs: number } | undefined {
  const expected = nextExpectedAt(config.schedule, from, timeZone);
  if (expected === undefined) {
    return;
  }
  let { graceMs } = config;
  if (graceMs === undefined) {
    // The period is the gap to the fire after the expected one: Bun's parser only looks forward.
    const following = nextExpectedAt(config.schedule, expected, timeZone);
    graceMs = Math.round(
      defaultGraceFraction * ((following ?? expected) - expected)
    );
  }
  return { at: expected + graceMs, graceMs };
}

/** A cron schedule's longest window is looked for over this many fires from `from`. */
export const windowSampleFires = 512;

/**
 * The longest window of a heartbeat monitor, its period plus grace period:
 * for "every N", N plus the grace; for a cron expression, the longest gap
 * between two fires over the next `windowSampleFires` fires, plus the grace
 * that gap gets. Twice this is the gap limit of observed time (CONTEXT.md
 * "Observed time"). Nothing when the schedule never fires.
 */
export function longestWindowMs(
  config: HeartbeatConfig,
  from: number,
  timeZone: string
): number | undefined {
  const { schedule } = config;
  let longest: number;
  if (schedule.kind === "every") {
    longest = schedule.everyMs;
  } else {
    let fire = nextExpectedAt(schedule, from, timeZone);
    if (fire === undefined) {
      return;
    }
    longest = 0;
    for (let index = 1; index < windowSampleFires; index += 1) {
      const next = nextExpectedAt(schedule, fire, timeZone);
      if (next === undefined) {
        break;
      }
      longest = Math.max(longest, next - fire);
      fire = next;
    }
  }
  return (
    longest + (config.graceMs ?? Math.round(defaultGraceFraction * longest))
  );
}

/**
 * The gap limit of a monitor's observed time (CONTEXT.md "Observed time"):
 * twice its interval, or for a heartbeat monitor twice its longest window,
 * its expected period plus grace period. A heartbeat
 * schedule that never fires has no window; its limit is twice the interval.
 * The detail read and the sealing pass both judge observed time by it.
 */
export function gapLimitMs(
  monitor: Pick<Monitor, "config" | "intervalMs">,
  now: number,
  timeZone: string
): number {
  const window =
    monitor.config.type === "heartbeat"
      ? longestWindowMs(monitor.config, now, timeZone)
      : undefined;
  return 2 * (window ?? monitor.intervalMs);
}

/** Whether the schedule fires at all, in this time zone, after `now`: a cron expression for 30 February parses and never does. */
export function scheduleFires(
  schedule: HeartbeatSchedule,
  now: number,
  timeZone: string
): boolean {
  return nextExpectedAt(schedule, now, timeZone) !== undefined;
}

export interface HeartbeatEvaluation {
  /** The grace period the window allowed, kept in the reason of a late heartbeat. */
  readonly graceMs: number;
  /** The latest heartbeat's arrival, or nothing when the monitor has none. */
  readonly lastArrivedAt: number | undefined;
  readonly monitorId: string;
  readonly now: number;
  /** When the window opened: the last evaluation, or when the monitor was created, edited or resumed, or the boot. */
  readonly since: number;
}

/** The one check of a window: up when a heartbeat arrived from its opening to the evaluation, otherwise down with "heartbeat late", its grace period and no response time. */
export function evaluateHeartbeat({
  graceMs,
  lastArrivedAt,
  monitorId,
  now,
  since,
}: HeartbeatEvaluation): CheckOutcome {
  // A window is half-open: a heartbeat at its opening counts for it, one at the evaluation for the next.
  const heard =
    lastArrivedAt !== undefined &&
    lastArrivedAt >= since &&
    lastArrivedAt < now;
  return {
    capture: undefined,
    check: {
      attempts: 1,
      bytes: 0,
      monitorId,
      reason: heard ? reasons.ok : reasons.heartbeat_late,
      responseMs: undefined,
      result: heard ? "up" : "down",
      startedAt: now,
      statusCode: undefined,
    },
    detail: heard
      ? undefined
      : {
          assertion: undefined,
          error: undefined,
          monitorId,
          params: { graceMs, reason: "heartbeat_late" },
          startedAt: now,
        },
  };
}

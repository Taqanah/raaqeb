/**
 * The scheduler's pure rules (ADR-0007): which monitors are due,
 * when the first runs go after boot, when the next run of a monitor is, what
 * a settled check means for the monitor's state, and which settlements move
 * the change counter; for a heartbeat monitor, when its window opens and
 * closes; which closed days the sealing job may seal. Nothing here does
 * I/O; `now` is a parameter.
 */

import { evaluationAt } from "@/server/checks/heartbeat.ts";
import type { CertificateWarning } from "@/shared/schemas/certificate.ts";
import type { Check, CheckResult } from "@/shared/schemas/check.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import type { ReasonCode } from "@/shared/schemas/reason.ts";
import { rollupSpanMs } from "@/shared/schemas/rollup.ts";

/** The scheduler looks for due monitors this often. */
export const tickPeriodMs = 1000;

/** How often the tick moves the change counter with nothing else changed, so the figures that grow with the clock alone (today's cell, a window's uptime) reach a memoised page within five minutes. */
export const refreshPeriodMs = 5 * 60_000;

/** First runs after boot are spread over this window, each capped by its monitor's interval, so a restart never fires every check at once. */
export const spreadWindowMs = 30_000;

/** The sealing job seals a closed UTC day this long after its end: past `longestCheckMs` at the form's limits (shared/domain/checks.ts), so no check of the day is still in flight. */
export const sealingDelayMs = 15 * 60_000;

/** Every day that starts before this is safely closed: the start of the UTC day `sealingDelayMs` ago. */
export function sealingCutoff(now: number): number {
  const { day } = rollupSpanMs;
  return Math.floor((now - sealingDelayMs) / day) * day;
}

/** A monitor on the schedule and when its next check is due. */
export interface ScheduleEntry {
  /** A heartbeat monitor's grace period for the window, kept in a late heartbeat's reason. */
  readonly graceMs: number;
  readonly monitor: Monitor;
  readonly nextDueAt: number;
  /** When a heartbeat monitor's window opened: a heartbeat after it counts. */
  readonly since: number;
}

/** The monitors the scheduler runs, by id. */
export type Schedule = ReadonlyMap<string, ScheduleEntry>;

/** Whether the scheduler runs this monitor: every active monitor; a heartbeat monitor's run is the evaluation of its window. */
export function schedulable(monitor: Monitor): boolean {
  return !monitor.paused;
}

/** A heartbeat monitor's entry for a window opened at `since`: evaluated at the next expected time plus grace, never when the schedule never fires. */
function windowEntry(
  monitor: Monitor,
  since: number,
  timeZone: string
): ScheduleEntry {
  const evaluation =
    monitor.config.type === "heartbeat"
      ? evaluationAt(monitor.config, since, timeZone)
      : undefined;
  return {
    graceMs: evaluation?.graceMs ?? 0,
    monitor,
    nextDueAt: evaluation?.at ?? Number.POSITIVE_INFINITY,
    since,
  };
}

/**
 * The schedule at boot: every schedulable monitor. The first checks are
 * spread evenly over the window from `bootAt`, each no later than its own
 * interval; a heartbeat monitor's first window opens at boot, since nothing
 * could arrive while Raaqeb was stopped, and takes no slot of the spread.
 */
export function spreadFirstRuns(
  monitors: readonly Monitor[],
  bootAt: number,
  timeZone: string
): Schedule {
  const runnable = monitors.filter(schedulable);
  const checked = runnable.filter(
    (monitor) => monitor.config.type !== "heartbeat"
  );
  const step = spreadWindowMs / checked.length;
  let slot = 0;
  return new Map(
    runnable.map((monitor) => {
      if (monitor.config.type === "heartbeat") {
        return [monitor.id, windowEntry(monitor, bootAt, timeZone)];
      }
      const offset = Math.min(slot * step, monitor.intervalMs);
      slot += 1;
      return [
        monitor.id,
        { graceMs: 0, monitor, nextDueAt: bootAt + offset, since: bootAt },
      ];
    })
  );
}

/**
 * The schedule after the operator changed something: a monitor new to the
 * schedule, or edited since (its `updatedAt` moved), is due now, and a
 * heartbeat monitor's window opens now; one gone or no longer schedulable
 * leaves; the rest keep their entry, and a heartbeat window's end is read
 * again in the time zone given.
 */
export function reconcileSchedule(
  schedule: Schedule,
  monitors: readonly Monitor[],
  now: number,
  timeZone: string
): Schedule {
  return new Map(
    monitors.filter(schedulable).map((monitor) => {
      const known = schedule.get(monitor.id);
      if (known && known.monitor.updatedAt === monitor.updatedAt) {
        // A heartbeat window keeps when it opened; its end is read again, since the time zone may have changed.
        return [
          monitor.id,
          monitor.config.type === "heartbeat"
            ? windowEntry(monitor, known.since, timeZone)
            : { ...known, monitor },
        ];
      }
      return [
        monitor.id,
        monitor.config.type === "heartbeat"
          ? windowEntry(monitor, now, timeZone)
          : { graceMs: 0, monitor, nextDueAt: now, since: now },
      ];
    })
  );
}

/** The monitors whose next run is due and that have no check in flight. */
export function dueMonitors(
  schedule: Schedule,
  inFlight: ReadonlySet<string>,
  now: number
): Monitor[] {
  return [...schedule.values()]
    .filter(
      ({ monitor, nextDueAt }) => nextDueAt <= now && !inFlight.has(monitor.id)
    )
    .map(({ monitor }) => monitor);
}

/**
 * The schedule after a check started: the next run is one interval after
 * this one was due, so the tick's lateness never adds up; a check that
 * started more than an interval late anchors on its own start instead, so
 * runs never pile up to catch up. After a heartbeat evaluation the next
 * window opens at the evaluation.
 */
export function afterCheck(
  schedule: Schedule,
  monitorId: string,
  startedAt: number,
  timeZone: string
): Schedule {
  const entry = schedule.get(monitorId);
  if (!entry) {
    return schedule;
  }
  const next = new Map(schedule);
  if (entry.monitor.config.type === "heartbeat") {
    // The next window opens at this evaluation.
    next.set(monitorId, windowEntry(entry.monitor, startedAt, timeZone));
    return next;
  }
  const { intervalMs } = entry.monitor;
  const onCadence = entry.nextDueAt + intervalMs;
  next.set(monitorId, {
    graceMs: 0,
    monitor: entry.monitor,
    nextDueAt: onCadence > startedAt ? onCadence : startedAt + intervalMs,
    since: startedAt,
  });
  return next;
}

/** The schedule with each of these monitors due now, for "check now": its next run comes at this tick and the cadence continues one interval after it. A heartbeat monitor, or one not on the schedule, is left as it is. */
export function bringForward(
  schedule: Schedule,
  monitorIds: ReadonlySet<string>,
  now: number
): Schedule {
  const next = new Map(schedule);
  for (const id of monitorIds) {
    const entry = schedule.get(id);
    if (entry && entry.monitor.config.type !== "heartbeat") {
      next.set(id, { ...entry, nextDueAt: Math.min(entry.nextDueAt, now) });
    }
  }
  return next;
}

/** The heartbeat monitors whose state is down and that heard a heartbeat after their window opened: evaluated at once, not at the window's end. */
export function arrivedWhileDown(
  schedule: Schedule,
  states: ReadonlyMap<string, CheckResult>,
  lastArrivals: ReadonlyMap<string, number>,
  inFlight: ReadonlySet<string>
): Monitor[] {
  return [...schedule.values()]
    .filter(
      ({ monitor, since }) =>
        monitor.config.type === "heartbeat" &&
        states.get(monitor.id) === "down" &&
        !inFlight.has(monitor.id) &&
        (lastArrivals.get(monitor.id) ?? since - 1) >= since
    )
    .map(({ monitor }) => monitor);
}

/** A monitor event (CONTEXT.md "Monitor event"): the four a settled check raises, and certificate expiring, which the certificate pass raises. */
export type MonitorEvent =
  | {
      readonly at: number;
      readonly kind: "down" | "recovered";
      readonly monitorId: string;
      /** The outage this down event opened or this recovered event closed; the notification of each follows it. */
      readonly outage?: Outage;
      readonly reason: ReasonCode;
    }
  | {
      readonly at: number;
      readonly kind: "degraded_started" | "degraded_ended";
      readonly monitorId: string;
      readonly reason: ReasonCode;
    }
  | {
      readonly at: number;
      readonly kind: "certificate_expiring";
      readonly monitorId: string;
      readonly validTo: number;
      readonly warning: CertificateWarning;
    };

/** What a recorded check changed: whether it opened an outage, the outage it closed, and the state before it. */
export interface Settlement {
  readonly check: Check;
  readonly closed: Outage | undefined;
  readonly opened: boolean;
  readonly previous: CheckResult | undefined;
}

/**
 * The events a settlement raises: down when an outage opened or the state
 * left up or degraded for down; recovered when an outage closed or the state
 * left down (a pause may have closed the outage already); the degraded pair
 * on the state before and after, except that down alone speaks for a
 * degraded monitor going down.
 */
export function eventsOf(settlement: Settlement): MonitorEvent[] {
  const { check, closed, opened, previous } = settlement;
  const { result } = check;
  const base = {
    at: check.startedAt,
    monitorId: check.monitorId,
    reason: check.reason,
  };
  const events: MonitorEvent[] = [];
  if (closed || (previous === "down" && result !== "down")) {
    events.push({ ...base, kind: "recovered", outage: closed });
  }
  if (previous === "degraded" && result === "up") {
    events.push({ ...base, kind: "degraded_ended" });
  }
  if (opened || (previous !== "down" && result === "down")) {
    const outage = opened
      ? {
          endedAt: undefined,
          monitorId: check.monitorId,
          reason: check.reason,
          startedAt: check.startedAt,
        }
      : undefined;
    events.push({ ...base, kind: "down", outage });
  }
  if (previous !== "degraded" && result === "degraded") {
    events.push({ ...base, kind: "degraded_started" });
  }
  return events;
}

/** Whether the settlement moves the change counter: a state transition, the first check (the page showed no data), or a failing check while down. */
export function movesCounter(settlement: Settlement): boolean {
  const { check, previous } = settlement;
  return check.result === "down" || previous !== check.result;
}

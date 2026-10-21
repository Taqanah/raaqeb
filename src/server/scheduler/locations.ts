/**
 * The confirmation rules (CONTEXT.md "Location", "Confirmation count";
 * ADR-0012): which of a monitor's locations have a known state, what they
 * agree on, and the check the install writes for them. Nothing here does
 * I/O; `now` is a parameter.
 */

import { longestCheckMs } from "@/shared/domain/checks.ts";
import type {
  CheckOutcome,
  CheckResult,
  FailureDetail,
} from "@/shared/schemas/check.ts";
import {
  locationsOf,
  type Monitor,
  mainLocation,
} from "@/shared/schemas/monitor.ts";
import type { ProbeResult } from "@/shared/schemas/probe.ts";
import { type ReasonCode, reasons } from "@/shared/schemas/reason.ts";

/** One location's latest result for one monitor, as the install holds it (its location state). */
export interface LocationResult {
  readonly attempts: number;
  readonly bytes: number;
  /** A down check's failure detail, without its monitor and time. */
  readonly detail?: Pick<FailureDetail, "assertion" | "error" | "params">;
  readonly reason: ReasonCode;
  readonly responseMs: number | undefined;
  readonly result: CheckResult;
  /** On the install's clock. */
  readonly startedAt: number;
  readonly statusCode: number | undefined;
}

/** What the confirmation rules read of a monitor. */
export type LocatedMonitor = Pick<
  Monitor,
  | "confirmations"
  | "id"
  | "intervalMs"
  | "locations"
  | "retries"
  | "timeoutMs"
  | "updatedAt"
>;

/** What the fresh locations agree on: the result, the location whose figures the check carries, and every location that saw it down. */
export interface Verdict {
  readonly down: readonly string[];
  readonly from: string;
  /** How many of its locations have a known state. */
  readonly known: number;
  readonly result: CheckResult;
}

/** How long a location's result stays its known state: twice the interval plus the longest the check can take. */
export function freshForMs(
  monitor: Pick<Monitor, "intervalMs" | "retries" | "timeoutMs">
): number {
  return 2 * monitor.intervalMs + longestCheckMs(monitor);
}

/** Whether a location's result is its known state: its check started since the monitor last changed (an edit, a pause, a resume), and no longer ago than the bound. */
export function isKnown(
  monitor: Pick<Monitor, "updatedAt">,
  state: Pick<LocationResult, "startedAt">,
  now: number,
  freshFor: number
): boolean {
  return (
    state.startedAt >= monitor.updatedAt && now - state.startedAt <= freshFor
  );
}

/** Whether a monitor checked from probes alone has no recent result at `now`: its latest check, `latestAt`, is past its bound, since a run writes no check while no location has a known state. */
export function noRecentResult(
  monitor: Pick<
    Monitor,
    "intervalMs" | "locations" | "paused" | "retries" | "timeoutMs"
  >,
  latestAt: number | undefined,
  now: number
): boolean {
  return (
    !monitor.paused &&
    monitor.locations !== undefined &&
    !monitor.locations.includes(mainLocation) &&
    latestAt !== undefined &&
    now - latestAt > freshForMs(monitor)
  );
}

/** The verdict of the monitor's locations whose state is known at `now`, or nothing when none is. */
export function verdictOf(
  monitor: LocatedMonitor,
  held: ReadonlyMap<string, LocationResult>,
  now: number
): Verdict | undefined {
  const freshFor = freshForMs(monitor);
  const known = locationsOf(monitor).flatMap((location) => {
    const state = held.get(location);
    return state && isKnown(monitor, state, now, freshFor)
      ? [{ location, result: state.result }]
      : [];
  });
  if (known.length === 0) {
    return;
  }
  // A silent location leaves the count, so the ones still answering decide.
  const needed = Math.min(monitor.confirmations ?? 1, known.length);
  const down = known.filter((each) => each.result === "down");
  const notUp = known.filter((each) => each.result !== "up");
  let result: CheckResult = "up";
  if (down.length >= needed) {
    result = "down";
  } else if (notUp.length >= needed) {
    result = "degraded";
  }
  // The main location comes first in a monitor's order, so it lends its figures whenever it agrees.
  const from = known.find((each) => each.result === result)?.location;
  return {
    down: down.map((each) => each.location),
    from: from ?? mainLocation,
    known: known.length,
    result,
  };
}

/** The check the install writes for a verdict at `startedAt`: the agreeing location's figures, and the install's own failure detail and capture when its own check is that location's. */
export function verdictOutcome(
  monitorId: string,
  verdict: Verdict,
  held: ReadonlyMap<string, LocationResult>,
  startedAt: number,
  own: CheckOutcome | undefined
): CheckOutcome {
  if (verdict.from === mainLocation && own) {
    return own;
  }
  const state = held.get(verdict.from);
  if (!state) {
    throw new Error(`the location ${verdict.from} holds no result`);
  }
  const detail =
    verdict.result === "down" && state.detail
      ? { ...state.detail, monitorId, startedAt }
      : undefined;
  return {
    capture: undefined,
    check: {
      attempts: state.attempts,
      bytes: state.bytes,
      monitorId,
      reason: state.reason,
      responseMs: state.responseMs,
      result: verdict.result,
      startedAt,
      statusCode: state.statusCode,
    },
    detail,
  };
}

/** The main location's result from its own check. */
export function locationResultOf(outcome: CheckOutcome): LocationResult {
  const { check, detail } = outcome;
  return {
    attempts: check.attempts,
    bytes: check.bytes,
    detail: detail && {
      assertion: detail.assertion,
      error: detail.error,
      params: detail.params,
    },
    reason: check.reason,
    responseMs: check.responseMs,
    result: check.result,
    startedAt: check.startedAt,
    statusCode: check.statusCode,
  };
}

/** A probe's result placed on the install's clock: its check started `ageMs` before the push arrived. */
export function locationResultFromProbe(
  result: ProbeResult,
  receivedAt: number
): LocationResult {
  return {
    attempts: result.attempts,
    bytes: result.bytes,
    detail: result.detail && {
      assertion: result.detail.assertion,
      error: result.detail.error,
      params: result.detail.params,
    },
    reason: reasons[result.reason],
    responseMs: result.responseMs,
    result: result.result,
    startedAt: receivedAt - result.ageMs,
    statusCode: result.statusCode,
  };
}

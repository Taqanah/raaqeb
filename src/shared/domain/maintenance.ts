/**
 * A maintenance window's times (CONTEXT.md "Maintenance window"): typed to the minute. A time in the current minute
 * counts as now; anything earlier is past, and a window never starts or
 * ends in the past (a backdated window is a ledger row). A window's end falls in a
 * later minute than its start. Pure: `now` is a parameter; the form and the
 * module judge with the same rules.
 */

export const minuteMs = 60_000;

/** Why a window's times are refused. */
export type TimesRefusal = "end_order" | "end_past" | "start_past";

export type TimesJudgement =
  | { readonly ok: true; readonly endsAt: number; readonly startsAt: number }
  | { readonly ok: false; readonly refusal: TimesRefusal };

/** The time as stored: `now` while it is in the current minute, itself when later; nothing when it is earlier. */
export function notPast(time: number, now: number): number | undefined {
  return time < now - (now % minuteMs) ? undefined : Math.max(time, now);
}

/** A new or scheduled window's times as stored, or why they are refused: a start in the past, or an end not in a later minute than the start. */
export function windowTimes(
  startsAt: number,
  endsAt: number,
  now: number
): TimesJudgement {
  const start = notPast(startsAt, now);
  if (start === undefined) {
    return { ok: false, refusal: "start_past" };
  }
  if (endsAt < start - (start % minuteMs) + minuteMs) {
    return { ok: false, refusal: "end_order" };
  }
  return { endsAt, ok: true, startsAt: start };
}

/** The new end of a window in progress as stored, or its refusal: an end in the past. */
export function runningEnd(
  endsAt: number,
  now: number
):
  | { readonly ok: true; readonly endsAt: number }
  | { readonly ok: false; readonly refusal: "end_past" } {
  const end = notPast(endsAt, now);
  return end === undefined
    ? { ok: false, refusal: "end_past" }
    : { endsAt: end, ok: true };
}

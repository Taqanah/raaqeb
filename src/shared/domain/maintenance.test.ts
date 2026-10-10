import { describe, expect, test } from "bun:test";
import { notPast, runningEnd, windowTimes } from "./maintenance.ts";

/** 10:00:30 UTC, half a minute into its minute. */
const now = Date.UTC(2026, 8, 26, 10, 0, 30);
const at = (hours: number, minutes: number) =>
  Date.UTC(2026, 8, 26, hours, minutes);

describe("a maintenance window's typed time against now", () => {
  test("a time before the current minute is past, the minute before too", () => {
    expect(notPast(at(9, 59), now)).toBeUndefined();
    expect(notPast(at(10, 0) - 1, now)).toBeUndefined();
    expect(notPast(at(9, 58), now)).toBeUndefined();
  });
});

describe("a new or scheduled window's times", () => {
  test("a later start and end are kept as typed", () => {
    expect(windowTimes(at(12, 0), at(14, 30), now)).toEqual({
      endsAt: at(14, 30),
      ok: true,
      startsAt: at(12, 0),
    });
  });

  test("a start in the past is refused", () => {
    expect(windowTimes(at(9, 0), at(11, 0), now)).toEqual({
      ok: false,
      refusal: "start_past",
    });
  });

  test("an end in the start's minute or before it is refused", () => {
    expect(windowTimes(at(12, 0), at(12, 0), now)).toEqual({
      ok: false,
      refusal: "end_order",
    });
    expect(windowTimes(at(12, 0), at(11, 0), now)).toEqual({
      ok: false,
      refusal: "end_order",
    });
  });

  test("a start in the current minute starts the window now, and an end the minute after it is kept", () => {
    expect(windowTimes(at(10, 0), at(10, 1), now)).toEqual({
      endsAt: at(10, 1),
      ok: true,
      startsAt: now,
    });
  });
});

describe("the end of a window in progress", () => {
  test("an end in the current minute ends it now", () => {
    expect(runningEnd(at(10, 0), now)).toEqual({ endsAt: now, ok: true });
  });

  test("a later end is kept, so the window may run longer", () => {
    expect(runningEnd(at(18, 0), now)).toEqual({ endsAt: at(18, 0), ok: true });
  });

  test("an end in the past is refused", () => {
    expect(runningEnd(at(9, 0), now)).toEqual({
      ok: false,
      refusal: "end_past",
    });
  });
});

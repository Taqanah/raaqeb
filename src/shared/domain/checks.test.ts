import { describe, expect, test } from "bun:test";
import type { Check } from "@/shared/schemas/check.ts";
import { retriesMax, timeoutMaxMs } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  askedCheckLanded,
  longestCheckMs,
  retryDelayMs,
  spanChecksShown,
} from "./checks.ts";

describe("the longest a check can take", () => {
  test("a monitor without retries takes at most its timeout", () => {
    expect(longestCheckMs({ retries: 0, timeoutMs: 10_000 })).toBe(10_000);
  });

  test("every retry adds one attempt at the timeout and one pause", () => {
    expect(longestCheckMs({ retries: 2, timeoutMs: 10_000 })).toBe(
      3 * 10_000 + 2 * retryDelayMs
    );
  });

  test("at the form's limits a check takes 11 attempts at 60 s with 10 one-second pauses", () => {
    expect(retryDelayMs).toBe(1000);
    expect(
      longestCheckMs({ retries: retriesMax, timeoutMs: timeoutMaxMs })
    ).toBe(11 * 60_000 + 10 * 1000);
  });
});

describe("the check that check now asked for", () => {
  const from = 1_700_000_000_000;

  test("a newest check that started at the answer's time or after is the asked one", () => {
    expect(askedCheckLanded(from, from)).toBe(true);
    expect(askedCheckLanded(from + 1, from)).toBe(true);
  });

  test("a newest check that started before it is not, nor is no check at all", () => {
    expect(askedCheckLanded(from - 1, from)).toBe(false);
    expect(askedCheckLanded(undefined, from)).toBe(false);
  });
});

describe("the checks a zoomed span's list shows", () => {
  const at = (startedAt: number): Check => ({
    attempts: 1,
    bytes: 0,
    monitorId: "m",
    reason: reasons.ok,
    responseMs: 100,
    result: "up",
    startedAt,
    statusCode: undefined,
  });
  const times = (checks: readonly Check[]) =>
    checks.map((check) => check.startedAt);

  test("before show more the list is the first page", () => {
    expect(times(spanChecksShown([at(5), at(4)], []))).toEqual([5, 4]);
  });

  test("after show more the loaded checks follow the first page, newest first", () => {
    const loaded = [at(5), at(4), at(3), at(2)];
    expect(times(spanChecksShown([at(5), at(4)], loaded))).toEqual([
      5, 4, 3, 2,
    ]);
  });

  test("a check that landed in the span since pushes the first page older, and every check still shows once with none skipped", () => {
    const loaded = [at(5), at(4), at(3), at(2)];
    expect(times(spanChecksShown([at(6), at(5)], loaded))).toEqual([
      6, 5, 4, 3, 2,
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { retriesMax, timeoutMaxMs } from "@/shared/schemas/monitor.ts";
import { askedCheckLanded, longestCheckMs, retryDelayMs } from "./checks.ts";

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

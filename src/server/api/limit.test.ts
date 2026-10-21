import { describe, expect, test } from "bun:test";
import { createRateLimit } from "./limit.ts";

describe("the API's rate limit", () => {
  test("lets a key make its burst at once, then refuses with the seconds until its next call", () => {
    const limit = createRateLimit({ burst: 3, perSecond: 1 });
    expect(limit.take("k", 0)).toBeUndefined();
    expect(limit.take("k", 0)).toBeUndefined();
    expect(limit.take("k", 0)).toBeUndefined();
    expect(limit.take("k", 0)).toBe(1);
    expect(limit.take("k", 400)).toBe(1);
  });

  test("gives a call back each second, never more than the burst", () => {
    const limit = createRateLimit({ burst: 2, perSecond: 1 });
    limit.take("k", 0);
    limit.take("k", 0);
    expect(limit.take("k", 1000)).toBeUndefined();
    expect(limit.take("k", 1000)).toBe(1);
    // A long quiet spell saves up the burst and no more.
    expect(limit.take("k", 60_000)).toBeUndefined();
    expect(limit.take("k", 60_000)).toBeUndefined();
    expect(limit.take("k", 60_000)).toBe(1);
  });

  test("names the whole seconds to wait at a slower pace", () => {
    const limit = createRateLimit({ burst: 1, perSecond: 0.25 });
    limit.take("k", 0);
    expect(limit.take("k", 0)).toBe(4);
    expect(limit.take("k", 1500)).toBe(3);
  });

  test("holds each key to its own bucket", () => {
    const limit = createRateLimit({ burst: 1, perSecond: 1 });
    expect(limit.take("a", 0)).toBeUndefined();
    expect(limit.take("a", 0)).toBe(1);
    expect(limit.take("b", 0)).toBeUndefined();
  });
});

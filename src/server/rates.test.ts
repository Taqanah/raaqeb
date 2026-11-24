import { describe, expect, test } from "bun:test";
import { createRates } from "./rates.ts";

const signIn = { capacity: 3, everyMs: 10_000 };

describe("the rate rules' buckets", () => {
  test("a client spends its capacity, then waits for each token, told how many seconds; another client and another rule have their own", () => {
    let now = 0;
    const { take, waits } = createRates(10, () => now);
    expect([1, 2, 3].map(() => take("sign-in", signIn, "a"))).toEqual([
      0, 0, 0,
    ]);
    expect(take("sign-in", signIn, "a")).toBe(10);
    // Looking spends nothing.
    expect(waits("sign-in", signIn, "a")).toBe(10);
    expect(waits("sign-in", signIn, "c")).toBe(0);
    expect(take("sign-in", signIn, "b")).toBe(0);
    expect(take("subscribe", signIn, "a")).toBe(0);
    now = 4000;
    expect(take("sign-in", signIn, "a")).toBe(6);
    now = 10_000;
    expect(take("sign-in", signIn, "a")).toBe(0);
    expect(take("sign-in", signIn, "a")).toBe(10);
    // A refusal spends nothing: the token is due when it was.
    now = 20_000;
    expect(take("sign-in", signIn, "a")).toBe(0);
  });

  test("a full table sends newcomers to one shared bucket per rule while the clients it holds keep theirs, and a client whose bucket filled again leaves room at the next sweep", () => {
    let now = 0;
    const { take } = createRates(2, () => now);
    take("sign-in", signIn, "a");
    take("sign-in", signIn, "b");
    // Past the cap, every newcomer counts in the one shared bucket.
    expect(["c", "d", "e"].map((c) => take("sign-in", signIn, c))).toEqual([
      0, 0, 0,
    ]);
    expect(take("sign-in", signIn, "f")).toBe(10);
    expect(take("sign-in", signIn, "a")).toBe(0);
    // Once a bucket fills again it is the same as none, so a sweep frees its place.
    now = 30_000;
    expect(take("sign-in", signIn, "g")).toBe(0);
    expect(take("sign-in", signIn, "g")).toBe(0);
    expect(take("sign-in", signIn, "g")).toBe(0);
    expect(take("sign-in", signIn, "g")).toBe(10);
    // Its own bucket, not the shared one: the next newcomer still has a whole one.
    expect(take("sign-in", signIn, "h")).toBe(0);
  });

  test("a million new clients past the cap cost no sweep each and hold no more than the cap: the table is swept at most once a second", () => {
    let now = 0;
    const { size, take } = createRates(10_000, () => now);
    for (let each = 0; each < 10_000; each += 1) {
      take("sign-in", signIn, `held ${each}`);
    }
    const started = performance.now();
    for (let each = 0; each < 1_000_000; each += 1) {
      now += 0.0005;
      take("sign-in", signIn, `new ${each}`);
    }
    expect(performance.now() - started).toBeLessThan(2000);
    expect(size()).toBe(10_000);
  });

  test("the table gives room back before it is full: buckets that filled again are gone a minute later, however few", () => {
    let now = 0;
    const { size, take } = createRates(10_000, () => now);
    for (const client of ["a", "b", "c"]) {
      take("sign-in", signIn, client);
    }
    expect(size()).toBe(3);
    now = 30_000;
    take("sign-in", signIn, "d");
    // A newcomer sweeps out refilled buckets, at most once a second, full or not.
    now = 61_000;
    take("sign-in", signIn, "d");
    expect(size()).toBe(1);
  });

  test("past the cap, looking answers for the shared bucket a newcomer would take from, so looking first and taking after agree", () => {
    const now = 0;
    const { take, waits } = createRates(2, () => now);
    take("sign-in", signIn, "a");
    take("sign-in", signIn, "b");
    for (const client of ["c", "d", "e", "f", "g", "h"]) {
      take("sign-in", signIn, client);
    }
    expect(waits("sign-in", signIn, "i")).toBe(take("sign-in", signIn, "i"));
    expect(waits("sign-in", signIn, "j")).toBeGreaterThan(0);
  });
});

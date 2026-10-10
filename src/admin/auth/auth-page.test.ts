import { describe, expect, test } from "bun:test";
import { stateOf } from "./auth-page.tsx";

describe("onboarding's step lines", () => {
  test("a step before the current one is done, the current one current, one after ahead", () => {
    expect([1, 2, 3].map((step) => stateOf(step, 2))).toEqual([
      "done",
      "current",
      "ahead",
    ]);
  });

  test("on the last step every earlier line is done", () => {
    expect([1, 2, 3].map((step) => stateOf(step, 3))).toEqual([
      "done",
      "done",
      "current",
    ]);
  });
});

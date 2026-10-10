import { describe, expect, test } from "bun:test";
import { checkResults, resultCode, resultOf } from "./check.ts";

describe("a check's result in the head table", () => {
  test("up, degraded and down are 0, 1 and 2 and read back", () => {
    expect(checkResults.map(resultCode)).toEqual([0, 1, 2]);
    expect(resultOf(0)).toBe("up");
    expect(resultOf(1)).toBe("degraded");
    expect(resultOf(2)).toBe("down");
  });

  test("a code this version does not know reads as nothing", () => {
    expect(resultOf(3)).toBeUndefined();
  });
});

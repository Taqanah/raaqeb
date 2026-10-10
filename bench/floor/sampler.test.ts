import { describe, expect, test } from "bun:test";
import { insideSamples } from "./results.ts";
import { sampleEvery, sampleLine } from "./sampler.ts";

describe("the preload sampler", () => {
  test("samples at the interval the variable names, in milliseconds", () => {
    expect(sampleEvery("2000")).toBe(2000);
  });

  test.each(["", "0", "-5", "abc", "1.5", "2e3", " 2000"])(
    "does nothing when the variable reads %p",
    (value) => {
      expect(sampleEvery(value)).toBeUndefined();
    }
  );

  test("a sample line reads back through the harness's reader as the same sample", () => {
    expect(
      insideSamples(`${sampleLine(1_790_158_747_634, 84_488_192, 9_624_125)}\n`)
    ).toEqual([
      { at: 1_790_158_747_634, heapSize: 9_624_125, rss: 84_488_192 },
    ]);
  });
});

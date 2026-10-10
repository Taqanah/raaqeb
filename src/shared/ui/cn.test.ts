import { describe, expect, test } from "bun:test";
import { cn } from "./cn.ts";

describe("the class helper", () => {
  test("joins classes and drops falsy entries", () => {
    expect(cn("h-10", undefined, false, "px-3", null)).toBe("h-10 px-3");
  });

  test("a caller's class wins over the copy's own when both set the same property", () => {
    expect(cn("h-10 px-3", "h-8")).toBe("px-3 h-8");
    expect(cn("rounded-lg", "rounded-none")).toBe("rounded-none");
  });
});

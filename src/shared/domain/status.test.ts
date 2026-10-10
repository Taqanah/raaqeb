import { describe, expect, test } from "bun:test";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { statusNamesIn, worstStatus } from "./status.ts";

describe("worst wins", () => {
  test("a page with no component, or a group with none, is operational", () => {
    expect(worstStatus([])).toBe("operational");
  });

  test("the order is operational, under maintenance, degraded performance, partial outage, major outage", () => {
    // Written out, not read from the schema, so a reordered schema fails here.
    const order: readonly StatusLevel[] = [
      "operational",
      "under_maintenance",
      "degraded_performance",
      "partial_outage",
      "major_outage",
    ];
    for (const [index, level] of order.entries()) {
      const better = order.slice(0, index + 1);
      expect(worstStatus(better)).toBe(level);
      expect(worstStatus(better.toReversed())).toBe(level);
    }
  });

  test("one major outage among many operational components is the page's level", () => {
    expect(
      worstStatus([
        "operational",
        "operational",
        "major_outage",
        "partial_outage",
      ])
    ).toBe("major_outage");
  });

  test("any iterable of levels is read, a set included", () => {
    expect(
      worstStatus(new Set(["partial_outage", "operational"] as const))
    ).toBe("partial_outage");
  });
});

describe("a page's status names", () => {
  const labels = {
    major_outage: { en: "Down for now" },
    operational: { ar: "كل شيء بخير", en: "All good" },
  };

  test("each locale's views show the names written in it", () => {
    expect(statusNamesIn(labels, "ar")).toEqual({ operational: "كل شيء بخير" });
    expect(statusNamesIn(labels, "en")).toEqual({
      major_outage: "Down for now",
      operational: "All good",
    });
  });

  test("a level with no name in the view's locale keeps the catalog's, not the page language's", () => {
    expect(statusNamesIn({ operational: { ar: "بخير" } }, "en")).toEqual({});
  });
});

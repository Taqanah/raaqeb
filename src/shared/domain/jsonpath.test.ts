import { describe, expect, test } from "bun:test";
import { parseJsonPath } from "./jsonpath.ts";

describe("the JSON path grammar of a JSON assertion", () => {
  test("dotted keys and bracket indexes are the grammar", () => {
    expect(parseJsonPath("data.items[0].status")).toEqual([
      "data",
      "items",
      0,
      "status",
    ]);
    expect(parseJsonPath("ok")).toEqual(["ok"]);
    expect(parseJsonPath("items[10][2]")).toEqual(["items", 10, 2]);
  });

  test("a wildcard, a filter, an empty step or a leading dot is malformed", () => {
    for (const path of [
      "data.*",
      "items[?(@.a)]",
      "data..items",
      ".data",
      "data.",
      "items[-1]",
      "items[a]",
      "",
    ]) {
      expect(parseJsonPath(path)).toBeUndefined();
    }
  });
});

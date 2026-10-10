import { describe, expect, test } from "bun:test";
import { jsonText, readJsonPath } from "./jsonpath.ts";

const document = {
  data: { items: [{ status: "healthy" }, { status: "degraded" }], total: 2 },
  ok: true,
  "with space": null,
};

describe("the JSON path of a JSON assertion", () => {
  test("a path reads the value it names", () => {
    expect(readJsonPath(document, "data.items[1].status")).toEqual({
      found: true,
      value: "degraded",
    });
    expect(readJsonPath(document, "data.total")).toEqual({
      found: true,
      value: 2,
    });
    expect(readJsonPath(document, "ok")).toEqual({ found: true, value: true });
  });

  test("a missing step, an index into an object or a malformed path is not found", () => {
    expect(readJsonPath(document, "data.missing")).toEqual({ found: false });
    expect(readJsonPath(document, "data.items[5]")).toEqual({ found: false });
    expect(readJsonPath(document, "data.items[2]")).toEqual({ found: false });
    expect(readJsonPath(document, "data[0]")).toEqual({ found: false });
    expect(readJsonPath(document, "ok.deeper")).toEqual({ found: false });
    expect(readJsonPath(document, "data.*")).toEqual({ found: false });
  });

  test("a key that looks like a number is a key, and an index is only ever in brackets", () => {
    expect(readJsonPath({ "0": "zero" }, "0")).toEqual({
      found: true,
      value: "zero",
    });
    expect(readJsonPath(["zero"], "0")).toEqual({ found: false });
    expect(readJsonPath(["zero"], "[0]")).toEqual({ found: false });
  });

  test("a null value is found, as null", () => {
    expect(readJsonPath(document, "with space")).toEqual({
      found: true,
      value: null,
    });
  });

  test("the compared text is the string itself or the JSON of anything else", () => {
    expect(jsonText("healthy")).toBe("healthy");
    expect(jsonText(2)).toBe("2");
    expect(jsonText(true)).toBe("true");
    expect(jsonText(null)).toBe("null");
    expect(jsonText({ a: [1] })).toBe('{"a":[1]}');
  });
});

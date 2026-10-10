import { describe, expect, test } from "bun:test";
import { componentInputSchema } from "./component.ts";

describe("what the component form posts", () => {
  const input = {
    monitorIds: ["m1"],
    name: { ar: "  الموقع  " },
    status: "operational",
  };

  test("the name is trimmed and up to 100 characters", () => {
    expect(componentInputSchema.parse(input).name).toEqual({ ar: "الموقع" });
    expect(
      componentInputSchema.safeParse({ ...input, name: { ar: " " } }).success
    ).toBe(false);
    expect(
      componentInputSchema.safeParse({
        ...input,
        name: { ar: "a".repeat(101) },
      }).success
    ).toBe(false);
  });

  test("a monitor linked twice is linked once", () => {
    expect(
      componentInputSchema.parse({ ...input, monitorIds: ["a", "b", "a"] })
        .monitorIds
    ).toEqual(["a", "b"]);
  });

  test("the description is optional and up to 500 characters", () => {
    expect(componentInputSchema.parse(input).description).toBeUndefined();
    expect(
      componentInputSchema.safeParse({
        ...input,
        description: { ar: "a".repeat(501) },
      }).success
    ).toBe(false);
  });

  test("under maintenance is never set by hand; a maintenance window sets it", () => {
    expect(
      componentInputSchema.safeParse({ ...input, status: "under_maintenance" })
        .success
    ).toBe(false);
    expect(
      componentInputSchema.safeParse({ ...input, status: "major_outage" })
        .success
    ).toBe(true);
  });
});

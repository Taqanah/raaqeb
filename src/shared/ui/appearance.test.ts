import { describe, expect, test } from "bun:test";
import { defaultAppearance } from "@/shared/schemas/appearance.ts";
import { appearanceAttributes } from "./appearance.ts";

describe("the appearance settings on the document", () => {
  test("become one data attribute per setting, carrying the scale word", () => {
    expect(
      appearanceAttributes({
        density: "spacious",
        fontSize: "small",
        radius: "large",
        theme: "dark",
      })
    ).toEqual({
      "data-density": "spacious",
      "data-font-size": "small",
      "data-radius": "large",
      "data-theme": "dark",
    });
  });

  test("the defaults name system, medium, comfortable and medium", () => {
    expect(appearanceAttributes(defaultAppearance)).toEqual({
      "data-density": "comfortable",
      "data-font-size": "medium",
      "data-radius": "medium",
      "data-theme": "system",
    });
  });
});

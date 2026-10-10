import { describe, expect, test } from "bun:test";
import {
  defaultAppearance,
  densitySchema,
  fontSizeSchema,
  radiusSchema,
  themeSchema,
} from "./appearance.ts";

describe("the appearance settings", () => {
  test("a fresh install shows system theme, medium size, comfortable density and medium radius", () => {
    expect(defaultAppearance).toEqual({
      density: "comfortable",
      fontSize: "medium",
      radius: "medium",
      theme: "system",
    });
  });

  test("each setting accepts its three words and nothing else", () => {
    expect(themeSchema.parse("dark")).toBe("dark");
    expect(fontSizeSchema.parse("large")).toBe("large");
    expect(densitySchema.parse("compact")).toBe("compact");
    expect(radiusSchema.parse("none")).toBe("none");
    expect(themeSchema.safeParse("auto").success).toBe(false);
    expect(fontSizeSchema.safeParse("14px").success).toBe(false);
    expect(densitySchema.safeParse("dense").success).toBe(false);
    expect(radiusSchema.safeParse("small").success).toBe(false);
    expect(themeSchema.safeParse("Dark").success).toBe(false);
  });
});

/**
 * The appearance settings as the data attributes the root document carries,
 * which the stylesheet turns into the scale variables. Pure, so
 * the mapping is pinned without a document.
 */
import type { Appearance } from "@/shared/schemas/appearance.ts";

export interface AppearanceAttributes {
  readonly "data-density": Appearance["density"];
  readonly "data-font-size": Appearance["fontSize"];
  readonly "data-radius": Appearance["radius"];
  readonly "data-theme": Appearance["theme"];
}

export function appearanceAttributes(
  appearance: Appearance
): AppearanceAttributes {
  return {
    "data-density": appearance.density,
    "data-font-size": appearance.fontSize,
    "data-radius": appearance.radius,
    "data-theme": appearance.theme,
  };
}

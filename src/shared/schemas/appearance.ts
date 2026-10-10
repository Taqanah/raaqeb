/**
 * The appearance settings (CONTEXT.md "Appearance settings"): the
 * install's theme, font size, density and radius, stored as scale words and
 * applied in the first paint. One set for the whole install, never per
 * operator. Visitors get the theme only, from their own browser.
 */
import { z } from "zod";

export const themes = ["system", "light", "dark"] as const;
export const fontSizes = ["small", "medium", "large"] as const;
export const densities = ["compact", "comfortable", "spacious"] as const;
export const radii = ["none", "medium", "large"] as const;

export const themeSchema = z.enum(themes);
export const fontSizeSchema = z.enum(fontSizes);
export const densitySchema = z.enum(densities);
export const radiusSchema = z.enum(radii);

export type Theme = z.infer<typeof themeSchema>;
export type FontSize = z.infer<typeof fontSizeSchema>;
export type Density = z.infer<typeof densitySchema>;
export type Radius = z.infer<typeof radiusSchema>;

export const appearanceSchema = z.object({
  density: densitySchema,
  fontSize: fontSizeSchema,
  radius: radiusSchema,
  theme: themeSchema,
});

export type Appearance = z.infer<typeof appearanceSchema>;

/** What a fresh install shows. */
export const defaultAppearance: Appearance = {
  density: "comfortable",
  fontSize: "medium",
  radius: "medium",
  theme: "system",
};

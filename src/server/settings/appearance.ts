/**
 * The four appearance settings as stored rows, one per setting, and the
 * reader the root loader uses for the first paint. The
 * appearance page stores them through `saveAppearance`.
 */

import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  type Appearance,
  type Density,
  defaultAppearance,
  densitySchema,
  type FontSize,
  fontSizeSchema,
  type Radius,
  radiusSchema,
  type Theme,
  themeSchema,
} from "@/shared/schemas/appearance.ts";
import type { SaveResult } from "@/shared/schemas/settings.ts";
import { readSetting } from "./clock.ts";

export const appearanceTheme: Setting<Theme> = defineSetting(
  "appearance_theme",
  themeSchema
);
export const appearanceFontSize: Setting<FontSize> = defineSetting(
  "appearance_font_size",
  fontSizeSchema
);
export const appearanceDensity: Setting<Density> = defineSetting(
  "appearance_density",
  densitySchema
);
export const appearanceRadius: Setting<Radius> = defineSetting(
  "appearance_radius",
  radiusSchema
);

/**
 * The install's appearance, with the default for every setting that is not
 * stored or has no database yet. A stored value outside its list is reported
 * by key and answered as the default, so the document still renders and the
 * setting can be repaired (as the install language does).
 */
export async function readAppearance(
  storage: Pick<Storage, "settings"> | undefined
): Promise<Appearance> {
  const [theme, fontSize, density, radius] = await Promise.all([
    readSetting(storage, appearanceTheme, defaultAppearance.theme),
    readSetting(storage, appearanceFontSize, defaultAppearance.fontSize),
    readSetting(storage, appearanceDensity, defaultAppearance.density),
    readSetting(storage, appearanceRadius, defaultAppearance.radius),
  ]);
  return { density, fontSize, radius, theme };
}

/** Stores all four settings; never throws. */
export async function saveAppearance(
  storage: Pick<Storage, "settings">,
  appearance: Appearance
): Promise<SaveResult> {
  try {
    await storage.settings.set(appearanceTheme, appearance.theme);
    await storage.settings.set(appearanceFontSize, appearance.fontSize);
    await storage.settings.set(appearanceDensity, appearance.density);
    await storage.settings.set(appearanceRadius, appearance.radius);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

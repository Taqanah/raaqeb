/**
 * Test fixture: a fresh install key, as a first boot generates one. Imported
 * by tests only.
 */
import {
  generateInstallKey,
  type InstallKey,
  importInstallKey,
} from "./installkey.ts";

export async function scratchInstallKey(): Promise<InstallKey> {
  const key = await importInstallKey(generateInstallKey());
  if (!key) {
    throw new Error("a generated install key must import");
  }
  return key;
}

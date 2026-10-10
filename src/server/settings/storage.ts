/**
 * The storage settings page: the
 * install-wide retention, the size budget, and the sizes behind them, the
 * used size and, on SQLite, the free disk. Saving changes nothing now: the
 * nightly job applies a lowered retention and the size guard reads the
 * budget at its next measurement, and each moves the change counter when
 * it deletes. Every function answers a result and never throws.
 */

import type { Storage } from "@/server/storage/storage.ts";
import type {
  SaveResult,
  StorageSettings,
  StorageSettingsInput,
} from "@/shared/schemas/settings.ts";
import {
  readRetentionDays,
  readSizeBudgetBytes,
  retentionDays,
  sizeBudgetBytes,
} from "./retention.ts";

export async function readStorageSettings(
  storage: Pick<Storage, "backend" | "settings" | "size">
): Promise<StorageSettings> {
  // A size that cannot be read leaves it out; the fields still render.
  const [retention, budget, used, free] = await Promise.all([
    readRetentionDays(storage),
    readSizeBudgetBytes(storage),
    storage.size.used().catch(() => undefined),
    storage.size.free().catch(() => undefined),
  ]);
  return {
    backend: storage.backend,
    freeBytes: free,
    retentionDays: retention,
    sizeBudgetBytes: budget,
    usedBytes: used,
  };
}

/** Stores the retention and the size budget; an absent budget removes the row, so the install is unlimited again. */
export async function saveStorageSettings(
  storage: Pick<Storage, "settings">,
  input: StorageSettingsInput
): Promise<SaveResult> {
  try {
    await storage.settings.set(retentionDays, input.retentionDays);
    if (input.sizeBudgetBytes === undefined) {
      await storage.settings.remove(sizeBudgetBytes);
    } else {
      await storage.settings.set(sizeBudgetBytes, input.sizeBudgetBytes);
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

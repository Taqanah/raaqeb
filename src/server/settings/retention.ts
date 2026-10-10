/**
 * The install-wide retention (CONTEXT.md "Retention"): how many
 * days of check history a monitor without an override keeps; and the size
 * budget. The monitor form shows the retention, the storage page
 * edits both, the nightly job reads the retention and the size guard the
 * budget.
 */
import { z } from "zod";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  retentionDaysMax,
  retentionDaysMin,
} from "@/shared/schemas/monitor.ts";
import {
  sizeBudgetMaxBytes,
  sizeBudgetMinBytes,
} from "@/shared/schemas/settings.ts";
import { readSetting } from "./clock.ts";

export const retentionDefaultDays = 90;

export const retentionDays: Setting<number> = defineSetting(
  "retention_days",
  z.int().min(retentionDaysMin).max(retentionDaysMax)
);

/** The install default, or 90 days when nothing is stored or the row cannot be read. */
export function readRetentionDays(
  storage: Pick<Storage, "settings"> | undefined
): Promise<number> {
  return readSetting(storage, retentionDays, retentionDefaultDays);
}

/** The size budget (CONTEXT.md "Size budget") in bytes; no row means unlimited. */
export const sizeBudgetBytes: Setting<number> = defineSetting(
  "size_budget_bytes",
  z.int().min(sizeBudgetMinBytes).max(sizeBudgetMaxBytes)
);

/** The size budget, or nothing when none is set or the row cannot be read. */
export function readSizeBudgetBytes(
  storage: Pick<Storage, "settings"> | undefined
): Promise<number | undefined> {
  return readSetting<number | undefined>(storage, sizeBudgetBytes, undefined);
}

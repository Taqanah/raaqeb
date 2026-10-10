import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  readRetentionDays,
  readSizeBudgetBytes,
  retentionDays,
  retentionDefaultDays,
  sizeBudgetBytes,
} from "./retention.ts";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** Runs `work` with standard error captured, answering what was written. */
async function capturingStderr(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await work();
  } finally {
    process.stderr.write = write;
  }
  return lines.join("");
}

describe("the install-wide retention", () => {
  test("is one setting, retention_days, a whole number of days from 1 to 3650", () => {
    expect(retentionDays.key).toBe("retention_days");
    expect(retentionDays.schema.safeParse(3650).success).toBe(true);
    for (const value of [0, 3651, 1.5, "90"]) {
      expect(retentionDays.schema.safeParse(value).success).toBe(false);
    }
  });

  test("is 90 days when nothing is stored or no database is open", async () => {
    expect(retentionDefaultDays).toBe(90);
    expect(await readRetentionDays(await storage())).toBe(90);
    expect(await readRetentionDays(undefined)).toBe(90);
  });

  test("is the stored number of days", async () => {
    const store = await storage();
    await store.settings.set(retentionDays, 400);
    expect(await readRetentionDays(store)).toBe(400);
  });

  test("a stored value outside its rule is reported by key and read as 90, so the form still opens", async () => {
    const store = await storage();
    await store.settings.set(defineSetting("retention_days", z.unknown()), 0);
    const logged = await capturingStderr(async () => {
      expect(await readRetentionDays(store)).toBe(90);
    });
    expect(logged).toContain("retention_days");
  });
});

describe("the size budget", () => {
  const mb = 1024 * 1024;

  test("is one setting, size_budget_bytes, whole bytes from 64 MB to 1 TB", () => {
    expect(sizeBudgetBytes.key).toBe("size_budget_bytes");
    for (const value of [64 * mb, 1024 * 1024 * mb]) {
      expect(sizeBudgetBytes.schema.safeParse(value).success).toBe(true);
    }
    for (const value of [64 * mb - 1, 1024 * 1024 * mb + 1, 100.5, "100"]) {
      expect(sizeBudgetBytes.schema.safeParse(value).success).toBe(false);
    }
  });

  test("is unlimited when nothing is stored or no database is open", async () => {
    expect(await readSizeBudgetBytes(await storage())).toBeUndefined();
    expect(await readSizeBudgetBytes(undefined)).toBeUndefined();
  });

  test("is the stored number of bytes", async () => {
    const store = await storage();
    await store.settings.set(sizeBudgetBytes, 500 * mb);
    expect(await readSizeBudgetBytes(store)).toBe(500 * mb);
  });

  test("a stored value outside its rule is reported by key and read as unlimited", async () => {
    const store = await storage();
    await store.settings.set(
      defineSetting("size_budget_bytes", z.unknown()),
      1
    );
    const logged = await capturingStderr(async () => {
      expect(await readSizeBudgetBytes(store)).toBeUndefined();
    });
    expect(logged).toContain("size_budget_bytes");
  });
});

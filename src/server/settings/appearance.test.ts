import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  appearanceDensity,
  appearanceFontSize,
  appearanceRadius,
  appearanceTheme,
  readAppearance,
  saveAppearance,
} from "./appearance.ts";

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

describe("the appearance settings as stored rows", () => {
  test("are four settings, one row each, keyed by appearance_ and holding scale words", () => {
    expect(appearanceTheme.key).toBe("appearance_theme");
    expect(appearanceFontSize.key).toBe("appearance_font_size");
    expect(appearanceDensity.key).toBe("appearance_density");
    expect(appearanceRadius.key).toBe("appearance_radius");
    expect(appearanceTheme.schema.parse("light")).toBe("light");
    expect(appearanceRadius.schema.safeParse("0.5rem").success).toBe(false);
  });

  test("a fresh install shows the defaults before anything is stored, and before the database exists", async () => {
    const defaults = {
      density: "comfortable",
      fontSize: "medium",
      radius: "medium",
      theme: "system",
    } as const;
    expect(await readAppearance(await storage())).toEqual(defaults);
    expect(await readAppearance(undefined)).toEqual(defaults);
  });

  test("what the operator stored is what the document gets, setting by setting", async () => {
    const opened = await storage();
    await opened.settings.set(appearanceTheme, "dark");
    await opened.settings.set(appearanceDensity, "compact");
    expect(await readAppearance(opened)).toEqual({
      density: "compact",
      fontSize: "medium",
      radius: "medium",
      theme: "dark",
    });
    await opened.settings.set(appearanceFontSize, "large");
    await opened.settings.set(appearanceRadius, "none");
    expect(await readAppearance(opened)).toEqual({
      density: "compact",
      fontSize: "large",
      radius: "none",
      theme: "dark",
    });
  });

  test("a stored value outside its list is reported by key and answered as the default, and the other settings keep their values", async () => {
    const opened = await storage();
    await opened.settings.set(appearanceTheme, "light");
    // The same row written through a looser declaration, as an older binary might have.
    await opened.settings.set(
      defineSetting(appearanceRadius.key, z.string()),
      "0.5rem"
    );
    const written = await capturingStderr(async () => {
      expect(await readAppearance(opened)).toEqual({
        density: "comfortable",
        fontSize: "medium",
        radius: "medium",
        theme: "light",
      });
    });
    expect(written).toContain("appearance_radius");
    expect(written).not.toContain("0.5rem");
  });
});

describe("the appearance page's save", () => {
  test("stores all four settings and reads them back", async () => {
    const store = await storage();
    const appearance = {
      density: "compact",
      fontSize: "large",
      radius: "none",
      theme: "dark",
    } as const;
    expect(await saveAppearance(store, appearance)).toEqual({ ok: true });
    expect(await readAppearance(store)).toEqual(appearance);
  });

  test("a database that cannot store a setting refuses the save as unavailable", async () => {
    const store = await storage();
    expect(
      await saveAppearance(
        {
          settings: {
            ...store.settings,
            set: () => Promise.reject(new Error("the disk is busy")),
          },
        },
        {
          density: "compact",
          fontSize: "large",
          radius: "none",
          theme: "dark",
        }
      )
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

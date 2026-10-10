import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { hostTimeZone } from "@/shared/i18n/timezone.ts";
import { readAccountSettings, saveAccountSettings } from "./account.ts";
import { calendar, clock, timeZone } from "./clock.ts";
import { installLanguage } from "./language.ts";
import {
  operatorCalendar,
  operatorClock,
  operatorLanguage,
  operatorTimeZone,
} from "./operator.ts";

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

describe("the account page's overrides", () => {
  test("a fresh install has no overrides and names the install values they would replace", async () => {
    const store = await storage();
    const settings = await readAccountSettings(store);
    expect(settings.timeZones).toContain("Asia/Riyadh");
    const { timeZones: _zones, ...rest } = settings;
    expect(rest).toEqual({
      install: {
        calendar: "gregorian",
        clock: "12h",
        language: "ar",
        timeZone: hostTimeZone(),
      },
      overrides: {},
    });
  });

  test("the install values shown are the current ones, beside the operator's own", async () => {
    const store = await storage();
    await store.settings.set(installLanguage, "en");
    await store.settings.set(timeZone, "Asia/Riyadh");
    await store.settings.set(clock, "24h");
    await store.settings.set(calendar, "hijri");
    await store.settings.set(operatorCalendar, "gregorian");
    const settings = await readAccountSettings(store);
    expect(settings.install).toEqual({
      calendar: "hijri",
      clock: "24h",
      language: "en",
      timeZone: "Asia/Riyadh",
    });
    expect(settings.overrides).toEqual({ calendar: "gregorian" });
  });

  test("every override round-trips through save and read", async () => {
    const store = await storage();
    const overrides = {
      calendar: "hijri_gregorian",
      clock: "24h",
      operatorLanguage: "en",
      timeZone: "Europe/London",
    } as const;
    expect(await saveAccountSettings(store, overrides)).toEqual({ ok: true });
    expect((await readAccountSettings(store)).overrides).toEqual(overrides);
  });

  test("an override left out is removed, so the operator follows the install again", async () => {
    const store = await storage();
    await saveAccountSettings(store, {
      calendar: "hijri",
      clock: "24h",
      operatorLanguage: "en",
      timeZone: "Europe/London",
    });
    expect(await store.settings.get(operatorCalendar)).toBe("hijri");
    expect(await saveAccountSettings(store, { clock: "24h" })).toEqual({
      ok: true,
    });
    expect((await readAccountSettings(store)).overrides).toEqual({
      clock: "24h",
    });
    expect(await store.settings.get(operatorLanguage)).toBeUndefined();
    expect(await store.settings.get(operatorTimeZone)).toBeUndefined();
    expect(await store.settings.get(operatorCalendar)).toBeUndefined();
    expect(await store.settings.get(operatorClock)).toBe("24h");
  });

  test("a database that cannot store an override refuses the save as unavailable", async () => {
    const store = await storage();
    const failing = () => Promise.reject(new Error("the disk is busy"));
    expect(
      await saveAccountSettings(
        { settings: { ...store.settings, remove: failing, set: failing } },
        {}
      )
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

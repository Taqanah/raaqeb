import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { hostTimeZone } from "@/shared/i18n/timezone.ts";
import { calendar, clock, timeZone } from "./clock.ts";
import { installLanguage } from "./language.ts";
import {
  isAdminPath,
  operatorCalendar,
  operatorClock,
  operatorLanguage,
  operatorTimeZone,
  readOperatorClock,
  readOperatorLanguage,
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

describe("the admin area's paths", () => {
  test("are /admin and everything under it, and nothing that merely starts with the letters", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/")).toBe(true);
    expect(isAdminPath("/admin/settings/account")).toBe(true);
    expect(isAdminPath("/administrators")).toBe(false);
    expect(isAdminPath("/sign-in")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
  });
});

describe("the operator language (CONTEXT.md)", () => {
  test("is a setting keyed operator_language holding a locale", () => {
    expect(operatorLanguage.key).toBe("operator_language");
    expect(operatorLanguage.schema.safeParse("fr").success).toBe(false);
  });

  test("defaults to the install language, and is Arabic with no database open", async () => {
    expect(await readOperatorLanguage(undefined)).toBe("ar");
    const store = await storage();
    expect(await readOperatorLanguage(store)).toBe("ar");
    await store.settings.set(installLanguage, "en");
    expect(await readOperatorLanguage(store)).toBe("en");
  });

  test("once stored, wins over the install language", async () => {
    const store = await storage();
    await store.settings.set(installLanguage, "en");
    await store.settings.set(operatorLanguage, "ar");
    expect(await readOperatorLanguage(store)).toBe("ar");
  });

  test("a stored value that is not a locale falls back to the install language", async () => {
    const store = await storage();
    await store.settings.set(installLanguage, "en");
    await store.settings.set(
      defineSetting("operator_language", z.unknown()),
      "fr"
    );
    expect(await readOperatorLanguage(store)).toBe("en");
  });
});

describe("the operator's zone and clock overrides", () => {
  test("are settings keyed operator_time_zone and operator_clock", () => {
    expect(operatorTimeZone.key).toBe("operator_time_zone");
    expect(operatorClock.key).toBe("operator_clock");
  });

  test("each falls back to the install's value on its own", async () => {
    const store = await storage();
    expect(await readOperatorClock(store)).toEqual({
      calendar: "gregorian",
      clock: "12h",
      timeZone: hostTimeZone(),
    });
    await store.settings.set(timeZone, "Asia/Riyadh");
    await store.settings.set(clock, "24h");
    await store.settings.set(operatorClock, "12h");
    expect(await readOperatorClock(store)).toEqual({
      calendar: "gregorian",
      clock: "12h",
      timeZone: "Asia/Riyadh",
    });
    await store.settings.set(operatorTimeZone, "Europe/London");
    expect(await readOperatorClock(store)).toEqual({
      calendar: "gregorian",
      clock: "12h",
      timeZone: "Europe/London",
    });
  });
});

describe("the operator's calendar override", () => {
  test("is a setting keyed operator_calendar", () => {
    expect(operatorCalendar.key).toBe("operator_calendar");
  });

  test("follows the install's calendar until the operator sets their own", async () => {
    const store = await storage();
    await store.settings.set(calendar, "hijri");
    expect((await readOperatorClock(store)).calendar).toBe("hijri");
    await store.settings.set(operatorCalendar, "gregorian");
    expect((await readOperatorClock(store)).calendar).toBe("gregorian");
  });
});

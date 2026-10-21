import { afterEach, describe, expect, test } from "bun:test";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { hostTimeZone } from "@/shared/i18n/timezone.ts";
import { readAccountSettings, saveAccountSettings } from "./account.ts";
import { calendar, clock, timeZone } from "./clock.ts";
import { installLanguage } from "./language.ts";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

/** A fresh database with two accounts, `a` and `b`. */
async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  await runSql(
    scratch.location,
    "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES ('a', '', 'a@example.com', 0, 0, 0), ('b', '', 'b@example.com', 0, 1, 1)"
  );
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

async function preferencesOf(store: Storage, id: string) {
  return (await store.operatorAccounts.find(id))?.preferences;
}

describe("the account page's overrides", () => {
  test("an account with none names the install values they would replace", async () => {
    const store = await storage();
    const settings = await readAccountSettings(store, {});
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
    const settings = await readAccountSettings(store, {
      calendar: "gregorian",
    });
    expect(settings.install).toEqual({
      calendar: "hijri",
      clock: "24h",
      language: "en",
      timeZone: "Asia/Riyadh",
    });
    expect(settings.overrides).toEqual({ calendar: "gregorian" });
  });

  test("every override is kept on the one account that saved it", async () => {
    const store = await storage();
    const overrides = {
      calendar: "hijri_gregorian",
      clock: "24h",
      operatorLanguage: "en",
      timeZone: "Europe/London",
    } as const;
    expect(await saveAccountSettings(store, "a", overrides)).toEqual({
      ok: true,
    });
    expect(await preferencesOf(store, "a")).toEqual(overrides);
    expect(await preferencesOf(store, "b")).toEqual({});
  });

  test("an override left out is removed, so the operator follows the install again", async () => {
    const store = await storage();
    await saveAccountSettings(store, "a", {
      calendar: "hijri",
      clock: "24h",
      operatorLanguage: "en",
      timeZone: "Europe/London",
    });
    expect(await saveAccountSettings(store, "a", { clock: "24h" })).toEqual({
      ok: true,
    });
    expect(await preferencesOf(store, "a")).toEqual({ clock: "24h" });
  });

  test("an account that is gone, or a database that cannot store, refuses the save as unavailable", async () => {
    const store = await storage();
    expect(await saveAccountSettings(store, "nobody", {})).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const failing = () => Promise.reject(new Error("the disk is busy"));
    expect(
      await saveAccountSettings(
        {
          operatorAccounts: {
            ...store.operatorAccounts,
            setPreferences: failing,
          },
        },
        "a",
        {}
      )
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

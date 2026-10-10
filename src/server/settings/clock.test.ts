import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { hostTimeZone } from "@/shared/i18n/timezone.ts";
import { calendar, clock, readClock, timeZone } from "./clock.ts";

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

/** Writes any JSON value under a setting's key, bypassing its schema. */
function raw(key: string) {
  return defineSetting(key, z.unknown());
}

describe("the install time zone and clock format", () => {
  test("are two settings: time_zone holding an IANA name and clock holding 12h or 24h", () => {
    expect(timeZone.key).toBe("time_zone");
    expect(clock.key).toBe("clock");
    expect(timeZone.schema.safeParse("Mars/Olympus").success).toBe(false);
    expect(clock.schema.parse("24h")).toBe("24h");
  });

  test("a fresh install runs in the host's zone with a 12-hour clock, and so does one with no database open", async () => {
    const defaults = {
      calendar: "gregorian",
      clock: "12h",
      timeZone: hostTimeZone(),
    } as const;
    expect(await readClock(await storage())).toEqual(defaults);
    expect(await readClock(undefined)).toEqual(defaults);
  });

  test("a stored zone and clock are read back", async () => {
    const store = await storage();
    await store.settings.set(timeZone, "Asia/Riyadh");
    await store.settings.set(clock, "24h");
    expect(await readClock(store)).toEqual({
      calendar: "gregorian",
      clock: "24h",
      timeZone: "Asia/Riyadh",
    });
  });

  test("a database that cannot answer is reported as unreadable, never as a bad row", async () => {
    const store = await storage();
    await store.close();
    const written = await capturingStderr(async () => {
      expect(await readClock(store)).toEqual({
        calendar: "gregorian",
        clock: "12h",
        timeZone: hostTimeZone(),
      });
    });
    expect(written).toContain("could not be read");
    expect(written).not.toContain("not one of its values");
  });

  test("a stored value outside its rule is answered as the default so the page can repair it", async () => {
    const store = await storage();
    await store.settings.set(raw("time_zone"), "Mars/Olympus");
    await store.settings.set(raw("clock"), 24);
    expect(await readClock(store)).toEqual({
      calendar: "gregorian",
      clock: "12h",
      timeZone: hostTimeZone(),
    });
  });
});

describe("the install calendar", () => {
  test("is a setting keyed calendar holding gregorian, hijri or hijri_gregorian", () => {
    expect(calendar.key).toBe("calendar");
    expect(calendar.schema.parse("hijri_gregorian")).toBe("hijri_gregorian");
    expect(calendar.schema.safeParse("islamic").success).toBe(false);
  });

  test("a stored calendar is read back beside the zone and the clock", async () => {
    const store = await storage();
    await store.settings.set(calendar, "hijri");
    expect((await readClock(store)).calendar).toBe("hijri");
  });

  test("a stored calendar outside its values is answered as Gregorian", async () => {
    const store = await storage();
    await store.settings.set(raw("calendar"), "islamic");
    await capturingStderr(async () => {
      expect((await readClock(store)).calendar).toBe("gregorian");
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  fromWallTime,
  hostTimeZone,
  isTimeZone,
  timeZones,
  wallTime,
  zoneOffsetMs,
} from "./timezone.ts";

describe("time zones for the install and operator settings", () => {
  test("the list holds the IANA names the runtime knows, Riyadh and UTC among them", () => {
    const zones = timeZones();
    expect(zones).toContain("Asia/Riyadh");
    expect(zones).toContain("UTC");
    expect(zones.length).toBeGreaterThan(300);
  });

  test("a name the runtime knows is a zone; anything else is not", () => {
    expect(isTimeZone("Asia/Riyadh")).toBe(true);
    expect(isTimeZone("Europe/London")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(5)).toBe(false);
    expect(isTimeZone(undefined)).toBe(false);
  });

  test("the host zone is one the list accepts", () => {
    expect(isTimeZone(hostTimeZone())).toBe(true);
  });
});

describe("a datetime-local field's minute in the operator's zone", () => {
  test("a time reads as the minute its zone's clock shows", () => {
    const at = Date.UTC(2026, 8, 26, 7, 30, 45);
    expect(wallTime(at, "Asia/Riyadh")).toBe("2026-09-26T10:30");
    expect(wallTime(at, "UTC")).toBe("2026-09-26T07:30");
    expect(wallTime(at, "America/New_York")).toBe("2026-09-26T03:30");
  });

  test("a minute on the zone's clock names the time it reads there", () => {
    expect(fromWallTime("2026-09-26T10:30", "Asia/Riyadh")).toBe(
      Date.UTC(2026, 8, 26, 7, 30)
    );
    expect(fromWallTime("2026-01-15T09:00", "Europe/Berlin")).toBe(
      Date.UTC(2026, 0, 15, 8, 0)
    );
    expect(fromWallTime("2026-07-15T09:00", "Europe/Berlin")).toBe(
      Date.UTC(2026, 6, 15, 7, 0)
    );
  });

  test("a minute and the time it names read back as each other", () => {
    for (const zone of ["Asia/Riyadh", "Europe/Berlin", "Asia/Kolkata"]) {
      const at = Date.UTC(2026, 10, 3, 18, 45);
      expect(fromWallTime(wallTime(at, zone), zone)).toBe(at);
    }
  });

  test("a minute a clock change skips reads at the offset before the change", () => {
    // Berlin skips 02:00 to 03:00 on 29 March 2026; 02:30 read at +01:00 is 01:30 UTC.
    expect(fromWallTime("2026-03-29T02:30", "Europe/Berlin")).toBe(
      Date.UTC(2026, 2, 29, 1, 30)
    );
  });

  test("a minute a clock change repeats reads as the earlier of the two", () => {
    // Berlin repeats 02:00 to 03:00 on 25 October 2026; the first 02:30 is at +02:00, 00:30 UTC.
    expect(fromWallTime("2026-10-25T02:30", "Europe/Berlin")).toBe(
      Date.UTC(2026, 9, 25, 0, 30)
    );
  });

  test("text that is not a datetime-local minute names no time", () => {
    for (const text of [
      "",
      "2026-09-26",
      "2026-09-26 10:30",
      "2026-09-26T10:30:15",
      "2026-13-01T10:30",
      "2026-02-30T10:30",
      "2026-09-26T24:00",
      "2026-09-26T10:60",
      "٢٠٢٦-٠٩-٢٦T10:30",
    ]) {
      expect(fromWallTime(text, "Asia/Riyadh")).toBeUndefined();
    }
  });
});

describe("a zone's offset from UTC", () => {
  test("is how far its clock is ahead, half hours and clock changes included", () => {
    const summer = Date.parse("2026-07-01T12:00:00Z");
    const winter = Date.parse("2026-12-01T12:00:00Z");
    expect(zoneOffsetMs(summer, "Asia/Riyadh")).toBe(3 * 3_600_000);
    expect(zoneOffsetMs(summer, "Asia/Kolkata")).toBe(5.5 * 3_600_000);
    expect(zoneOffsetMs(summer, "Europe/Berlin")).toBe(2 * 3_600_000);
    expect(zoneOffsetMs(winter, "Europe/Berlin")).toBe(3_600_000);
    expect(zoneOffsetMs(winter, "America/New_York")).toBe(-5 * 3_600_000);
  });
});

import { describe, expect, test } from "bun:test";
import { matchesZone, zoneOption, zoneOptions } from "./zones.ts";

// Mid-January, so the zones with summer time are on their winter offset.
const winter = Date.UTC(2026, 0, 15);

describe("a time zone as the operator reads it", () => {
  test("is its city in the operator language, its region and its offset; the IANA name is what is stored", () => {
    expect(zoneOption("Asia/Riyadh", "ar", winter)).toEqual({
      city: "الرياض",
      label: "الرياض (غرينتش+3)",
      offset: "غرينتش+3",
      offsetMinutes: 180,
      region: "التوقيت العربي الرسمي",
      value: "Asia/Riyadh",
    });
    const english = zoneOption("Asia/Riyadh", "en", winter);
    expect(english.city).toBe("Riyadh");
    expect(english.label).toBe("Riyadh (GMT+3)");
  });

  test("a zone known by an older name in CLDR still has its city", () => {
    expect(zoneOption("Asia/Kolkata", "en", winter).city).toBe("Kolkata");
    expect(zoneOption("Asia/Kolkata", "ar", winter).offsetMinutes).toBe(330);
  });

  test("a zone with no city reads as its name, or as its offset alone", () => {
    const utc = zoneOption("UTC", "ar", winter);
    expect(utc.city).toBeUndefined();
    expect(utc.label).toBe("التوقيت العالمي المنسق (غرينتش+0)");
    const plain = zoneOption("Etc/GMT-3", "ar", winter);
    expect(plain.region).toBe("");
    expect(plain.label).toBe("غرينتش+3");
  });

  test("the list runs from west to east, and by city within one offset", () => {
    expect(
      zoneOptions(
        [
          "Asia/Dubai",
          "Asia/Riyadh",
          "America/New_York",
          "Asia/Baghdad",
          "Africa/Cairo",
        ],
        "ar",
        winter
      ).map((option) => option.value)
    ).toEqual([
      "America/New_York",
      "Africa/Cairo",
      "Asia/Riyadh",
      "Asia/Baghdad",
      "Asia/Dubai",
    ]);
  });
});

describe("a search for a time zone", () => {
  const riyadh = () => zoneOption("Asia/Riyadh", "ar", winter);

  test("finds a city in Arabic or English, its IANA name, its region or its offset", () => {
    for (const query of [
      "رياض",
      "Riyadh",
      "riy",
      "Asia/Riy",
      "العربي",
      "+3",
      "غرينتش+3",
    ]) {
      expect(matchesZone(riyadh(), query)).toBe(true);
    }
  });

  test("reads Arabic spelled either way: a taa marbuta as haa, a hamza on the alef or none", () => {
    expect(
      matchesZone(zoneOption("Africa/Cairo", "ar", winter), "القاهره")
    ).toBe(true);
    expect(
      matchesZone(zoneOption("Europe/Istanbul", "ar", winter), "اسطنبول")
    ).toBe(true);
  });

  test("an empty search finds every zone, and a search for something else finds none", () => {
    expect(matchesZone(riyadh(), "  ")).toBe(true);
    expect(matchesZone(riyadh(), "Tokyo")).toBe(false);
  });
});

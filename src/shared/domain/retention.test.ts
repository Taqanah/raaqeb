import { describe, expect, test } from "bun:test";
import { retentionBounds, retentionWindows, utcDayStart } from "./retention.ts";

const day = 86_400_000;
/** A UTC day's start. */
const d = 1_700_006_400_000;

describe("the three windows of a retention", () => {
  test("at the default of 90 days: raw checks for 30, hourly and daily rollups for 90", () => {
    expect(retentionWindows(90)).toEqual({ daily: 90, hourly: 90, raw: 30 });
  });

  test("a retention under 30 days bounds all three tiers", () => {
    expect(retentionWindows(7)).toEqual({ daily: 7, hourly: 7, raw: 7 });
    expect(retentionWindows(1)).toEqual({ daily: 1, hourly: 1, raw: 1 });
  });

  test("between 30 and 90 days the raw tier stops at 30 and the rollups follow the retention", () => {
    expect(retentionWindows(45)).toEqual({ daily: 45, hourly: 45, raw: 30 });
    expect(retentionWindows(30)).toEqual({ daily: 30, hourly: 30, raw: 30 });
  });

  test("set to years, the extra time is kept as daily rollups only", () => {
    expect(retentionWindows(3650)).toEqual({
      daily: 3650,
      hourly: 90,
      raw: 30,
    });
  });
});

describe("the bounds of a retention", () => {
  test("each tier keeps today and its window's whole UTC days before it", () => {
    expect(retentionBounds(90, d + 5 * 3_600_000)).toEqual({
      daily: d - 90 * day,
      hourly: d - 90 * day,
      raw: d - 30 * day,
    });
  });

  test("the bounds move only when the UTC day does", () => {
    expect(retentionBounds(7, d)).toEqual(retentionBounds(7, d + day - 1));
    expect(retentionBounds(7, d + day).raw).toBe(d - 6 * day);
  });

  test("a retention of years bounds the daily rollups alone", () => {
    expect(retentionBounds(365, d)).toEqual({
      daily: d - 365 * day,
      hourly: d - 90 * day,
      raw: d - 30 * day,
    });
  });
});

describe("the UTC day", () => {
  test("starts at midnight UTC, whatever the moment inside it", () => {
    expect(utcDayStart(d)).toBe(d);
    expect(utcDayStart(d + day - 1)).toBe(d);
    expect(utcDayStart(d + day)).toBe(d + day);
  });
});

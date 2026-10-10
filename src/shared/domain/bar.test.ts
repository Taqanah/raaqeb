import { describe, expect, test } from "bun:test";
import { barSpans, cellLevel, lastDaysUptime } from "./bar.ts";

const at = (percent: number, decimals = 2) => ({ decimals, percent });

describe("a day bar cell's colour, in steps by the day's uptime", () => {
  test("a day with nothing observed has no data", () => {
    expect(cellLevel(null)).toBeUndefined();
  });

  test("100 and down to 99.9 is operational", () => {
    expect(cellLevel(at(100, 0))).toBe("operational");
    expect(cellLevel(at(99.9))).toBe("operational");
  });

  test("under 99.9 and down to 99 is degraded performance", () => {
    expect(cellLevel(at(99.89))).toBe("degraded_performance");
    expect(cellLevel(at(99))).toBe("degraded_performance");
  });

  test("under 99 and down to 95 is partial outage", () => {
    expect(cellLevel(at(98.99))).toBe("partial_outage");
    expect(cellLevel(at(95))).toBe("partial_outage");
  });

  test("under 95 is major outage, zero included", () => {
    expect(cellLevel(at(94.99))).toBe("major_outage");
    expect(cellLevel(at(0))).toBe("major_outage");
  });
});

describe("the days of a bar each screen shows", () => {
  test("a 90-day bar shows 30 days on a phone, 60 on a tablet and 90 wider", () => {
    expect(barSpans(90)).toEqual([30, 60, 90]);
  });

  test("a 60-day bar shows 30 on a phone and the whole bar wider", () => {
    expect(barSpans(60)).toEqual([30, 60]);
  });

  test("a 30-day bar shows the whole bar on every screen", () => {
    expect(barSpans(30)).toEqual([30]);
  });
});

describe("the uptime over the days a screen shows", () => {
  const hour = 3_600_000;
  const days = [
    { downtimeMs: 6 * hour, observedMs: 24 * hour },
    { downtimeMs: 0, observedMs: 24 * hour },
    { downtimeMs: 0, observedMs: 0 },
  ];

  test("only the last days count", () => {
    expect(lastDaysUptime(days, 2)).toEqual({ decimals: 0, percent: 100 });
  });

  test("every day counts when the screen shows them all", () => {
    expect(lastDaysUptime(days, 3)).toEqual({ decimals: 2, percent: 87.5 });
  });

  test("days with nothing observed have no uptime", () => {
    expect(lastDaysUptime(days, 1)).toBeUndefined();
  });
});

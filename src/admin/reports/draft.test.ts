import { describe, expect, test } from "bun:test";
import {
  datesOf,
  draftOf,
  monthChoices,
  quarterChoices,
  type ReportDraft,
  searchOf,
} from "./draft.ts";

const now = Date.UTC(2026, 9, 19, 12);

describe("the months and quarters the form lists", () => {
  test("two years of months, the current one first", () => {
    const months = monthChoices(now);
    expect(months).toHaveLength(24);
    expect(months[0]).toBe("2026-10");
    expect(months[1]).toBe("2026-09");
    expect(months.at(-1)).toBe("2024-11");
  });

  test("a month asked for beyond them is listed too, so the form shows what the address asked", () => {
    expect(monthChoices(now, "2023-02")).toContain("2023-02");
    expect(monthChoices(now, "2026-05")).toHaveLength(24);
  });

  test("eight quarters, the current one first, across the year's edge", () => {
    const quarters = quarterChoices(now);
    expect(quarters).toHaveLength(8);
    expect(quarters.slice(0, 3)).toEqual(["2026-4", "2026-3", "2026-2"]);
    expect(quarters.at(-1)).toBe("2025-1");
    expect(quarterChoices(Date.UTC(2026, 1, 3))[1]).toBe("2025-4");
    expect(quarterChoices(now, "2020-2")).toContain("2020-2");
  });
});

describe("the form as the address asks for it", () => {
  test("with nothing asked it is the last whole month, the default target and no subject chosen", () => {
    expect(draftOf({}, now)).toMatchObject({
      from: "2026-09-01",
      id: "",
      kind: "monitor",
      month: "2026-09",
      period: "month",
      quarter: "2026-3",
      target: "99.9",
      to: "2026-09-30",
    });
  });

  test("a range that is exactly a month or a quarter is picked as one, and any other is a custom range", () => {
    const base = { id: "m1", subject: "group" } as const;
    expect(
      draftOf({ ...base, from: "2026-08-01", to: "2026-08-31" }, now)
    ).toMatchObject({
      kind: "group",
      id: "m1",
      month: "2026-08",
      period: "month",
    });
    expect(
      draftOf({ ...base, from: "2026-04-01", to: "2026-06-30" }, now)
    ).toMatchObject({ period: "quarter", quarter: "2026-2" });
    expect(
      draftOf({ ...base, from: "2026-08-10", to: "2026-09-02" }, now)
    ).toMatchObject({
      from: "2026-08-10",
      period: "custom",
      to: "2026-09-02",
    });
  });

  test("a range with only one end asked is no range", () => {
    expect(draftOf({ from: "2026-08-10" }, now)).toMatchObject({
      from: "2026-09-01",
      period: "month",
      to: "2026-09-30",
    });
    expect(draftOf({ to: "2026-08-31" }, now)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  test("the target asked for is kept as text", () => {
    expect(draftOf({ target: 99.95 }, now).target).toBe("99.95");
  });
});

describe("the address the form asks with", () => {
  const draft: ReportDraft = {
    from: "2026-08-10",
    id: "m1",
    kind: "monitor",
    month: "2026-09",
    period: "month",
    quarter: "2026-3",
    target: "99.9",
    to: "2026-09-02",
  };

  test("a month and a quarter ask for their first and last day, whatever the custom fields hold", () => {
    expect(datesOf(draft)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(datesOf({ ...draft, period: "quarter" })).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(datesOf({ ...draft, period: "custom" })).toEqual({
      from: "2026-08-10",
      to: "2026-09-02",
    });
  });

  test("carries the subject, the days and the target as a number", () => {
    expect(searchOf(draft)).toEqual({
      from: "2026-09-01",
      id: "m1",
      subject: "monitor",
      target: 99.9,
      to: "2026-09-30",
    });
  });

  test("asks for nothing while no subject is chosen or the target is not a number", () => {
    expect(searchOf({ ...draft, id: "" })).toBeUndefined();
    expect(searchOf({ ...draft, target: "" })).toBeUndefined();
    expect(searchOf({ ...draft, target: "high" })).toBeUndefined();
  });

  test("keeps a target of more than three decimals to three, and one outside the range is not asked for", () => {
    expect(searchOf({ ...draft, target: "99.99949" })?.target).toBe(99.999);
    expect(searchOf({ ...draft, target: "100" })).toBeUndefined();
    expect(searchOf({ ...draft, target: "0.5" })).toBeUndefined();
    // The least and the most a target may be are asked for.
    expect(searchOf({ ...draft, target: "1" })?.target).toBe(1);
    expect(searchOf({ ...draft, target: "99.999" })?.target).toBe(99.999);
  });
});

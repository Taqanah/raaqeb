import { describe, expect, test } from "bun:test";
import { actionParts, auditSpan, detailOf, targetOf } from "./audit.ts";

describe("a day range of the log", () => {
  test("covers whole days in the operator's zone, the last one included", () => {
    expect(auditSpan("2026-10-20", "2026-10-22", "Asia/Riyadh")).toEqual({
      since: Date.UTC(2026, 9, 19, 21),
      until: Date.UTC(2026, 9, 22, 21),
    });
    expect(auditSpan("2026-10-22", "2026-10-22", "UTC")).toEqual({
      since: Date.UTC(2026, 9, 22),
      until: Date.UTC(2026, 9, 23),
    });
  });

  test("has no bound on a side with no day, and the last day of a month reaches the next month's first", () => {
    expect(auditSpan(undefined, "2026-10-31", "UTC")).toEqual({
      until: Date.UTC(2026, 10, 1),
    });
    expect(auditSpan("2026-10-01", undefined, "UTC")).toEqual({
      since: Date.UTC(2026, 9, 1),
    });
    expect(auditSpan(undefined, undefined, "UTC")).toEqual({});
  });
});

describe("an audit entry's detail", () => {
  test("keeps the scalar fields of what was asked and never a secret, a value nested twice or a long text", () => {
    expect(
      detailOf({
        clientSecret: "s3cret",
        currentPassword: "pw",
        email: "ops@example.com",
        enabled: true,
        input: { options: { level: "nested twice" } },
        name: "x".repeat(300),
        retentionDays: 30,
        token: "rqi_x",
        values: { url: "https://hooks.example.test" },
      })
    ).toEqual({
      email: "ops@example.com",
      enabled: true,
      name: "x".repeat(200),
      retentionDays: 30,
    });
    expect(detailOf(undefined)).toEqual({});
    expect(detailOf(["a"])).toEqual({});
  });

  test("keeps what a bulk change set, under the change's name", () => {
    expect(
      detailOf({ change: { kind: "add_tag", tag: "prod" }, ids: ["m1", "m2"] })
    ).toEqual({ "change.kind": "add_tag", "change.tag": "prod" });
  });

  test("keeps no secret one level down, nor anything under a name that may hold one", () => {
    expect(
      detailOf({
        credentials: { user: "ops" },
        input: { clientSecret: "s3cret", name: "API", password: "pw" },
      })
    ).toEqual({ "input.name": "API" });
  });

  test("keeps at most twelve fields", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field${index}`, index])
    );
    expect(Object.keys(detailOf(many))).toHaveLength(12);
  });
});

describe("an audit entry's record", () => {
  test("is the id asked about, the ids joined, or the page's id; none for an install-wide change", () => {
    expect(targetOf({ id: "m1" })).toBe("m1");
    expect(targetOf({ ids: ["m1", "m2"] })).toBe("m1,m2");
    expect(targetOf({ pageId: "p1", subscriberId: "s1" })).toBe("p1");
    expect(targetOf({ clock: "24h" })).toBeNull();
    expect(targetOf(undefined)).toBeNull();
    // A value of another type names no record.
    expect(targetOf({ id: 5 })).toBeNull();
    expect(targetOf({ ids: "m1" })).toBeNull();
    expect(targetOf({ pageId: 3 })).toBeNull();
  });
});

describe("an action", () => {
  test("is a known target and verb, or nothing the page can word", () => {
    expect(actionParts("monitor.create")).toEqual({
      target: "monitor",
      verb: "create",
    });
    expect(actionParts("monitor.explode")).toBeUndefined();
    expect(actionParts("nothing")).toBeUndefined();
  });
});

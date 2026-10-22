import { describe, expect, test } from "bun:test";
import { actionParts, detailOf, targetOf } from "./audit.ts";

describe("an audit entry's detail", () => {
  test("keeps the scalar fields of what was asked and never a secret, a value nested twice or a long text", () => {
    expect(
      detailOf({
        clientSecret: "s3cret",
        currentPassword: "pw",
        email: "ops@example.com",
        enabled: true,
        input: { auth: { user: "nested twice" } },
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

import { describe, expect, test } from "bun:test";
import { managementOperations } from "@/shared/api/management.ts";
import { matchOperation, pageOfList, refusal, statusOf } from "./answer.ts";

const templateParameter = /\{(\w+)\}/g;

describe("which operation a request names", () => {
  test("every operation of the table is found at its own method and path, with its parameters", () => {
    for (const [name, operation] of Object.entries(managementOperations)) {
      const path = operation.path.replaceAll(
        templateParameter,
        (_, parameter: string) => `the-${parameter}`
      );
      const params = Object.fromEntries(
        [...operation.path.matchAll(templateParameter)].map(
          ([, parameter = ""]) => [parameter, `the-${parameter}`]
        )
      );
      const found: unknown = matchOperation(
        operation.method.toUpperCase(),
        path
      );
      expect(found).toEqual({
        name,
        ok: true,
        params,
      });
    }
  });

  test("is found whatever the path's case and with a trailing slash, as the router matches it", () => {
    expect(matchOperation("GET", "/API/V1/Monitors/")).toEqual({
      name: "listMonitors",
      ok: true,
      params: {},
    });
  });

  test("a parameter is read decoded, and a fixed segment wins over a parameter", () => {
    expect(
      matchOperation("POST", "/api/v1/groups/Web%20site/monitors")
    ).toEqual({
      name: "addToGroup",
      ok: true,
      params: { groupName: "Web site" },
    });
    expect(matchOperation("POST", "/api/v1/monitors/test")).toMatchObject({
      name: "testMonitor",
    });
  });

  test("a parameter's case is kept as sent", () => {
    expect(matchOperation("GET", "/api/v1/monitors/AbC")).toMatchObject({
      params: { monitorId: "AbC" },
    });
  });

  test("a path no operation has is not found", () => {
    for (const path of [
      "/api/v1/",
      "/api/v1/nothing",
      "/api/v1/monitors/a/b/c",
      "/api/v1/monitors//pause",
    ]) {
      expect(matchOperation("GET", path)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
  });

  test("a method the path does not take names the ones it does", () => {
    expect(matchOperation("PATCH", "/api/v1/monitors/a")).toEqual({
      allow: ["DELETE", "GET", "PUT"],
      ok: false,
      reason: "method_not_allowed",
    });
    expect(matchOperation("DELETE", "/api/v1/monitors")).toEqual({
      allow: ["GET", "POST"],
      ok: false,
      reason: "method_not_allowed",
    });
  });
});

describe("a refusal's status", () => {
  test("follows its reason, and any other refusal of a record's state is a conflict", () => {
    expect(
      Object.fromEntries(
        [
          "malformed",
          "unauthenticated",
          "forbidden",
          "second_step",
          "not_found",
          "not_allowed",
          "method_not_allowed",
          "invalid",
          "rate_limited",
          "corrupt",
          "unavailable",
          "slug_taken",
          "changed",
          "resolved",
          "paused",
        ].map((reason) => [reason, statusOf(reason)])
      )
    ).toEqual({
      changed: 409,
      corrupt: 500,
      forbidden: 403,
      invalid: 422,
      malformed: 400,
      method_not_allowed: 405,
      not_allowed: 403,
      not_found: 404,
      paused: 409,
      rate_limited: 429,
      resolved: 409,
      second_step: 403,
      slug_taken: 409,
      unauthenticated: 401,
      unavailable: 503,
    });
  });
});

describe("a refusal's answer", () => {
  test("is the reason as JSON at its status, never cached", async () => {
    const answer = refusal({ id: "m1", reason: "corrupt" });
    expect(answer.status).toBe(500);
    expect(answer.headers.get("content-type")).toContain("application/json");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({ id: "m1", reason: "corrupt" });
  });

  test("names the Bearer scheme when the key is missing or wrong", () => {
    expect(
      refusal({ reason: "unauthenticated" }).headers.get("www-authenticate")
    ).toBe("Bearer");
    expect(
      refusal({ reason: "forbidden" }).headers.get("www-authenticate")
    ).toBeNull();
  });

  test("carries the headers it is given, such as when to try again", () => {
    expect(
      refusal({ reason: "rate_limited" }, { "retry-after": "3" }).headers.get(
        "retry-after"
      )
    ).toBe("3");
  });
});

describe("one page of a list", () => {
  const items = ["a", "b", "c", "d", "e"];

  test("is the records from the offset, as many as the limit, with the whole list's count", () => {
    expect(pageOfList(items, { limit: 2, offset: 1 })).toEqual({
      items: ["b", "c"],
      limit: 2,
      offset: 1,
      total: 5,
    });
  });

  test("past the end is empty, and the last page holds what is left", () => {
    expect(pageOfList(items, { limit: 2, offset: 4 }).items).toEqual(["e"]);
    expect(pageOfList(items, { limit: 2, offset: 9 }).items).toEqual([]);
  });
});

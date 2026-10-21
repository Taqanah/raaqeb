import { describe, expect, test } from "bun:test";
import { Route } from "./admin/reports/report[.]csv.ts";

/** The CSV route's GET, called as the entry calls it. */
function get(context: object, url: string): Promise<Response> {
  const handlers = Route.options.server?.handlers;
  const handler = handlers && "GET" in handlers ? handlers.GET : undefined;
  if (typeof handler !== "function") {
    throw new Error("the CSV route has no GET handler");
  }
  // The handler's own context type is the entry's, which a test builds by hand.
  const call = handler as (arguments_: {
    context: object;
    request: Request;
  }) => Promise<Response>;
  return call({ context, request: new Request(url) });
}

describe("the report's CSV route", () => {
  test("refuses a request with no session by sending it to sign-in, before it reads anything", async () => {
    // No storage and no cookie: the session check finds no operator.
    const refused = await get(
      { boot: {}, holdOpen: () => undefined, storage: undefined },
      "http://127.0.0.1/admin/reports/report.csv?subject=monitor&id=x&from=2026-09-01&to=2026-09-03&target=99.9"
    );
    expect(refused.status).toBe(303);
    expect(new URL(refused.headers.get("location") ?? "").pathname).toBe(
      "/sign-in"
    );
    expect(await refused.text()).toBe("");
  });
});

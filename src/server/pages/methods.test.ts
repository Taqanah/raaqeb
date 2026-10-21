import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { getRouter } from "@/router.tsx";
import { methodNotAllowed } from "./methods.ts";

const router = getRouter();

const optionalLocale = /\{-\$locale\}\/?/;
const parameter = /\$[A-Za-z]*/g;
const trailingSlash = /\/$/;

/** Every route that answers by handlers alone, no page: its path with a value for each parameter, and the methods it declares. The route tree is the walk's one source, so a server route added tomorrow is walked tomorrow. */
function serverRoutes(): {
  readonly methods: string[];
  readonly path: string;
}[] {
  const found: { methods: string[]; path: string }[] = [];
  for (const route of Object.values(router.routesById)) {
    const options = z
      .object({
        component: z.unknown().optional(),
        // Handlers as an object by method or a function that makes one; a server option with only middleware has none.
        server: z
          .object({
            handlers: z
              .union([
                z.record(z.string(), z.unknown()),
                z.custom<
                  (tools: { createHandlers: <T>(handlers: T) => T }) => object
                >((value) => typeof value === "function"),
              ])
              .optional(),
          })
          .optional(),
      })
      .parse(route.options);
    const handlers = options.server?.handlers;
    if (handlers && !options.component) {
      found.push({
        methods: Object.keys(
          typeof handlers === "function"
            ? handlers({ createHandlers: (each) => each })
            : handlers
        ),
        path:
          route.fullPath
            .replace(optionalLocale, "")
            .replace(parameter, "x")
            .replace(trailingSlash, "") || "/",
      });
    }
  }
  return found;
}

const everyMethod = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

/** What the route allows: the methods it declares, and HEAD where it declares GET. */
function allowed(methods: readonly string[]): string[] {
  return [
    ...new Set([...methods, ...(methods.includes("GET") ? ["HEAD"] : [])]),
  ].toSorted();
}

describe("a server route's methods", () => {
  const routes = serverRoutes();

  test("the walk finds the server routes this install has: the API, the feeds, the health check and the metrics", () => {
    const paths = routes.map((route) => route.path);
    for (const expected of [
      "/health",
      "/metrics",
      "/api/pages/x/overview",
      "/api/heartbeat/x",
      "/api/auth/x",
      "/feed.atom",
      "/subscriptions/x/confirm",
      "/admin/import",
    ]) {
      expect(paths).toContain(expected);
    }
    expect(routes.length).toBeGreaterThan(15);
  });

  for (const route of routes) {
    test(`${route.path} answers a method it does not declare 405 with its Allow and no render, and lets the ones it declares through`, () => {
      const allow = allowed(route.methods);
      for (const method of everyMethod) {
        const answer = methodNotAllowed(
          router,
          new Request(`http://raaqeb.test${route.path}`, { method })
        );
        if (allow.includes(method)) {
          expect(answer).toBeUndefined();
        } else {
          expect(answer?.status).toBe(405);
          expect(answer?.headers.get("allow")).toBe(allow.join(", "));
          expect(answer?.body).toBeNull();
        }
      }
    });
  }

  test("a route under a locale answers the same with the locale in the address", () => {
    const answer = methodNotAllowed(
      router,
      new Request("http://raaqeb.test/en/feed.atom", { method: "POST" })
    );
    expect(answer?.status).toBe(405);
    expect(answer?.headers.get("allow")).toBe("GET, HEAD");
  });

  test("a page's address is left to the page, whatever the method", () => {
    for (const path of ["/sign-in", "/admin/monitors", "/"]) {
      expect(
        methodNotAllowed(
          router,
          new Request(`http://raaqeb.test${path}`, { method: "POST" })
        )
      ).toBeUndefined();
    }
  });
});

/**
 * The methods a server route answers. A route with handlers and no page
 * answers the methods it declares; Start hands every other method to the app
 * shell, a full render a stranger can ask for on any API address. This
 * answers such a request 405 with the `Allow` header and no render. It reads
 * the route the way Start's own matching does (`handleServerRoutes`), so the
 * two agree on which route a request reaches.
 */
import type { AnyRouter } from "@tanstack/react-router";
import { z } from "zod";

// The route's options are this module's parse boundary: Start keeps the handlers there, as an object by method or a function that makes one.
const serverOptions = z.object({
  component: z.unknown().optional(),
  server: z
    .object({
      handlers: z.union([
        z.record(z.string(), z.unknown()),
        z.custom<(tools: { createHandlers: <T>(handlers: T) => T }) => object>(
          (value) => typeof value === "function"
        ),
      ]),
    })
    .optional(),
});

/** The 405 for a request whose method the matched server route does not declare; nothing for any other request. */
export function methodNotAllowed(
  router: Pick<AnyRouter, "getMatchedRoutes">,
  request: Request
): Response | undefined {
  const [, params, route] = router.getMatchedRoutes(
    new URL(request.url).pathname
  );
  // As Start does: a route answers only an exact match, and a route with a page may defer an undeclared method to it.
  if (!route || "**" in params) {
    return;
  }
  const options = serverOptions.safeParse(route.options);
  const server = options.success ? options.data.server : undefined;
  if (!server || options.data?.component) {
    return;
  }
  const { handlers } = server;
  const declared = Object.keys(
    typeof handlers === "function"
      ? handlers({ createHandlers: (each) => each })
      : handlers
  );
  if (declared.includes("ANY")) {
    return;
  }
  const allow = [
    ...new Set([...declared, ...(declared.includes("GET") ? ["HEAD"] : [])]),
  ].toSorted();
  if (allow.includes(request.method.toUpperCase())) {
    return;
  }
  return new Response(null, {
    headers: { allow: allow.join(", ") },
    status: 405,
  });
}

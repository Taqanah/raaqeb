/**
 * The session check every admin server function carries: a
 * server function is dispatched by id at its own URL, so the layout's
 * beforeLoad never runs for it and a direct call would reach the handler
 * without a session. Not a route file: the leading dash keeps it out of the
 * route tree, as -onboarding.ts.
 */
import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { type Operator, operatorOfRequest } from "@/server/auth/session.ts";

/**
 * Refuses a caller with no session with the redirect the guard uses; forwards
 * a refreshed cookie. The handler behind it gets the operator, the open
 * storage and the Better Auth instance the session was read through.
 */
export const operatorMiddleware = createMiddleware({
  type: "function",
}).server(async ({ context, next }) => {
  const signedIn = await operatorOfRequest(
    context.storage,
    context.boot,
    getRequest()
  );
  if (!signedIn) {
    throw redirect({ to: "/sign-in" });
  }
  if (signedIn.setCookie) {
    setResponseHeader("set-cookie", signedIn.setCookie);
  }
  const { auth, operator, storage } = signedIn;
  return next({ context: { auth, operator, storage } });
});

/** The session check alone, for the guard and for a page with nothing of its own to read. */
export const readSession = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(({ context }): Operator => context.operator);

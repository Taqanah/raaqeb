/**
 * The check every admin server function carries: a server function is
 * dispatched by id at its own URL, so the layout's beforeLoad never runs
 * for it and a direct call would reach the handler without a session or a
 * role. Every admin server function names the permission it needs through
 * `permitted` (shared/domain/roles.ts); `-permissions.test.ts` fails on one
 * that names none. Not a route file: the leading dash keeps it out of the
 * route tree, as -onboarding.ts.
 */
import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import {
  type Operator,
  operatorOfRequest,
  refusalOf,
} from "@/server/auth/session.ts";
import type { Permission } from "@/shared/domain/roles.ts";

/**
 * Refuses a caller with no session with the redirect the guard uses, and
 * forwards a refreshed cookie; then refuses one whose role does not allow
 * the permission, sending them to the admin's first page, which every role
 * reads, and one who owes the second step an owner requires to the page
 * that switches it on. The admin UI hides or disables what a role may not
 * do, so only a stale page or a hand-made call meets that refusal. The
 * handler behind it gets the operator, the open storage and the Better Auth
 * instance the session was read through.
 */
export function permitted(permission: Permission) {
  return createMiddleware({ type: "function" }).server(
    async ({ context, next }) => {
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
      const refusal = await refusalOf(storage, operator, permission).catch(
        () => "unavailable" as const
      );
      if (refusal === "unavailable") {
        // As for a session that cannot be read: no answer the database cannot back.
        throw redirect({ to: "/sign-in" });
      }
      if (refusal === "second_step") {
        throw redirect({ to: "/admin/settings/sign-in" });
      }
      if (refusal === "role") {
        throw redirect({ to: "/admin" });
      }
      return next({ context: { auth, operator, storage } });
    }
  );
}

/** The session check alone, for the guard and for a page with nothing of its own to read. */
export const readSession = createServerFn({ method: "GET" })
  .middleware([permitted("profile")])
  .handler(({ context }): Operator => context.operator);

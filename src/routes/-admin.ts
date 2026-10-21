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
import { permittedCaller } from "@/server/api/caller.ts";
import { record } from "@/server/audit/audit.ts";
import type { AuthBoot } from "@/server/auth/auth.ts";
import {
  type Operator,
  operatorOfRequest,
  refusalOf,
} from "@/server/auth/session.ts";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { auditedFunctions } from "@/shared/domain/audit.ts";
import type { Permission } from "@/shared/domain/roles.ts";

/**
 * Refuses a caller with no session with the redirect the guard uses, and
 * forwards a refreshed cookie; then refuses one whose role does not allow
 * the permission, sending them to the admin's first page, which every role
 * reads, and one who owes the second step an owner requires to the page
 * that switches it on. The admin UI hides or disables what a role may not
 * do, so only a stale page or a hand-made call meets that refusal. The
 * handler behind it gets the operator, the open storage and the Better Auth
 * instance the session was read through. A management API call
 * (-api.ts) is its API key's instead, checked by the same permission
 * against what a key may do, and refused with the API's own JSON answer,
 * which the API's route hands back.
 */
export function permitted(permission: Permission) {
  return createMiddleware({ type: "function" }).server(
    async ({ context, data, method, next, serverFnMeta }) => {
      const request = getRequest();
      // A management API call is its key's, never a session's: the API's route read the caller first.
      const called = await permittedCaller(
        request,
        context.storage,
        context.boot,
        permission
      );
      if (called instanceof Response) {
        throw called;
      }
      const { auth, operator, storage } =
        called ?? (await sessionOf(context, request, permission));
      const done = await next({ context: { auth, operator, storage } });
      // A change that went through is an audit entry (CONTEXT.md "Audit entry"), recorded here so no server function can leave it out, whether a session or an API key made it.
      const action =
        method === "POST" ? auditedFunctions[keyOf(serverFnMeta)] : undefined;
      const result: unknown = Reflect.get(done, "result");
      if (action && succeeded(result)) {
        await record(storage, {
          action,
          actor: { email: operator.email, id: operator.id },
          address: request.headers.get(clientAddressHeader) ?? undefined,
          apiKey: operator.apiKey?.name,
          input: data,
          now: Date.now(),
        });
      }
      return done;
    }
  );
}

/** The signed-in operator whose role allows the permission, with the storage and Better Auth instance the session was read through; else the redirect that sends them where they may go. */
async function sessionOf(
  context: {
    readonly boot: AuthBoot;
    readonly storage: Storage | undefined;
  },
  request: Request,
  permission: Permission
) {
  const signedIn = await operatorOfRequest(
    context.storage,
    context.boot,
    request
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
  return { auth, operator, storage };
}

/** A server function as the audit table names it: its file under src/routes and its name. */
function keyOf(meta: { readonly filename: string; readonly name: string }) {
  return `${meta.filename.slice(meta.filename.indexOf(routesFolder) + routesFolder.length)} ${meta.name}`;
}
const routesFolder = "routes/";

/** Whether a server function's answer is not a refusal: every one answers `{ ok: false }` for one. */
function succeeded(result: unknown): boolean {
  return !(
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false
  );
}

/** The session check alone, for the guard and for a page with nothing of its own to read. */
export const readSession = createServerFn({ method: "GET" })
  .middleware([permitted("profile")])
  .handler(({ context }): Operator => context.operator);

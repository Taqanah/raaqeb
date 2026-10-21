/**
 * What the export, import and history download routes share: the session
 * check a server route makes itself, since the admin layout's guard runs
 * for pages only. Not a route file: the leading dash keeps
 * it out of the route tree.
 */

import { createCsrfMiddleware } from "@tanstack/react-start";
import type { RequestContext } from "@/handler.ts";
import {
  type Operator,
  operatorFor,
  refusalOf,
} from "@/server/auth/session.ts";
import type { Permission } from "@/shared/domain/roles.ts";

/** The cookie to refresh for a signed-in operator who may do what the permission names, or nothing without a session or the permission, which the route answers as signed out. */
export async function signedIn(
  context: RequestContext,
  request: Request,
  permission: Permission
): Promise<
  | { readonly operator: Operator; readonly setCookie: string | undefined }
  | undefined
> {
  const operator = await operatorFor(
    context.storage,
    context.boot,
    request.headers
  );
  if (!operator) {
    return;
  }
  const refusal = await refusalOf(
    operator.storage,
    operator.operator,
    permission
  ).catch(() => "unavailable");
  return refusal === undefined
    ? { operator: operator.operator, setCookie: operator.setCookie }
    : undefined;
}

/** Headers of a file download that no cache keeps; the content is zstd unless the file says another type. */
export function downloadHeaders(
  name: string,
  setCookie: string | undefined,
  type = "application/zstd"
): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${name}"`,
    "content-type": type,
  });
  if (setCookie) {
    headers.set("set-cookie", setCookie);
  }
  return headers;
}

/**
 * The origin check of a server route that writes, on the route
 * itself: the router matches a path whatever its case or a trailing slash,
 * so a filter on the path string in the Start instance let `/ADMIN/IMPORT`
 * through.
 */
export const originChecked = createCsrfMiddleware();

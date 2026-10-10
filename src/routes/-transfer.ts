/**
 * What the export, import and history download routes share: the session
 * check a server route makes itself, since the admin layout's guard runs
 * for pages only. Not a route file: the leading dash keeps
 * it out of the route tree.
 */

import { createCsrfMiddleware } from "@tanstack/react-start";
import type { RequestContext } from "@/handler.ts";
import { operatorFor } from "@/server/auth/session.ts";

/** The signed-in operator's storage and the cookie to refresh, or nothing without a session. */
export async function signedIn(
  context: RequestContext,
  request: Request
): Promise<{ readonly setCookie: string | undefined } | undefined> {
  const operator = await operatorFor(
    context.storage,
    context.boot,
    request.headers
  );
  return operator && { setCookie: operator.setCookie };
}

/** Headers of a file download that no cache keeps. */
export function downloadHeaders(
  name: string,
  setCookie: string | undefined
): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${name}"`,
    "content-type": "application/zstd",
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

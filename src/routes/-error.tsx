import { type ErrorComponentProps, useMatch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageError } from "@/admin/shell/page-error.tsx";
import { DocumentError, ErrorNotice } from "@/shared/ui/page-error.tsx";

/** What frames a failed route's error: the shell's page area, a page's own frame (a settings page), or nothing. */
export type ErrorPlace = "shell" | "page" | "document";

/** Where the failed route `routeId` sits. */
export function errorPlace(routeId: string): ErrorPlace {
  if (routeId.startsWith("/admin/settings/")) {
    return "page";
  }
  return routeId.startsWith("/admin/") ? "shell" : "document";
}

/**
 * The router's default error component, so no route shows the
 * router's English one: in the admin inside the shell, where the failed
 * route sits; everywhere else alone on the document. The shell's own read
 * failing leaves no shell to frame it. The status page views set their own,
 * which keeps the view they showed. Not a route file: the leading dash keeps
 * it out of the route tree.
 */
export function RouteError(_props: ErrorComponentProps): ReactNode {
  // The failed route: the boundary renders inside its match.
  const { routeId } = useMatch({ strict: false });
  switch (errorPlace(routeId)) {
    case "shell":
      return <PageError />;
    case "page":
      return <ErrorNotice titled />;
    default:
      return <DocumentError />;
  }
}

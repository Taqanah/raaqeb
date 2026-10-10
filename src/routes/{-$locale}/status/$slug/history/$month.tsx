import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { History, ViewUnavailable } from "@/public/views.tsx";
import { ViewMissing } from "@/routes/-missing.tsx";
import {
  historyHead,
  loadHistory,
  publicHeaders,
  type ViewLoaderOptions,
} from "@/routes/-public.ts";

// The page's history for one month, yyyy-mm, under a page's at /status/<slug> plain address, the
// other locale under its prefix; not found inside the
// page's frame when nothing is at the address.
export const Route = createFileRoute("/{-$locale}/status/$slug/history/$month")(
  {
    component: ViewRoute,
    // A failed refresh keeps the view it showed; the next one mends it.
    errorComponent: ViewRoute,
    head: ({ loaderData, match }) => historyHead(loaderData, match.error),
    headers: publicHeaders,
    loader: async ({
      params,
      parentMatchPromise,
    }: ViewLoaderOptions & { readonly params: { readonly month: string } }) =>
      await loadHistory(
        (await parentMatchPromise).loaderData?.view,
        params.month
      ),
    notFoundComponent: ViewMissing,
  }
);

function ViewRoute(): ReactNode {
  // The match keeps its last data when a reload fails, so the error boundary shows that too.
  const data = Route.useMatch().loaderData;
  if (!data) {
    return <ViewUnavailable />;
  }
  const { document, view } = data;
  return <History document={document} view={view} />;
}

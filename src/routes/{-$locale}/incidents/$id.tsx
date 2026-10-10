import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IncidentView, ViewUnavailable } from "@/public/views.tsx";
import { ViewMissing } from "@/routes/-missing.tsx";
import {
  incidentHead,
  loadIncident,
  publicHeaders,
  type ViewLoaderOptions,
} from "@/routes/-public.ts";

// One incident with every update, under the default page's, or the custom domain's plain address, the
// other locale under its prefix; not found inside the
// page's frame when nothing is at the address.
export const Route = createFileRoute("/{-$locale}/incidents/$id")({
  component: ViewRoute,
  // A failed refresh keeps the view it showed; the next one mends it.
  errorComponent: ViewRoute,
  head: ({ loaderData, match }) => incidentHead(loaderData, match.error),
  headers: publicHeaders,
  loader: async ({
    params,
    parentMatchPromise,
  }: ViewLoaderOptions & { readonly params: { readonly id: string } }) =>
    await loadIncident((await parentMatchPromise).loaderData?.view, params.id),
  notFoundComponent: ViewMissing,
});

function ViewRoute(): ReactNode {
  // The match keeps its last data when a reload fails, so the error boundary shows that too.
  const data = Route.useMatch().loaderData;
  if (!data) {
    return <ViewUnavailable />;
  }
  const { document, view } = data;
  return <IncidentView document={document} view={view} />;
}

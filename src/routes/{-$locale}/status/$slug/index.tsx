import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Overview } from "@/public/overview.tsx";
import { ViewUnavailable } from "@/public/views.tsx";
import {
  loadOverview,
  type OverviewData,
  overviewHead,
  publicHeaders,
  type ViewLoaderOptions,
} from "@/routes/-public.ts";
import { subscribeByForm } from "@/routes/-subscriptions.ts";

// A status page at /status/<slug>, the other locale under its prefix: the page the entry resolved from the slug, or not found.
export const Route = createFileRoute("/{-$locale}/status/$slug/")({
  component: OverviewRoute,
  // A failed refresh keeps the view it showed; the next one mends it.
  errorComponent: OverviewRoute,
  head: ({ loaderData, match }) => overviewHead(loaderData, match.error),
  headers: publicHeaders,
  loader: async ({
    parentMatchPromise,
  }: ViewLoaderOptions): Promise<OverviewData> =>
    await loadOverview((await parentMatchPromise).loaderData?.view),
});

function OverviewRoute(): ReactNode {
  // The match keeps its last data when a reload fails, so the error boundary shows that too.
  const data = Route.useMatch().loaderData;
  if (!data) {
    return <ViewUnavailable />;
  }
  const { document, view } = data;
  return (
    <Overview document={document} subscribe={subscribeByForm} view={view} />
  );
}

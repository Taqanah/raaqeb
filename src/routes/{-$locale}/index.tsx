import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Overview } from "@/public/overview.tsx";
import { ViewUnavailable } from "@/public/views.tsx";
import { readOnboardingStep } from "@/routes/-onboarding.ts";
import {
  atUnpublishedPage,
  loadOverview,
  type OverviewData,
  overviewHead,
  publicHeaders,
  type ViewLoaderOptions,
} from "@/routes/-public.ts";
import { subscribeByForm } from "@/routes/-subscriptions.ts";

// The bare host: the default status page's
// overview, or the one a custom domain claims, in its language or under the
// other locale's prefix. With no page to show, onboarding until the operator
// account exists and the admin area after, as before the public page; a
// visitor at an unpublished page's address finds nothing there.
export const Route = createFileRoute("/{-$locale}/")({
  component: OverviewRoute,
  // A failed refresh keeps the view it showed; the next one mends it.
  errorComponent: OverviewRoute,
  head: ({ loaderData, match }) => overviewHead(loaderData, match.error),
  headers: publicHeaders,
  loader: async ({
    params,
    parentMatchPromise,
  }: ViewLoaderOptions): Promise<OverviewData> => {
    const view = (await parentMatchPromise).loaderData?.view;
    if (!view && params.locale === undefined && !atUnpublishedPage()) {
      const step = await readOnboardingStep();
      throw redirect({
        to: step === "done" ? "/admin/monitors" : "/onboarding",
      });
    }
    return await loadOverview(view);
  },
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

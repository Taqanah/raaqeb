import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageFrame } from "@/public/overview.tsx";
import { SubscriptionPanel } from "@/public/subscribe.tsx";
import { themeScript } from "@/public/theme.tsx";
import { ViewUnavailable } from "@/public/views.tsx";
import { ViewMissing } from "@/routes/-missing.tsx";
import {
  readSubscriptionPageFn,
  type SubscriptionPageData,
} from "@/routes/-subscriptions.ts";
import { contentIn } from "@/shared/schemas/content.ts";
import type { PublicView } from "@/shared/schemas/overview.ts";
import { viewPath } from "@/shared/schemas/overview.ts";
import { faviconLinks } from "@/shared/ui/app-icons.ts";

/** What the page renders: the subscription and the page's frame, and the page the root resolved. */
interface Loaded extends SubscriptionPageData {
  readonly view: PublicView;
}

// A subscription's own page: what it is and
// where it stands, inside its status page's frame, in the subscription
// language, which the root read from the token. Opening it changes
// nothing; its buttons post to confirm and unsubscribe. Never cached and
// never indexed; a token no subscription has is the router's not-found.
export const Route = createFileRoute("/subscriptions/$token/")({
  component: SubscriptionRoute,
  head: ({ loaderData }) =>
    loaderData
      ? {
          links: faviconLinks(loaderData.frame.page.images.favicon),
          meta: [
            {
              title: contentIn(
                loaderData.frame.page.title,
                loaderData.view.locale,
                loaderData.frame.page.locale
              ),
            },
            { content: "noindex", name: "robots" },
          ],
          scripts: [{ children: themeScript(loaderData.frame.page.theme) }],
        }
      : {},
  headers: () => ({ "cache-control": "no-store" }),
  loader: async ({
    params,
    parentMatchPromise,
  }: {
    readonly params: { readonly token: string };
    readonly parentMatchPromise: Promise<{
      readonly loaderData?: { readonly view: PublicView | undefined };
    }>;
  }): Promise<Loaded> => {
    const view = (await parentMatchPromise).loaderData?.view;
    const data = await readSubscriptionPageFn({
      data: { token: params.token },
    });
    if (!(view && data)) {
      throw notFound();
    }
    return { ...data, view };
  },
  // No subscription names no page to frame it: the router's plain answer.
  notFoundComponent: ViewMissing,
});

function SubscriptionRoute(): ReactNode {
  const data = Route.useMatch().loaderData;
  const { token } = Route.useParams();
  if (!data) {
    return <ViewUnavailable />;
  }
  const { frame, subscription, view } = data;
  return (
    <PageFrame page={frame.page} suffix={undefined} view={view}>
      <SubscriptionPanel
        overview={viewPath(view.paths, view.locale, "")}
        subscription={subscription}
        token={token}
      />
    </PageFrame>
  );
}

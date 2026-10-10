import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { SubscriberListPage } from "@/admin/pages/subscriber-list.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { readSubscribersFn, removeSubscriberFn } from "@/routes/-pages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";

// A status page's subscribers: the list,
// newest first, and remove. An unknown page is the not-found page.
export const Route = createFileRoute("/admin/pages/$id/subscribers")({
  component: SubscribersPage,
  pendingComponent: () => <PageSkeleton action={[]} columns={7} />,
  loader: async ({ abortController: { signal }, params }) => {
    const [list, clock] = await Promise.all([
      readSubscribersFn({ data: { pageId: params.id }, signal }),
      readOperatorClockFn({ signal }),
    ]);
    if (!list.ok && list.reason === "not_found") {
      throw notFound();
    }
    return { clock, list };
  },
});

function SubscribersPage() {
  const { clock, list } = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const removeFn = useServerFn(removeSubscriberFn);
  const remove = useCallback(
    (subscriberId: string) =>
      removeFn({ data: { id: subscriberId, pageId: id } }),
    [id, removeFn]
  );
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  if (!list.ok) {
    return (
      <Page
        parent={{ label: t("page_list_title"), to: "/admin/pages" }}
        title={t("page_subscribers")}
      >
        <Alert variant="destructive">
          <AlertDescription>{t("page_unavailable")}</AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <SubscriberListPage
      clock={clock}
      list={list.list}
      onRemoved={reread}
      remove={remove}
    />
  );
}

import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { SeriesPage } from "@/admin/maintenance/series-page.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  editSeriesFn,
  endSeriesFn,
  readSeriesFn,
} from "@/routes/-maintenance.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { SeriesInput } from "@/shared/schemas/maintenance.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A maintenance series' page: how it repeats, its scheduled occurrences,
// its form and ending it. Every write reads the page again. An unknown id
// is the not-found page.
export const Route = createFileRoute("/admin/maintenance/series/$id")({
  component: SeriesRoute,
  pendingComponent: FormSkeleton,
  loader: async ({ abortController: { signal }, params }) => {
    const [result, clock] = await Promise.all([
      readSeriesFn({ data: { id: params.id }, signal }),
      readOperatorClockFn({ signal }),
    ]);
    if (!result.ok && result.reason === "not_found") {
      throw notFound();
    }
    return { clock, result };
  },
});

function SeriesRoute() {
  const { clock, result } = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const editFn = useServerFn(editSeriesFn);
  const endFn = useServerFn(endSeriesFn);
  const edit = useCallback(
    (input: SeriesInput) => editFn({ data: { id, input } }),
    [editFn, id]
  );
  const end = useCallback(() => endFn({ data: { id } }), [endFn, id]);
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  const toast = useSavedToast();
  const ended = useCallback(() => {
    toast(t("maintenance_series_ended"));
    router.navigate({ to: "/admin/maintenance" }).catch(() => undefined);
  }, [router, t, toast]);
  if (!result.ok) {
    return (
      <Page title={t("maintenance_list_title")}>
        <Alert variant="destructive">
          <AlertDescription>
            {result.reason === "corrupt" ? (
              <>
                {t("maintenance_corrupt")} <Token>{result.id}</Token>
              </>
            ) : (
              t("maintenance_unavailable")
            )}
          </AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <SeriesPage
      clock={clock}
      edit={edit}
      end={end}
      onChanged={reread}
      onEnded={ended}
      page={result.page}
    />
  );
}

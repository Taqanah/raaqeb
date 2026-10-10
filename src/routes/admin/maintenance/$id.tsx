import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { WindowPage } from "@/admin/maintenance/window-form.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import {
  deleteMaintenanceFn,
  editMaintenanceFn,
  endMaintenanceFn,
  readMaintenanceFn,
} from "@/routes/-maintenance.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { MaintenanceEditInput } from "@/shared/schemas/maintenance.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A maintenance window's page: its summary, the edit its stage
// allows, ending it now and cancelling it. Every write reads the page again.
// An unknown id is the not-found page.
export const Route = createFileRoute("/admin/maintenance/$id")({
  component: WindowRoute,
  pendingComponent: FormSkeleton,
  loader: async ({ abortController: { signal }, params }) => {
    const [result, clock] = await Promise.all([
      readMaintenanceFn({ data: { id: params.id }, signal }),
      readOperatorClockFn({ signal }),
    ]);
    if (!result.ok && result.reason === "not_found") {
      throw notFound();
    }
    return { clock, result };
  },
});

function WindowRoute() {
  const { clock, result } = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const editFn = useServerFn(editMaintenanceFn);
  const endFn = useServerFn(endMaintenanceFn);
  const deleteFn = useServerFn(deleteMaintenanceFn);
  const edit = useCallback(
    (input: MaintenanceEditInput) => editFn({ data: { id, input } }),
    [editFn, id]
  );
  const end = useCallback(() => endFn({ data: { id } }), [endFn, id]);
  const cancel = useCallback(() => deleteFn({ data: { id } }), [deleteFn, id]);
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  const removed = useCallback(() => {
    router.navigate({ to: "/admin/maintenance" }).catch(() => undefined);
  }, [router]);
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
    <WindowPage
      cancel={cancel}
      clock={clock}
      edit={edit}
      end={end}
      onChanged={reread}
      onRemoved={removed}
      page={result.page}
    />
  );
}

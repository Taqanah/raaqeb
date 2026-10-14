import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { IncidentPage } from "@/admin/incidents/incident-page.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  deleteIncidentFn,
  editIncidentFn,
  fixUpdateFn,
  postUpdateFn,
  readIncidentFn,
} from "@/routes/-incidents.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Content } from "@/shared/schemas/content.ts";
import type {
  IncidentFields,
  IncidentUpdateInput,
} from "@/shared/schemas/incident.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// An incident's page: its updates, the next one, the title and
// impact edit, and delete. Every save reads the page again. An unknown id is
// the not-found page.
export const Route = createFileRoute("/admin/incidents/$id")({
  component: IncidentRoute,
  pendingComponent: () => <FormSkeleton panel="card" />,
  loader: async ({ abortController: { signal }, params }) => {
    const [result, clock] = await Promise.all([
      readIncidentFn({ data: { id: params.id }, signal }),
      readOperatorClockFn({ signal }),
    ]);
    if (!result.ok && result.reason === "not_found") {
      throw notFound();
    }
    return { clock, result };
  },
});

function IncidentRoute() {
  const { clock, result } = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const editFn = useServerFn(editIncidentFn);
  const postFn = useServerFn(postUpdateFn);
  const fixFn = useServerFn(fixUpdateFn);
  const deleteFn = useServerFn(deleteIncidentFn);
  const edit = useCallback(
    (input: IncidentFields) => editFn({ data: { id, input } }),
    [editFn, id]
  );
  const post = useCallback(
    (input: IncidentUpdateInput) => postFn({ data: { id, input } }),
    [id, postFn]
  );
  const fix = useCallback(
    (updateId: string, message: Content) =>
      fixFn({ data: { id, message, updateId } }),
    [fixFn, id]
  );
  const remove = useCallback(() => deleteFn({ data: { id } }), [deleteFn, id]);
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  const toast = useSavedToast();
  const removed = useCallback(() => {
    toast(t("incident_deleted"));
    router.navigate({ to: "/admin/incidents" }).catch(() => undefined);
  }, [router, t, toast]);
  if (!result.ok) {
    return (
      <Page title={t("incident_list_title")}>
        <Alert variant="destructive">
          <AlertDescription>
            {result.reason === "corrupt" ? (
              <>
                {t("incident_corrupt")} <Token>{result.id}</Token>
              </>
            ) : (
              t("incident_unavailable")
            )}
          </AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <IncidentPage
      clock={clock}
      edit={edit}
      fix={fix}
      onChanged={reread}
      onRemoved={removed}
      page={result.page}
      post={post}
      remove={remove}
    />
  );
}

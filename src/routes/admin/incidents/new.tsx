import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { NewIncidentForm } from "@/admin/incidents/new-incident-form.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import { createIncidentFn, readNewIncidentFn } from "@/routes/-incidents.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Incident,
  type IncidentCreateInput,
  newIncidentSearchSchema,
} from "@/shared/schemas/incident.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A new incident. A down notification's "open incident" link
// lands here with `?monitor=<id>`, which starts the form from that
// monitor. Publishing opens the incident's page.
export const Route = createFileRoute("/admin/incidents/new")({
  validateSearch: (search) => newIncidentSearchSchema.parse(search),
  // TanStack infers each option from the ones before it: search, then deps, then the loader.
  loaderDeps: ({ search }) => ({ monitor: search.monitor }),
  loader: ({ abortController: { signal }, deps }) =>
    readNewIncidentFn({ data: { monitor: deps.monitor }, signal }),
  component: NewIncidentPage,
  pendingComponent: FormSkeleton,
});

function NewIncidentPage() {
  const form = Route.useLoaderData();
  const router = useRouter();
  const { t } = useMessages();
  const toast = useSavedToast();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const createFn = useServerFn(createIncidentFn);
  const create = useCallback(
    (input: IncidentCreateInput) => createFn({ data: input }),
    [createFn]
  );
  const created = useCallback(
    (incident: Incident) => {
      toast(t("incident_created"));
      router
        .navigate({ params: { id: incident.id }, to: "/admin/incidents/$id" })
        .catch(() => undefined);
    },
    [router, t, toast]
  );
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  if (!form.ok) {
    return (
      <Page
        parent={{ label: t("incident_list_title"), to: "/admin/incidents" }}
        title={t("incident_new_title")}
      >
        <Alert variant="destructive">
          <AlertDescription>
            {form.reason === "corrupt" ? (
              <>
                {t("incident_corrupt")} <Token>{form.id}</Token>
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
    <NewIncidentForm
      create={create}
      form={form.form}
      onCreated={created}
      onStale={reread}
    />
  );
}

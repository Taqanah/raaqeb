import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { NewWindowForm } from "@/admin/maintenance/window-form.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  createMaintenanceFn,
  readNewMaintenanceFn,
} from "@/routes/-maintenance.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MaintenanceInput,
  MaintenanceWindow,
} from "@/shared/schemas/maintenance.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A new maintenance window. Scheduling it opens its page.
export const Route = createFileRoute("/admin/maintenance/new")({
  component: NewWindowPage,
  pendingComponent: FormSkeleton,
  loader: async ({ abortController: { signal } }) => {
    const [result, clock] = await Promise.all([
      readNewMaintenanceFn({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, result };
  },
});

function NewWindowPage() {
  const { clock, result } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useMessages();
  const toast = useSavedToast();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const createFn = useServerFn(createMaintenanceFn);
  const create = useCallback(
    (input: MaintenanceInput) => createFn({ data: input }),
    [createFn]
  );
  const created = useCallback(
    (window: MaintenanceWindow) => {
      toast(t("maintenance_created"));
      router
        .navigate({ params: { id: window.id }, to: "/admin/maintenance/$id" })
        .catch(() => undefined);
    },
    [router, t, toast]
  );
  if (!result.ok) {
    return (
      <Page
        parent={{
          label: t("maintenance_list_title"),
          to: "/admin/maintenance",
        }}
        title={t("maintenance_new_title")}
      >
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
    <NewWindowForm
      clock={clock}
      create={create}
      form={result.form}
      onCreated={created}
    />
  );
}

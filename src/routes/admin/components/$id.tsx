import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { ComponentForm } from "@/admin/pages/component-form.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  deleteComponentFn,
  editComponentFn,
  readComponentFormFn,
} from "@/routes/-pages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ComponentInput } from "@/shared/schemas/component.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A component's page: its form, its status now, the pages that
// show it, and delete. A save reads the page again, so the status follows
// the links at once. An unknown id is the not-found page.
export const Route = createFileRoute("/admin/components/$id")({
  component: ComponentPage,
  pendingComponent: () => <FormSkeleton panel="card" />,
  loader: async ({ abortController: { signal }, params }) => {
    const form = await readComponentFormFn({ data: { id: params.id }, signal });
    if (!form.ok && form.reason === "not_found") {
      throw notFound();
    }
    return form;
  },
});

function ComponentPage() {
  const form = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const editFn = useServerFn(editComponentFn);
  const deleteFn = useServerFn(deleteComponentFn);
  const save = useCallback(
    (input: ComponentInput) => editFn({ data: { id, input } }),
    [editFn, id]
  );
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  const remove = useCallback(() => deleteFn({ data: { id } }), [deleteFn, id]);
  const toast = useSavedToast();
  const removed = useCallback(() => {
    toast(t("component_deleted"));
    router.navigate({ to: "/admin/components" }).catch(() => undefined);
  }, [router, t, toast]);
  if (!form.ok) {
    return (
      <Page title={t("component_list_title")}>
        <Alert variant="destructive">
          <AlertDescription>
            {form.reason === "corrupt" ? (
              <>
                {t("component_corrupt")} <Token>{form.id}</Token>
              </>
            ) : (
              t("component_unavailable")
            )}
          </AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <ComponentForm
      form={form.form}
      key={form.form.component?.id}
      onRemoved={removed}
      onSaved={reread}
      remove={remove}
      save={save}
    />
  );
}

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { ComponentForm } from "@/admin/pages/component-form.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import { createComponentFn, readComponentFormFn } from "@/routes/-pages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Component, ComponentInput } from "@/shared/schemas/component.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A new component: save creates it and opens its page.
export const Route = createFileRoute("/admin/components/new")({
  component: NewComponentPage,
  pendingComponent: () => <FormSkeleton panel="empty" />,
  loader: ({ abortController: { signal } }) =>
    readComponentFormFn({ data: {}, signal }),
});

function NewComponentPage() {
  const form = Route.useLoaderData();
  const router = useRouter();
  const { t } = useMessages();
  const toast = useSavedToast();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const createFn = useServerFn(createComponentFn);
  const save = useCallback(
    (input: ComponentInput) => createFn({ data: input }),
    [createFn]
  );
  const saved = useCallback(
    (component: Component) => {
      toast(t("component_created"));
      router
        .navigate({
          params: { id: component.id },
          to: "/admin/components/$id",
        })
        .catch(() => undefined);
    },
    [router, t, toast]
  );
  if (!form.ok) {
    return (
      <Page
        parent={{ label: t("component_list_title"), to: "/admin/components" }}
        title={t("component_new_title")}
      >
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
  return <ComponentForm form={form.form} onSaved={saved} save={save} />;
}

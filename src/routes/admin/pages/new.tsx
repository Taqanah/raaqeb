import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { NewPageForm } from "@/admin/pages/new-page-form.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import { createPageFn, readInstallLanguageFn } from "@/routes/-pages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { PageCreateInput, StatusPage } from "@/shared/schemas/page.ts";

// A new status page: its title, slug and page language; create
// opens its editor for everything else.
export const Route = createFileRoute("/admin/pages/new")({
  component: NewPagePage,
  pendingComponent: FormSkeleton,
  loader: ({ abortController: { signal } }) =>
    readInstallLanguageFn({ signal }),
});

function NewPagePage() {
  const installLanguage = Route.useLoaderData();
  const router = useRouter();
  const { t } = useMessages();
  const toast = useSavedToast();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const createFn = useServerFn(createPageFn);
  const create = useCallback(
    (input: PageCreateInput) => createFn({ data: input }),
    [createFn]
  );
  const created = useCallback(
    (page: StatusPage) => {
      toast(t("page_created"));
      router
        .navigate({ params: { id: page.id }, to: "/admin/pages/$id" })
        .catch(() => undefined);
    },
    [router, t, toast]
  );
  return (
    <NewPageForm
      create={create}
      installLanguage={installLanguage}
      onCreated={created}
    />
  );
}

import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo } from "react";
import type { ImageActions } from "@/admin/pages/image-field.tsx";
import { PageEditor } from "@/admin/pages/page-editor.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  deletePageFn,
  readPageEditorFn,
  removePageImageFn,
  savePageFn,
  uploadPageImageFn,
} from "@/routes/-pages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { PageImageKind, PageInput } from "@/shared/schemas/page.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A status page's editor: its fields, its components and
// groups, its customization and its images. A save or an image reads the
// page again. An unknown id is the not-found page.
export const Route = createFileRoute("/admin/pages/$id/")({
  component: PageEditorPage,
  // The editor's View and Subscribers buttons.
  pendingComponent: () => <FormSkeleton action={["w-24", "w-28"]} />,
  loader: async ({ abortController: { signal }, params }) => {
    const editor = await readPageEditorFn({ data: { id: params.id }, signal });
    if (!editor.ok && editor.reason === "not_found") {
      throw notFound();
    }
    return editor;
  },
});

function PageEditorPage() {
  const editor = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const saveFn = useServerFn(savePageFn);
  const deleteFn = useServerFn(deletePageFn);
  const uploadFn = useServerFn(uploadPageImageFn);
  const removeImageFn = useServerFn(removePageImageFn);
  const save = useCallback(
    (input: PageInput) => saveFn({ data: { id, input } }),
    [id, saveFn]
  );
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  const remove = useCallback(() => deleteFn({ data: { id } }), [deleteFn, id]);
  const toast = useSavedToast();
  const removed = useCallback(() => {
    toast(t("page_deleted"));
    router.navigate({ to: "/admin/pages" }).catch(() => undefined);
  }, [router, t, toast]);
  const images: ImageActions = useMemo(
    () => ({
      remove: (kind: PageImageKind) => removeImageFn({ data: { id, kind } }),
      upload: (kind: PageImageKind, file: File) => {
        const data = new FormData();
        data.set("id", id);
        data.set("kind", kind);
        data.set("file", file);
        return uploadFn({ data });
      },
    }),
    [id, removeImageFn, uploadFn]
  );
  if (!editor.ok) {
    return (
      <Page title={t("page_list_title")}>
        <Alert variant="destructive">
          <AlertDescription>
            {editor.reason === "corrupt" ? (
              <>
                {t("page_corrupt")} <Token>{editor.id}</Token>
              </>
            ) : (
              t("page_unavailable")
            )}
          </AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <PageEditor
      editor={editor.editor}
      images={images}
      key={editor.editor.page.id}
      onImagesChanged={reread}
      onRemoved={removed}
      onSaved={reread}
      remove={remove}
      save={save}
    />
  );
}

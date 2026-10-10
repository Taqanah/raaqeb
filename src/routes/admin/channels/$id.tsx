import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { ChannelForm } from "@/admin/channels/form.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import {
  deleteChannelFn,
  editChannelFn,
  readChannelFormFn,
  sendTestFn,
} from "@/routes/-channels.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ChannelInput } from "@/shared/schemas/channel.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

// A channel's page: its form, its signing secret, its
// notification preview, "send test", its recent sends and delete. A save or
// a test reads the page again, so the recent sends, a renewed secret and the
// preview in a changed language show at once. An unknown id is the
// not-found page.
export const Route = createFileRoute("/admin/channels/$id")({
  component: ChannelPage,
  pendingComponent: () => <FormSkeleton panel="card" />,
  loader: async ({ abortController: { signal }, params }) => {
    const [form, clock] = await Promise.all([
      readChannelFormFn({ data: { id: params.id }, signal }),
      readOperatorClockFn({ signal }),
    ]);
    if (!form.ok && form.reason === "not_found") {
      throw notFound();
    }
    return { clock, form };
  },
});

function ChannelPage() {
  const { clock, form } = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const editFn = useServerFn(editChannelFn);
  const deleteFn = useServerFn(deleteChannelFn);
  const testFn = useServerFn(sendTestFn);
  const save = useCallback(
    (input: ChannelInput, options: { readonly renewGenerated: boolean }) =>
      editFn({ data: { id, input, ...options } }),
    [editFn, id]
  );
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  const test = useCallback(async () => {
    const result = await testFn({ data: { id } });
    await router.invalidate();
    return result;
  }, [id, router, testFn]);
  const remove = useCallback(() => deleteFn({ data: { id } }), [deleteFn, id]);
  const removed = useCallback(() => {
    router.navigate({ to: "/admin/channels" }).catch(() => undefined);
  }, [router]);
  if (!form.ok) {
    return (
      <Page title={t("channel_list_title")}>
        <Alert variant="destructive">
          <AlertDescription>
            {form.reason === "corrupt" ? (
              <>
                {t("channel_corrupt")} <Token>{form.id}</Token>
              </>
            ) : (
              t("channel_unavailable")
            )}
          </AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <ChannelForm
      clock={clock}
      form={form.form}
      key={form.form.channel.id}
      onRemoved={removed}
      onSaved={reread}
      remove={remove}
      save={save}
      test={test}
      type={form.form.channel.type}
    />
  );
}

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { ChannelForm } from "@/admin/channels/form.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import { createChannelFn } from "@/routes/-channels.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Channel, ChannelInput } from "@/shared/schemas/channel.ts";

// A new channel: save creates it and opens its page, where its
// signing secret shows and "send test" runs.
export const Route = createFileRoute("/admin/channels/new")({
  component: NewChannelPage,
  pendingComponent: FormSkeleton,
  loader: ({ abortController: { signal } }) => readOperatorClockFn({ signal }),
});

function NewChannelPage() {
  const clock = Route.useLoaderData();
  const router = useRouter();
  const { t } = useMessages();
  const toast = useSavedToast();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const createFn = useServerFn(createChannelFn);
  const save = useCallback(
    (input: ChannelInput) => createFn({ data: input }),
    [createFn]
  );
  const saved = useCallback(
    (channel: Channel) => {
      toast(t("channel_created"));
      router
        .navigate({ params: { id: channel.id }, to: "/admin/channels/$id" })
        .catch(() => undefined);
    },
    [router, t, toast]
  );
  return (
    <ChannelForm
      clock={clock}
      form={undefined}
      onSaved={saved}
      save={save}
      type="webhook"
    />
  );
}

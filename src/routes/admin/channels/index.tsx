import { createFileRoute } from "@tanstack/react-router";
import { ChannelList } from "@/admin/channels/list.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { readChannelListFn } from "@/routes/-channels.ts";

// The channels list: the sidebar's "Notification channels" lands here.
export const Route = createFileRoute("/admin/channels/")({
  component: ChannelsPage,
  pendingComponent: PageSkeleton,
  loader: ({ abortController: { signal } }) => readChannelListFn({ signal }),
});

function ChannelsPage() {
  const result = Route.useLoaderData();
  return <ChannelList result={result} />;
}

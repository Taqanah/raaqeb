import { createFileRoute } from "@tanstack/react-router";
import { ComponentList } from "@/admin/pages/component-list.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { readComponentListFn } from "@/routes/-pages.ts";

// The components list: the sidebar's "Components" lands here.
export const Route = createFileRoute("/admin/components/")({
  component: ComponentsPage,
  pendingComponent: () => <PageSkeleton columns={6} />,
  loader: ({ abortController: { signal } }) => readComponentListFn({ signal }),
});

function ComponentsPage() {
  const result = Route.useLoaderData();
  return <ComponentList result={result} />;
}

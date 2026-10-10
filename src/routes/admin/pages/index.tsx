import { createFileRoute } from "@tanstack/react-router";
import { PageList } from "@/admin/pages/page-list.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { readPageListFn } from "@/routes/-pages.ts";

// The status pages list: the sidebar's "Status pages" lands here.
export const Route = createFileRoute("/admin/pages/")({
  component: PagesPage,
  pendingComponent: PageSkeleton,
  loader: ({ abortController: { signal } }) => readPageListFn({ signal }),
});

function PagesPage() {
  const result = Route.useLoaderData();
  return <PageList result={result} />;
}

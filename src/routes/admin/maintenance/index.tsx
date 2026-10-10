import { createFileRoute } from "@tanstack/react-router";
import { WindowList } from "@/admin/maintenance/window-list.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { readMaintenanceListFn } from "@/routes/-maintenance.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";

// The maintenance list: the sidebar's "Maintenance windows" lands here.
export const Route = createFileRoute("/admin/maintenance/")({
  component: MaintenancePage,
  pendingComponent: () => <PageSkeleton columns={6} />,
  loader: async ({ abortController: { signal } }) => {
    const [result, clock] = await Promise.all([
      readMaintenanceListFn({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, result };
  },
});

function MaintenancePage() {
  const { clock, result } = Route.useLoaderData();
  return <WindowList clock={clock} result={result} />;
}

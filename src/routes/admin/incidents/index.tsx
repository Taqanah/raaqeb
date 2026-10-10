import { createFileRoute } from "@tanstack/react-router";
import { IncidentList } from "@/admin/incidents/incident-list.tsx";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { readIncidentListFn } from "@/routes/-incidents.ts";
import { readOperatorClockFn } from "@/routes/-monitors.ts";

// The incidents list: the sidebar's "Incidents" lands here.
export const Route = createFileRoute("/admin/incidents/")({
  component: IncidentsPage,
  pendingComponent: () => <PageSkeleton columns={6} />,
  loader: async ({ abortController: { signal } }) => {
    const [result, clock] = await Promise.all([
      readIncidentListFn({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, result };
  },
});

function IncidentsPage() {
  const { clock, result } = Route.useLoaderData();
  return <IncidentList clock={clock} result={result} />;
}

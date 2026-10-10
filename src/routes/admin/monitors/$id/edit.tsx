import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { MonitorForm, type SaveOptions } from "@/admin/monitors/form.tsx";
import { FormRefused } from "@/admin/monitors/form-refused.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  editMonitorFn,
  listContainersFn,
  readMonitorFormFn,
  readOperatorClockFn,
  testMonitorFn,
} from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";

// The edit form: the list's item menu and the detail
// page land here, and a new heartbeat monitor after its save; a save returns
// to the detail page. An unknown id is the not-found page.
// Stored credentials arrive as names only; a secret left empty is kept by
// the server. A heartbeat monitor's last heartbeat is
// shown in the operator's time zone.
export const Route = createFileRoute("/admin/monitors/$id/edit")({
  component: EditMonitorPage,
  pendingComponent: () => <FormSkeleton panel="card" />,
  loader: async ({ abortController: { signal }, params }) => {
    const [form, clock] = await Promise.all([
      readMonitorFormFn({ data: { id: params.id }, signal }),
      readOperatorClockFn({ signal }),
    ]);
    if (!form.ok && form.reason === "not_found") {
      throw notFound();
    }
    return { clock, form };
  },
});

function EditMonitorPage() {
  const { clock, form } = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const { t } = useMessages();
  const toast = useSavedToast();
  const editFn = useServerFn(editMonitorFn);
  const testFn = useServerFn(testMonitorFn);
  const listFn = useServerFn(listContainersFn);
  const save = useCallback(
    (input: MonitorInput, options: SaveOptions) =>
      editFn({ data: { id, input, ...options } }),
    [editFn, id]
  );
  const list = useCallback(
    (endpoint: string) => listFn({ data: { endpoint } }),
    [listFn]
  );
  const test = useCallback(
    (input: MonitorInput) => testFn({ data: { id, input } }),
    [id, testFn]
  );
  const saved = useCallback(() => {
    toast(t("monitor_saved"));
    router
      .navigate({ params: { id }, to: "/admin/monitors/$id" })
      .catch(() => undefined);
  }, [id, router, t, toast]);
  if (!form.ok) {
    return <FormRefused refusal={form} />;
  }
  return (
    <MonitorForm
      clock={clock}
      credentials={form.credentials}
      heartbeat={form.heartbeat}
      listContainers={list}
      monitor={form.monitor}
      onSaved={saved}
      options={form.options}
      original={undefined}
      save={save}
      test={test}
    />
  );
}

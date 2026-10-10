import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { MonitorForm } from "@/admin/monitors/form.tsx";
import { FormRefused } from "@/admin/monitors/form-refused.tsx";
import { FormSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  createMonitorFn,
  listContainersFn,
  readMonitorFormFn,
  testMonitorFn,
} from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Monitor,
  type MonitorInput,
  newMonitorSearchSchema,
} from "@/shared/schemas/monitor.ts";

// The new-monitor form: N on the list lands here. The loader
// reads the names to suggest and the install's retention; save creates the
// monitor and opens its detail page, or a new heartbeat monitor's edit page
// to show its URL. A monitor's "duplicate" lands here with `?copy=<id>`,
// which starts the form from that monitor.
export const Route = createFileRoute("/admin/monitors/new")({
  validateSearch: (search) => newMonitorSearchSchema.parse(search),
  // TanStack infers each option from the ones before it: search, then deps, then the loader.
  loaderDeps: ({ search }) => ({ copy: search.copy }),
  loader: ({ abortController: { signal }, deps }) =>
    readMonitorFormFn({ data: { copy: deps.copy }, signal }),
  component: NewMonitorPage,
  pendingComponent: () => <FormSkeleton panel="card" />,
});

function NewMonitorPage() {
  const form = Route.useLoaderData();
  const router = useRouter();
  const { t } = useMessages();
  const toast = useSavedToast();
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const createFn = useServerFn(createMonitorFn);
  const testFn = useServerFn(testMonitorFn);
  const listFn = useServerFn(listContainersFn);
  const save = useCallback(
    (input: MonitorInput) => createFn({ data: input }),
    [createFn]
  );
  const list = useCallback(
    (endpoint: string) => listFn({ data: { endpoint } }),
    [listFn]
  );
  const test = useCallback(
    (input: MonitorInput) => testFn({ data: { input } }),
    [testFn]
  );
  // A new heartbeat monitor lands on its edit page, where its URL shows; any other on its detail page.
  const saved = useCallback(
    (monitor: Monitor) => {
      toast(t("monitor_created"));
      const next =
        monitor.config.type === "heartbeat"
          ? router.navigate({
              params: { id: monitor.id },
              to: "/admin/monitors/$id/edit",
            })
          : router.navigate({
              params: { id: monitor.id },
              to: "/admin/monitors/$id",
            });
      next.catch(() => undefined);
    },
    [router, t, toast]
  );
  if (!form.ok) {
    return <FormRefused refusal={form} />;
  }
  return (
    <MonitorForm
      clock={undefined}
      credentials={form.credentials}
      heartbeat={form.heartbeat}
      // Another original, or none, is a new draft: the form's state starts from what it reads.
      key={form.original?.monitor.id ?? ""}
      listContainers={list}
      monitor={undefined}
      onSaved={saved}
      options={form.options}
      original={form.original}
      save={save}
      test={test}
    />
  );
}

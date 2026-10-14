import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type ReactNode, useCallback, useMemo } from "react";
import { EmptyList } from "@/admin/monitors/empty-list.tsx";
import { GettingStartedCard } from "@/admin/monitors/getting-started.tsx";
import { type BulkCall, MonitorList } from "@/admin/monitors/list.tsx";
import { MonitorListSkeleton } from "@/admin/monitors/skeleton.tsx";
import { keyLabel } from "@/admin/shell/keyboard.ts";
import { Page } from "@/admin/shell/page.tsx";
import { useSavedToast } from "@/admin/shell/toasts.tsx";
import {
  acknowledgeOutageFn,
  changeMonitorsFn,
  deleteMonitorsFn,
  dismissGettingStartedFn,
  pauseMonitorsFn,
  readMonitorList,
  resumeMonitorsFn,
} from "@/routes/-monitors.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type MonitorBulkResult,
  type MonitorChange,
  type MonitorIdsInput,
  monitorListSearchSchema,
} from "@/shared/schemas/monitor.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { buttonVariants } from "@/shared/ui/button.tsx";
import { Kbd } from "@/shared/ui/kbd.tsx";
import { Token } from "@/shared/ui/token.tsx";

// The monitors list: the landing after onboarding. The
// search, the filters and the sort live in the URL; the loader answers every
// monitor once and the page arranges them, so typing never re-reads the
// database. The primary action is the add-monitor button with its N chip,
// pointing at the new-monitor form.
const newMonitorPath = "/admin/monitors/new";

export const Route = createFileRoute("/admin/monitors/")({
  component: MonitorsPage,
  pendingComponent: MonitorListSkeleton,
  loader: ({ abortController: { signal } }) => readMonitorList({ signal }),
  validateSearch: (search) => monitorListSearchSchema.parse(search),
});

function MonitorsPage() {
  const { locale, t } = useMessages();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const pauseFn = useServerFn(pauseMonitorsFn);
  const resumeFn = useServerFn(resumeMonitorsFn);
  const deleteFn = useServerFn(deleteMonitorsFn);
  const changeFn = useServerFn(changeMonitorsFn);
  const acknowledgeFn = useServerFn(acknowledgeOutageFn);
  const dismissFn = useServerFn(dismissGettingStartedFn);
  const toast = useSavedToast();
  const dismiss = useCallback(async () => {
    const result = await dismissFn();
    if (result?.ok) {
      await router.invalidate();
    }
    return result;
  }, [dismissFn, router]);
  // Through useServerFn, a redirect the session check throws navigates; every action then re-reads the loader.
  const act = useCallback(
    (call: (options: { data: MonitorIdsInput }) => ReturnType<BulkCall>) =>
      async (ids: readonly string[]) => {
        // When the session check redirects, useServerFn navigates and answers nothing (useServerFn.js in @tanstack/react-start); the page is leaving.
        const result: MonitorBulkResult | undefined = await call({
          data: { ids: [...ids] },
        });
        if (!result) {
          return { ok: false, reason: "unavailable" } as const;
        }
        if (result.ok) {
          await router.invalidate();
        }
        return result;
      },
    [router]
  );
  const actions = useMemo(
    () => ({
      acknowledge: async (id: string, startedAt: number) => {
        const result = await acknowledgeFn({ data: { id, startedAt } });
        // A refusal means the list is stale (acknowledged in another tab, or recovered), so it reads itself again too.
        if (result) {
          await router.invalidate();
        }
        // The menu that held the action has closed, so a toast says it went through.
        if (result?.ok) {
          toast(t("monitor_acknowledged_toast"));
        }
        return { ok: result?.ok === true };
      },
      change: (ids: readonly string[], change: MonitorChange) =>
        act((call) => changeFn({ data: { ...call.data, change } }))(ids),
      delete: act(deleteFn),
      pause: act(pauseFn),
      resume: act(resumeFn),
    }),
    [
      acknowledgeFn,
      act,
      changeFn,
      deleteFn,
      pauseFn,
      resumeFn,
      router,
      t,
      toast,
    ]
  );
  const setSearch = useCallback(
    (next: typeof search) => {
      router
        .navigate({ replace: true, search: next, to: "/admin/monitors" })
        .catch(() => undefined);
    },
    [router]
  );
  const add = (
    <Link
      aria-keyshortcuts="N"
      className={buttonVariants()}
      data-slot="new-monitor"
      to={newMonitorPath}
    >
      {t("monitor_add")}
      {/* The chip shows the key; the link's name stays its words. */}
      <Kbd aria-hidden="true" className="pointer-coarse:hidden">
        {keyLabel("KeyN", false, locale)}
      </Kbd>
    </Link>
  );
  const empty = data.ok && data.monitors.length === 0;
  let body: ReactNode;
  if (!data.ok) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>
          {data.reason === "corrupt" ? (
            <>
              {t("monitor_corrupt")} <Token>{data.id}</Token>
            </>
          ) : (
            t("monitor_unavailable")
          )}
        </AlertDescription>
      </Alert>
    );
  } else if (data.monitors.length === 0) {
    body = <EmptyList add={add} />;
  } else {
    body = (
      <MonitorList
        acknowledgeable={data.acknowledgeable}
        actions={actions}
        channels={data.channels}
        covered={data.covered}
        days={data.days}
        heard={data.heard}
        monitors={data.monitors}
        onSearch={setSearch}
        search={search}
        states={data.states}
      />
    );
  }
  return (
    // While the list is empty its card holds the one add button.
    <Page action={empty ? undefined : add} title={t("monitor_list_title")}>
      {data.ok && data.gettingStarted ? (
        <GettingStartedCard dismiss={dismiss} lines={data.gettingStarted} />
      ) : null}
      {body}
    </Page>
  );
}

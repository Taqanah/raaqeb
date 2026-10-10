import {
  createFileRoute,
  Link,
  notFound,
  useRouter,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { DetailRefused, MonitorDetailView } from "@/admin/monitors/detail.tsx";
import { MonitorDetailSkeleton } from "@/admin/monitors/skeleton.tsx";
import { Page } from "@/admin/shell/page.tsx";
import {
  acknowledgeOutageFn,
  checkNowFn,
  pauseMonitorsFn,
  readCheckRecordFn,
  readMonitorDetailFn,
  readOperatorClockFn,
  resumeMonitorsFn,
} from "@/routes/-monitors.ts";
import { askedCheckLanded, longestCheckMs } from "@/shared/domain/checks.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type ChartRange,
  type ChartSpan,
  monitorDetailSearchSchema,
} from "@/shared/schemas/detail.ts";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  BellOffIcon,
  CopyIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshIcon,
} from "@/shared/ui/icons.tsx";

// The monitor detail: the list's name links here, and a
// save of the form returns here. The chart's range is the search parameter
// `range`; an unknown id is the not-found page. The page reads itself again
// every half minute while visible, and every second while "check now" waits
// for its check, up to the longest a check with its retries can take.
export const Route = createFileRoute("/admin/monitors/$id/")({
  validateSearch: (search) => monitorDetailSearchSchema.parse(search),
  // TanStack infers each option from the ones before it: search, then deps, then the loader.
  loaderDeps: ({ search }) => ({
    from: search.from,
    range: search.range,
    to: search.to,
  }),
  loader: async ({ abortController: { signal }, deps, params }) => {
    const span =
      deps.from === undefined || deps.to === undefined
        ? undefined
        : { from: deps.from, to: deps.to };
    const [result, clock] = await Promise.all([
      readMonitorDetailFn({
        data: { id: params.id, range: deps.range ?? "24h", span },
        signal,
      }),
      readOperatorClockFn({ signal }),
    ]);
    if (!result.ok && result.reason === "not_found") {
      throw notFound();
    }
    return { clock, result };
  },
  component: MonitorDetailPage,
  pendingComponent: MonitorDetailSkeleton,
});

// A phone shows the secondary actions as icons, so the four fit one row; the label stays for screen readers.
const iconOnPhone = "max-sm:size-control max-sm:px-0";

/** How often the page reads itself again while it is visible. */
const refreshMs = 30_000;
/** How often the page looks for the check "check now" asked for. */
const waitStepMs = 1000;
/** How long the wait for "check now" outlasts the longest check, for the tick and the write. */
const waitMarginMs = 5000;

function MonitorDetailPage(): ReactNode {
  const { clock, result } = Route.useLoaderData();
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const { t } = useMessages();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const recordFn = useServerFn(readCheckRecordFn);
  const checkNow = useServerFn(checkNowFn);
  const pause = useServerFn(pauseMonitorsFn);
  const resume = useServerFn(resumeMonitorsFn);
  const acknowledgeFn = useServerFn(acknowledgeOutageFn);
  /** When the asked check starts, by the server's answer, and when the wait ends. */
  const [waiting, setWaiting] = useState<
    { readonly from: number; readonly until: number } | undefined
  >();
  const [refused, setRefused] = useState(false);
  const detail = result.ok ? result.detail : undefined;
  const latestAt = detail?.recent[0]?.startedAt;

  useEffect(() => {
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") {
          router.invalidate().catch(() => undefined);
        }
      },
      waiting ? waitStepMs : refreshMs
    );
    return () => clearInterval(timer);
  }, [router, waiting]);

  // The wait ends with the asked check, or at its deadline, whichever comes first.
  useEffect(() => {
    if (!waiting) {
      return;
    }
    if (askedCheckLanded(latestAt, waiting.from)) {
      setWaiting(undefined);
      return;
    }
    const timer = setTimeout(
      () => setWaiting(undefined),
      Math.max(0, waiting.until - Date.now())
    );
    return () => clearTimeout(timer);
  }, [latestAt, waiting]);

  const onRange = useCallback(
    (range: ChartRange) => {
      navigate({ replace: true, search: { range } }).catch(() => undefined);
    },
    [navigate]
  );
  // A zoom is a step the back button undoes, so it pushes; zooming out keeps the range.
  const onZoom = useCallback(
    (span: ChartSpan) => {
      navigate({
        search: (previous) => ({ ...previous, from: span.from, to: span.to }),
      }).catch(() => undefined);
    },
    [navigate]
  );
  const onZoomOut = useCallback(() => {
    navigate({ search: (previous) => ({ range: previous.range }) }).catch(
      () => undefined
    );
  }, [navigate]);
  const openRecord = useCallback(
    async (startedAt: number) =>
      (await recordFn({ data: { id, startedAt } })) ??
      ({ ok: false, reason: "unavailable" } as const),
    [id, recordFn]
  );
  const askCheck = useCallback(async () => {
    if (!detail) {
      return;
    }
    setRefused(false);
    const answer = await checkNow({ data: { id } });
    if (answer?.ok) {
      setWaiting({
        from: answer.from,
        until: Date.now() + longestCheckMs(detail.monitor) + waitMarginMs,
      });
    } else {
      setRefused(true);
    }
  }, [checkNow, detail, id]);
  const togglePaused = useCallback(async () => {
    if (!detail) {
      return;
    }
    const call = detail.monitor.paused ? resume : pause;
    const answer = await call({ data: { ids: [id] } });
    setRefused(!answer?.ok);
    if (answer?.ok) {
      await router.invalidate();
    }
  }, [detail, id, pause, resume, router]);

  // The outages are newest first, so an open one leads.
  const latestOutage = detail?.outages[0];
  const acknowledgeable =
    latestOutage !== undefined &&
    latestOutage.endedAt === undefined &&
    latestOutage.acknowledgedAt === undefined;
  const acknowledge = useCallback(async () => {
    if (!latestOutage) {
      return;
    }
    // The outage as the page showed it, so one opened since is never the one acknowledged.
    const answer = await acknowledgeFn({
      data: { id, startedAt: latestOutage.startedAt },
    });
    setRefused(!answer?.ok);
    // A refusal means the page is stale (acknowledged in another tab, or recovered), so it reads itself again too.
    if (answer) {
      await router.invalidate();
    }
  }, [acknowledgeFn, id, latestOutage, router]);

  if (!(result.ok && detail)) {
    return (
      <Page title={t("monitor_list_title")}>
        <DetailRefused
          refusal={
            result.ok || result.reason !== "corrupt"
              ? { reason: "unavailable" }
              : result
          }
        />
      </Page>
    );
  }
  const { monitor } = detail;
  const action = (
    <>
      {acknowledgeable ? (
        <Button
          className={iconOnPhone}
          data-slot="acknowledge-outage"
          onClick={acknowledge}
          type="button"
          variant="outline"
        >
          <BellOffIcon />
          <span className="max-sm:sr-only">{t("monitor_acknowledge")}</span>
        </Button>
      ) : null}
      {monitor.config.type === "heartbeat" ? null : (
        <Button
          className={iconOnPhone}
          data-slot="check-now"
          disabled={monitor.paused || waiting !== undefined}
          onClick={askCheck}
          type="button"
          variant="outline"
        >
          <RefreshIcon
            className={waiting ? "motion-safe:animate-spin" : undefined}
          />
          <span className="max-sm:sr-only">
            {waiting ? t("monitor_checking") : t("monitor_check_now")}
          </span>
        </Button>
      )}
      <Button
        className={iconOnPhone}
        data-slot="toggle-paused"
        onClick={togglePaused}
        type="button"
        variant="outline"
      >
        {monitor.paused ? <PlayIcon /> : <PauseIcon />}
        <span className="max-sm:sr-only">
          {monitor.paused ? t("monitor_resume") : t("monitor_pause")}
        </span>
      </Button>
      <Link
        className={cn(buttonVariants({ variant: "outline" }), iconOnPhone)}
        data-slot="duplicate-monitor"
        search={{ copy: id }}
        to="/admin/monitors/new"
      >
        <CopyIcon />
        <span className="max-sm:sr-only">{t("monitor_duplicate")}</span>
      </Link>
      <Link
        className={buttonVariants()}
        data-slot="edit-monitor"
        params={{ id }}
        to="/admin/monitors/$id/edit"
      >
        <PencilIcon />
        {t("monitor_edit")}
      </Link>
    </>
  );
  return (
    <Page
      action={action}
      parent={{ label: t("monitor_list_title"), to: "/admin/monitors" }}
      title={monitor.name}
    >
      {refused ? <DetailRefused refusal={{ reason: "action" }} /> : null}
      <MonitorDetailView
        clock={clock}
        detail={detail}
        onRange={onRange}
        onZoom={onZoom}
        onZoomOut={onZoomOut}
        openRecord={openRecord}
        zoom={
          search.from === undefined || search.to === undefined
            ? undefined
            : { from: search.from, to: search.to }
        }
      />
    </Page>
  );
}

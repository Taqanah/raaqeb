/**
 * The monitor detail (direction B): the monitor's state,
 * target and schedule, its uptime over four windows with the exact downtime
 * and observed time on hover, its day bar whose day card lists the
 * day's outages and zooms the chart to the day, one large response-time
 * chart (a heartbeat monitor shows its URL instead), the recent checks
 * with the failure detail and capture a down check kept, the outages with
 * "detected at", and the certificate record. Every time is in the operator's time zone, relative
 * to the moment the server read the page, so hydration sees the same text.
 */
import { type ReactNode, useCallback, useState } from "react";
import { certificateExpiresWithin } from "@/shared/domain/certificates.ts";
import { dayZoom, zoomedChart } from "@/shared/domain/chart.ts";
import {
  displayedUptime,
  type UptimeReading,
  type UptimeWindow,
} from "@/shared/domain/uptime.ts";
import {
  formatDateTimeWithZone,
  formatDuration,
  formatNumber,
  formatTimeSpan,
  formatUnit,
  formatUptime,
  formatWhen,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { CertificateRecord } from "@/shared/schemas/certificate.ts";
import { tlsExpiryDefaultDays } from "@/shared/schemas/certificate.ts";
import type { Check } from "@/shared/schemas/check.ts";
import {
  type ChartRange,
  type ChartSpan,
  type CheckRecordResult,
  chartRanges,
  type MonitorDay,
  type MonitorDetail,
} from "@/shared/schemas/detail.ts";
import type { CaptureMode, Monitor } from "@/shared/schemas/monitor.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import { reasonMessageId, reasonName } from "@/shared/schemas/reason.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { FolderIcon, TriangleAlertIcon, XIcon } from "@/shared/ui/icons.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import { Token } from "@/shared/ui/token.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/ui/tooltip.tsx";
import { UptimeBar } from "@/shared/ui/uptime-bar.tsx";
import {
  CapturedResponse,
  checkTypeLabels,
  FailureDetail,
  formatResponseTime,
  Pair,
  resultWords,
} from "./check-parts.tsx";
import { ResponseChart } from "./detail-chart.tsx";
import { HeartbeatPanel } from "./heartbeat-parts.tsx";
import { MaintenanceBadge, StateBadge, windowNotice } from "./monitor-item.tsx";

/** Each window's length in words, from Intl: `24 ساعة`, `7 days`. */
const windowUnits: Readonly<
  Record<UptimeWindow, readonly [number, "hour" | "day"]>
> = {
  "24h": [24, "hour"],
  "7d": [7, "day"],
  "30d": [30, "day"],
  "90d": [90, "day"],
};

function windowWords(locale: Locale, window: UptimeWindow): string {
  const [amount, unit] = windowUnits[window];
  return formatUnit(locale, amount, unit, "long");
}

export interface MonitorDetailViewProps {
  readonly clock: TimeOptions;
  readonly detail: MonitorDetail;
  readonly onRange: (range: ChartRange) => void;
  /** Zooms the chart into a selected span; without it the chart selects nothing. */
  readonly onZoom?: (span: ChartSpan) => void;
  readonly onZoomOut?: () => void;
  readonly openRecord: (startedAt: number) => Promise<CheckRecordResult>;
  /** The span the address asks the chart to zoom into, if any. */
  readonly zoom?: ChartSpan;
}

export function MonitorDetailView({
  clock,
  detail,
  onRange,
  onZoom,
  onZoomOut,
  openRecord,
  zoom,
}: MonitorDetailViewProps): ReactNode {
  const { locale, t } = useMessages();
  const { monitor } = detail;
  // The address's span counts only where the read zoomed into it; a span too narrow or too old reads the range.
  const zoomed =
    zoom && detail.chart && zoomedChart(zoom, detail.now) ? zoom : undefined;
  const download = new URLSearchParams({ range: detail.chart?.range ?? "24h" });
  if (zoomed) {
    download.set("from", String(zoomed.from));
    download.set("to", String(zoomed.to));
  }
  return (
    <div className="flex flex-col gap-6" data-monitor={monitor.id}>
      <Summary clock={clock} detail={detail} />
      <UptimeTiles readings={detail.uptime} />
      <MonitorDays
        clock={clock}
        detail={detail}
        onZoom={detail.chart ? onZoom : undefined}
      />
      {detail.chart ? (
        <Card data-slot="chart-card">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle>{t("monitor_response_time")}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {zoomed ? (
                <Button
                  aria-label={t("monitor_chart_zoom_out")}
                  // A span's two dates outrun a phone's width, so the chip wraps.
                  className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-start tabular-nums"
                  data-slot="chart-zoom-out"
                  onClick={onZoomOut}
                  size="sm"
                  title={t("monitor_chart_zoom_out")}
                  type="button"
                  variant="secondary"
                >
                  {formatTimeSpan(locale, zoomed.from, zoomed.to, clock)}
                  <XIcon />
                </Button>
              ) : null}
              <RangeSwitch current={detail.chart.range} onRange={onRange} />
              <a
                className={buttonVariants({ variant: "outline" })}
                data-slot="history-download"
                download
                href={`/admin/monitors/${encodeURIComponent(monitor.id)}/history.jsonl.zst?${download}`}
              >
                {t("monitor_history_download")}
              </a>
            </div>
          </CardHeader>
          <CardContent>
            <ResponseChart
              clock={clock}
              degradedMs={monitor.degradedMs}
              onZoom={onZoom}
              onZoomOut={onZoomOut}
              series={detail.chart}
              zoomed={zoomed !== undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <HeartbeatPanel clock={clock} heartbeat={detail.heartbeat} />
      )}
      <RecentChecks clock={clock} detail={detail} openRecord={openRecord} />
      <OutageList clock={clock} detail={detail} />
      {detail.certificate ? (
        <CertificateCard
          clock={clock}
          monitor={monitor}
          now={detail.now}
          record={detail.certificate}
        />
      ) : null}
    </div>
  );
}

/** The monitor's day bar over the chart: the shared bar and its card, which lists the day's outages and zooms the chart to the day. */
function MonitorDays({
  clock,
  detail,
  onZoom,
}: {
  readonly clock: TimeOptions;
  readonly detail: MonitorDetail;
  /** Zooms the chart to a day; none without a chart. */
  readonly onZoom: ((span: ChartSpan) => void) | undefined;
}): ReactNode {
  const { t } = useMessages();
  const footer = useCallback(
    (day: MonitorDay, close: () => void) => {
      // Nothing to zoom to without a chart, or in the first minutes of today.
      const span = onZoom && dayZoom(Date.parse(day.date), detail.now);
      return span || day.outages.length > 0 ? (
        <DayFooter
          clock={clock}
          close={close}
          day={day}
          now={detail.now}
          onZoom={onZoom}
          span={span}
        />
      ) : null;
    },
    [clock, detail.now, onZoom]
  );
  return (
    <Card data-slot="monitor-days">
      <CardHeader>
        <CardTitle>{t("monitor_days_title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <UptimeBar
          calendar={clock.calendar}
          caption={false}
          days={detail.days}
          footer={footer}
          notice={windowNotice}
          percentages={false}
        />
      </CardContent>
    </Card>
  );
}

/** A day card's foot on the detail: the day's outages, then the button that zooms the chart to the day and closes the card. */
function DayFooter({
  clock,
  close,
  day,
  now,
  onZoom,
  span,
}: {
  readonly clock: TimeOptions;
  readonly close: () => void;
  readonly day: MonitorDay;
  readonly now: number;
  readonly onZoom: ((span: ChartSpan) => void) | undefined;
  /** The day's span on the chart; none hides the button. */
  readonly span: ChartSpan | undefined;
}): ReactNode {
  const { locale, t } = useMessages();
  const zoom = useCallback(() => {
    close();
    if (span) {
      onZoom?.(span);
    }
  }, [close, onZoom, span]);
  return (
    <div className="flex flex-col gap-2">
      {day.outages.length > 0 ? (
        <ul className="flex flex-col gap-1.5" data-slot="day-outages">
          {day.outages.map((outage) => (
            <li className="flex items-start gap-1.5" key={outage.startedAt}>
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-status-down" />
              <span className="flex flex-col">
                <span>
                  {formatTimeSpan(
                    locale,
                    outage.startedAt,
                    outage.endedAt ?? now,
                    clock
                  )}
                </span>
                <span className="text-muted-foreground">
                  {outage.endedAt === undefined
                    ? t("monitor_outage_ongoing", {
                        duration: formatDuration(
                          locale,
                          now - outage.startedAt
                        ),
                      })
                    : formatDuration(locale, outage.endedAt - outage.startedAt)}
                  {" · "}
                  {t(reasonMessageId(reasonName(outage.reason) ?? "unknown"))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {span ? (
        <Button
          className="self-start"
          data-slot="day-zoom"
          onClick={zoom}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("monitor_day_show_on_chart")}
        </Button>
      ) : null}
    </div>
  );
}

/** The state, the target, the check type, the schedule, the organization and the last check, in one row. */
function Summary({
  clock,
  detail,
}: {
  readonly clock: TimeOptions;
  readonly detail: MonitorDetail;
}): ReactNode {
  const { locale, t } = useMessages();
  const { monitor } = detail;
  const [latest] = detail.recent;
  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm"
      data-slot="monitor-summary"
    >
      <span className="flex items-center gap-1">
        <StateBadge
          heard={detail.heartbeat?.last !== undefined}
          monitor={monitor}
          state={detail.state}
        />
        {detail.covered && !monitor.paused ? <MaintenanceBadge /> : null}
      </span>
      {monitor.target ? (
        <Token className="break-all" data-slot="monitor-target">
          {monitor.target}
        </Token>
      ) : null}
      <Badge variant="outline">{t(checkTypeLabels[monitor.config.type])}</Badge>
      <span className="text-muted-foreground">
        <Schedule locale={locale} monitor={monitor} />
      </span>
      {monitor.group ? (
        <Badge variant="secondary">
          <FolderIcon />
          {monitor.group}
        </Badge>
      ) : null}
      {monitor.tags.map((tag) => (
        <Badge key={tag} variant="secondary">
          {tag}
        </Badge>
      ))}
      <span className="ms-auto text-muted-foreground" data-slot="last-check">
        {latest
          ? t("monitor_last_check", {
              when: formatWhen(locale, latest.startedAt, {
                ...clock,
                now: detail.now,
              }),
            })
          : t("monitor_no_checks")}
      </span>
    </div>
  );
}

function Schedule({
  locale,
  monitor,
}: {
  readonly locale: Locale;
  readonly monitor: Monitor;
}): ReactNode {
  const { t } = useMessages();
  const { config } = monitor;
  if (config.type !== "heartbeat") {
    return t("monitor_every", {
      interval: formatDuration(locale, monitor.intervalMs),
    });
  }
  return config.schedule.kind === "every" ? (
    t("monitor_every", {
      interval: formatDuration(locale, config.schedule.everyMs),
    })
  ) : (
    <Token>{config.schedule.expression}</Token>
  );
}

function UptimeTiles({
  readings,
}: {
  readonly readings: readonly UptimeReading[];
}): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
      {readings.map((reading) => (
        <UptimeTile key={reading.window} reading={reading} />
      ))}
    </div>
  );
}

function UptimeTile({
  reading,
}: {
  readonly reading: UptimeReading;
}): ReactNode {
  const { locale, t } = useMessages();
  const shown = displayedUptime(reading);
  return (
    <div
      className="flex flex-col gap-1 border-t pt-3"
      data-slot="uptime"
      data-window={reading.window}
    >
      <span className="text-muted-foreground text-xs">
        {t("monitor_uptime_window", {
          window: windowWords(locale, reading.window),
        })}
      </span>
      {shown ? (
        <Tooltip>
          <TooltipTrigger
            className="self-start font-semibold text-2xl tabular-nums"
            data-slot="uptime-value"
            render={<span />}
          >
            {formatUptime(locale, shown)}
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <UptimeHover reading={reading} />
          </TooltipContent>
        </Tooltip>
      ) : (
        <span
          className="font-semibold text-2xl text-muted-foreground"
          data-slot="uptime-value"
        >
          {t("monitor_no_data")}
        </span>
      )}
    </div>
  );
}

/** The exact downtime in seconds and the observed time. */
export function UptimeHover({
  reading,
}: {
  readonly reading: UptimeReading;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1 tabular-nums">
      <dt>{t("monitor_downtime")}</dt>
      <dd>{formatUnit(locale, reading.downtimeMs / 1000, "second")}</dd>
      <dt>{t("monitor_observed_time")}</dt>
      <dd>{formatDuration(locale, reading.observedMs)}</dd>
    </dl>
  );
}

const rangeWindows: Readonly<Record<ChartRange, UptimeWindow>> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
};

function RangeSwitch({
  current,
  onRange,
}: {
  readonly current: ChartRange;
  readonly onRange: (range: ChartRange) => void;
}): ReactNode {
  const { t } = useMessages();
  return (
    <fieldset
      aria-label={t("monitor_chart_range")}
      className="inline-flex gap-0.5 rounded-lg bg-subtle p-0.5"
    >
      {chartRanges.map((range) => (
        <RangeButton
          current={current}
          key={range}
          onRange={onRange}
          range={range}
        />
      ))}
    </fieldset>
  );
}

function RangeButton({
  current,
  onRange,
  range,
}: {
  readonly current: ChartRange;
  readonly onRange: (range: ChartRange) => void;
  readonly range: ChartRange;
}): ReactNode {
  const { locale } = useMessages();
  const choose = useCallback(() => onRange(range), [onRange, range]);
  return (
    <Button
      aria-pressed={range === current}
      className="aria-pressed:bg-segment aria-pressed:shadow-sm"
      data-range={range}
      onClick={choose}
      size="sm"
      type="button"
      variant="ghost"
    >
      {windowWords(locale, rangeWindows[range])}
    </Button>
  );
}

function RecentChecks({
  clock,
  detail,
  openRecord,
}: {
  readonly clock: TimeOptions;
  readonly detail: MonitorDetail;
  readonly openRecord: (startedAt: number) => Promise<CheckRecordResult>;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card data-slot="recent-checks">
      <CardHeader>
        <CardTitle>{t("monitor_recent_checks")}</CardTitle>
      </CardHeader>
      <CardContent>
        {detail.recent.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("monitor_no_checks")}
          </p>
        ) : (
          <Table stacked>
            <TableHeader>
              <TableRow>
                <TableHead>{t("monitor_check_time")}</TableHead>
                <TableHead>{t("monitor_check_result")}</TableHead>
                <TableHead>{t("monitor_check_reason")}</TableHead>
                <TableHead>{t("monitor_response_time")}</TableHead>
                <TableHead>{t("monitor_check_attempts")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.recent.map((check) => (
                <CheckRow
                  captureMode={
                    detail.monitor.config.type === "http"
                      ? detail.monitor.config.captureMode
                      : "off"
                  }
                  check={check}
                  clock={clock}
                  key={check.startedAt}
                  now={detail.now}
                  openRecord={openRecord}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

type RecordState =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "open"; readonly result: CheckRecordResult };

function CheckRow({
  captureMode,
  check,
  clock,
  now,
  openRecord,
}: {
  readonly captureMode: CaptureMode;
  readonly check: Check;
  readonly clock: TimeOptions;
  readonly now: number;
  readonly openRecord: (startedAt: number) => Promise<CheckRecordResult>;
}): ReactNode {
  const { locale, t } = useMessages();
  const [record, setRecord] = useState<RecordState>({ kind: "closed" });
  const toggle = useCallback(() => {
    if (record.kind === "open") {
      setRecord({ kind: "closed" });
      return;
    }
    setRecord({ kind: "loading" });
    openRecord(check.startedAt)
      .then((result) => setRecord({ kind: "open", result }))
      .catch(() =>
        setRecord({
          kind: "open",
          result: { ok: false, reason: "unavailable" },
        })
      );
  }, [check.startedAt, openRecord, record.kind]);
  const reason = reasonName(check.reason) ?? "unknown";
  // A down check kept its failure detail; under "always" every check kept its response.
  const opens = check.result === "down" || captureMode === "always";
  return (
    <>
      <TableRow data-check={check.startedAt} data-result={check.result}>
        <TableCell className="whitespace-nowrap tabular-nums">
          <time
            dateTime={new Date(check.startedAt).toISOString()}
            title={formatDateTimeWithZone(locale, check.startedAt, clock)}
          >
            {formatWhen(locale, check.startedAt, { ...clock, now })}
          </time>
        </TableCell>
        <TableCell>
          <Badge variant={check.result}>{t(resultWords[check.result])}</Badge>
        </TableCell>
        <TableCell>
          {t(reasonMessageId(reason))}
          {check.statusCode === undefined ? null : (
            <Token className="ms-2">{String(check.statusCode)}</Token>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">
          {check.responseMs === undefined
            ? null
            : formatResponseTime(locale, check.responseMs)}
        </TableCell>
        {/* A stacked row has no header, so a phone names the count. */}
        <TableCell className="tabular-nums">
          <span className="max-sm:hidden">
            {formatNumber(locale, check.attempts)}
          </span>
          <span className="sm:hidden">
            {t("monitor_check_attempts_count", { count: check.attempts })}
          </span>
        </TableCell>
        <TableCell className="w-0">
          {opens ? (
            <Button
              aria-expanded={record.kind === "open"}
              data-slot="check-details"
              disabled={record.kind === "loading"}
              onClick={toggle}
              size="sm"
              type="button"
              variant="ghost"
            >
              {record.kind === "open"
                ? t("monitor_check_close")
                : t("monitor_check_open")}
            </Button>
          ) : null}
        </TableCell>
      </TableRow>
      {record.kind === "open" ? (
        <TableRow data-slot="check-record">
          <TableCell className="whitespace-normal" colSpan={6}>
            <CheckRecordView result={record.result} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function CheckRecordView({
  result,
}: {
  readonly result: CheckRecordResult;
}): ReactNode {
  const { t } = useMessages();
  if (!result.ok) {
    return (
      <p className="text-destructive text-sm">
        {result.reason === "corrupt"
          ? t("monitor_check_corrupt")
          : t("monitor_detail_unavailable")}
      </p>
    );
  }
  const { capture, failure } = result.record;
  if (!(capture || failure)) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("monitor_check_nothing_kept")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 py-2">
      <FailureDetail failure={failure} />
      {capture ? <CapturedResponse response={capture} /> : null}
    </div>
  );
}

function OutageList({
  clock,
  detail,
}: {
  readonly clock: TimeOptions;
  readonly detail: MonitorDetail;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <Card data-slot="outages">
      <CardHeader>
        <CardTitle>{t("monitor_outages_title")}</CardTitle>
        <CardDescription data-slot="outages-count">
          {t("monitor_outages_count", { count: detail.outagesTotal })}
          {detail.outagesTotal > detail.outages.length
            ? ` ${t("monitor_outages_newest", { shown: formatNumber(locale, detail.outages.length) })}`
            : null}
        </CardDescription>
      </CardHeader>
      {detail.outages.length === 0 ? null : (
        <CardContent>
          <Table stacked>
            <TableHeader>
              <TableRow>
                <TableHead>{t("monitor_outage_detected")}</TableHead>
                <TableHead>{t("monitor_outage_duration")}</TableHead>
                <TableHead>{t("monitor_check_reason")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.outages.map((outage) => (
                <OutageRow
                  clock={clock}
                  key={outage.startedAt}
                  now={detail.now}
                  outage={outage}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}

/** "Detected at" and the span as the resolution: an outage starts at the first failed check and ends at the first good one. */
function OutageRow({
  clock,
  now,
  outage,
}: {
  readonly clock: TimeOptions;
  readonly now: number;
  readonly outage: Outage;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <TableRow
      data-ongoing={outage.endedAt === undefined}
      data-outage={outage.startedAt}
    >
      <TableCell className="whitespace-nowrap">
        {formatDateTimeWithZone(locale, outage.startedAt, clock)}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {outage.endedAt === undefined ? (
          <Badge variant="down">
            {t("monitor_outage_ongoing", {
              duration: formatDuration(locale, now - outage.startedAt),
            })}
          </Badge>
        ) : (
          <span title={formatDateTimeWithZone(locale, outage.endedAt, clock)}>
            {formatDuration(locale, outage.endedAt - outage.startedAt)}
          </span>
        )}
        {outage.acknowledgedAt === undefined ? null : (
          <time
            className="mt-1 block text-muted-foreground text-xs"
            data-slot="outage-acknowledged"
            dateTime={new Date(outage.acknowledgedAt).toISOString()}
            title={formatDateTimeWithZone(locale, outage.acknowledgedAt, clock)}
          >
            {t("monitor_outage_acknowledged", {
              when: formatWhen(locale, outage.acknowledgedAt, {
                ...clock,
                now,
              }),
            })}
          </time>
        )}
      </TableCell>
      <TableCell>
        {t(reasonMessageId(reasonName(outage.reason) ?? "unknown"))}
      </TableCell>
    </TableRow>
  );
}

function CertificateCard({
  clock,
  monitor,
  now,
  record,
}: {
  readonly clock: TimeOptions;
  readonly monitor: Monitor;
  readonly now: number;
  readonly record: CertificateRecord;
}): ReactNode {
  const { locale, t } = useMessages();
  const days =
    (monitor.config.type === "http"
      ? monitor.config.tlsExpiryDays
      : undefined) ?? tlsExpiryDefaultDays;
  let warning: ReactNode = null;
  if (record.validTo <= now) {
    warning = <Badge variant="down">{t("monitor_certificate_expired")}</Badge>;
  } else if (certificateExpiresWithin(record, days, now)) {
    warning = (
      <Badge variant="degraded">{t("monitor_certificate_expiring")}</Badge>
    );
  }
  return (
    <Card data-slot="certificate">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle>{t("monitor_certificate_title")}</CardTitle>
        {warning}
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          <Pair label={t("monitor_certificate_subject")}>
            <Token>{record.subject}</Token>
          </Pair>
          <Pair label={t("monitor_certificate_issuer")}>
            <Token>{record.issuer}</Token>
          </Pair>
          <Pair label={t("monitor_certificate_valid_from")}>
            {formatDateTimeWithZone(locale, record.validFrom, clock)}
          </Pair>
          <Pair label={t("monitor_certificate_valid_to")}>
            {formatDateTimeWithZone(locale, record.validTo, clock)}
          </Pair>
          <Pair label={t("monitor_certificate_names")}>
            <span className="flex flex-wrap gap-1">
              {record.names.map((name) => (
                <Token key={name}>{name}</Token>
              ))}
            </span>
          </Pair>
          <Pair label={t("monitor_certificate_fingerprint")}>
            <Token className="break-all">{record.fingerprint}</Token>
          </Pair>
          <Pair label={t("monitor_certificate_last_seen")}>
            {formatWhen(locale, record.lastSeenAt, { ...clock, now })}
          </Pair>
        </dl>
      </CardContent>
    </Card>
  );
}

/** The alert a refused read, or a refused action, shows. */
export function DetailRefused({
  refusal,
}: {
  readonly refusal:
    | { readonly reason: "unavailable" | "action" }
    | { readonly reason: "corrupt"; readonly id: string };
}): ReactNode {
  const { t } = useMessages();
  let text: ReactNode;
  switch (refusal.reason) {
    case "corrupt":
      text = (
        <>
          {t("monitor_detail_corrupt")} <Token>{refusal.id}</Token>
        </>
      );
      break;
    case "action":
      text = t("monitor_unavailable");
      break;
    default:
      text = t("monitor_detail_unavailable");
  }
  return (
    <Alert data-slot="detail-refused" variant="destructive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

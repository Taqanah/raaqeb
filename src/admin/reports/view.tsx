/**
 * A report on the page (CONTEXT.md "Report"): the uptime against the target
 * and the error budget first, then every figure the ticket names with what
 * it counts under it, the members of a group or a page, the longest outages
 * and how it was counted. Meant to print: the form and the buttons leave the
 * page, and the cards keep their edges on paper.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ContentText } from "@/admin/shell/content.tsx";
import { memberKind, reportKindMessage } from "@/shared/domain/report.ts";
import {
  formatDateTimeWithZone,
  formatDay,
  formatDuration,
  formatNumber,
  formatPercent,
  formatUnit,
  formatUptime,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { reasonMessageId, reasonName } from "@/shared/schemas/reason.ts";
import type {
  ErrorBudget,
  Report,
  ReportLine,
  ReportName,
  ReportOutage,
} from "@/shared/schemas/report.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";

const minuteMs = 60_000;

/** Minutes with their unit, to one decimal; the exact seconds are the title's. */
function minutes(locale: Locale, ms: number): string {
  return formatUnit(locale, ms / minuteMs, "minute");
}

/** A duration in minutes with its exact length on hover. */
function Minutes({ ms }: { readonly ms: number | undefined }): ReactNode {
  const { locale, t } = useMessages();
  if (ms === undefined) {
    return (
      <span className="text-muted-foreground">{t("report_mean_none")}</span>
    );
  }
  return (
    <span className="tabular-nums" title={formatDuration(locale, ms)}>
      {minutes(locale, ms)}
    </span>
  );
}

function NameText({ name }: { readonly name: ReportName }): ReactNode {
  return typeof name === "string" ? (
    <bdi>{name}</bdi>
  ) : (
    <ContentText content={name} />
  );
}

/** One labelled figure with what it counts under it. */
function Figure({
  children,
  hint,
  label,
  slot,
}: {
  readonly children: ReactNode;
  readonly hint?: string;
  readonly label: string;
  readonly slot: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-0.5" data-slot={slot}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium text-lg tabular-nums">{children}</dd>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function UptimeCard({ report }: { readonly report: Report }): ReactNode {
  const { locale, t } = useMessages();
  const { budget, uptime } = report.subject;
  return (
    <Card data-slot="report-uptime">
      <CardHeader>
        <CardTitle>{t("report_uptime")}</CardTitle>
        <CardDescription>
          {t("report_target_value", {
            target: formatUptime(locale, {
              decimals: String(report.target).split(".")[1]?.length ?? 0,
              percent: report.target,
            }),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        {uptime ? (
          <span
            className="font-semibold text-4xl tabular-nums"
            data-slot="report-uptime-value"
            dir="ltr"
          >
            {formatUptime(locale, uptime)}
          </span>
        ) : (
          <span
            className="text-muted-foreground"
            data-slot="report-uptime-none"
          >
            {t("report_uptime_none")}
          </span>
        )}
        {budget ? (
          <Badge
            data-met={budget.met}
            data-slot="report-met"
            variant={budget.met ? "up" : "down"}
          >
            {t(budget.met ? "report_met" : "report_missed")}
          </Badge>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The share of the budget used, as a bar that turns amber near the end and red past it. */
function BudgetBar({ budget }: { readonly budget: ErrorBudget }): ReactNode {
  const { t } = useMessages();
  const used = Math.min(1, budget.usedRatio);
  let colour = "bg-status-up";
  if (budget.usedRatio > 1) {
    colour = "bg-status-down";
  } else if (budget.usedRatio > 0.8) {
    colour = "bg-status-degraded";
  }
  return (
    <div
      aria-label={t("report_budget_used")}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(used * 100)}
      className="h-2 w-full overflow-hidden rounded-full bg-subtle"
      role="progressbar"
    >
      <div
        className={`h-full ${colour}`}
        style={{ inlineSize: `${used * 100}%` }}
      />
    </div>
  );
}

function BudgetCard({ report }: { readonly report: Report }): ReactNode {
  const { locale, t } = useMessages();
  const { budget, figures } = report.subject;
  return (
    <Card data-slot="report-budget">
      <CardHeader>
        <CardTitle>{t("report_budget")}</CardTitle>
        <CardDescription>{t("report_budget_description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {budget ? (
          <>
            <BudgetBar budget={budget} />
            <dl className="grid grid-cols-3 gap-4">
              <Figure label={t("report_budget_allowed")} slot="budget-allowed">
                <Minutes ms={budget.allowedMs} />
              </Figure>
              <Figure
                hint={formatPercent(locale, budget.usedRatio)}
                label={t("report_budget_used")}
                slot="budget-used"
              >
                <Minutes ms={figures.downtimeMs} />
              </Figure>
              <Figure
                label={t(
                  budget.leftMs < 0
                    ? "report_budget_over"
                    : "report_budget_left"
                )}
                slot="budget-left"
              >
                <Minutes ms={Math.abs(budget.leftMs)} />
              </Figure>
            </dl>
          </>
        ) : (
          <p className="text-muted-foreground" data-slot="report-budget-none">
            {t("report_budget_none")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function FiguresCard({ report }: { readonly report: Report }): ReactNode {
  const { locale, t } = useMessages();
  const { figures } = report.subject;
  return (
    <Card data-slot="report-figures">
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <Figure label={t("report_downtime")} slot="figure-downtime">
            <Minutes ms={figures.downtimeMs} />
          </Figure>
          <Figure
            hint={t("report_observed_hint")}
            label={t("report_observed")}
            slot="figure-observed"
          >
            <Minutes ms={figures.observedMs} />
          </Figure>
          <Figure
            hint={t("report_maintenance_hint")}
            label={t("report_maintenance")}
            slot="figure-maintenance"
          >
            <Minutes ms={figures.maintenanceMs} />
          </Figure>
          <Figure
            hint={t("report_no_data_hint")}
            label={t("report_no_data")}
            slot="figure-no-data"
          >
            <Minutes ms={figures.noDataMs} />
          </Figure>
          <Figure
            hint={t("report_degraded_hint")}
            label={t("report_degraded")}
            slot="figure-degraded"
          >
            <Minutes ms={figures.degradedMs} />
          </Figure>
          <Figure label={t("report_outages")} slot="figure-outages">
            {formatNumber(locale, figures.outages)}
          </Figure>
          <Figure label={t("report_incidents")} slot="figure-incidents">
            {formatNumber(locale, figures.incidents)}
          </Figure>
          <Figure
            hint={t("report_recovery_hint")}
            label={t("report_recovery")}
            slot="figure-recovery"
          >
            <Minutes ms={figures.recoveryMs} />
          </Figure>
          <Figure
            hint={t("report_acknowledge_hint")}
            label={t("report_acknowledge")}
            slot="figure-acknowledge"
          >
            <Minutes ms={figures.acknowledgeMs} />
          </Figure>
        </dl>
      </CardContent>
    </Card>
  );
}

/** A member's name, linked to its page. */
function MemberName({
  kind,
  line,
}: {
  readonly kind: "component" | "monitor";
  readonly line: ReportLine;
}): ReactNode {
  return kind === "monitor" ? (
    <Link
      className="underline-offset-4 hover:underline"
      params={{ id: line.id }}
      to="/admin/monitors/$id"
    >
      <NameText name={line.name} />
    </Link>
  ) : (
    <Link
      className="underline-offset-4 hover:underline"
      params={{ id: line.id }}
      to="/admin/components/$id"
    >
      <NameText name={line.name} />
    </Link>
  );
}

function MembersCard({ report }: { readonly report: Report }): ReactNode {
  const { locale, t } = useMessages();
  const kind = memberKind(report.subject.kind);
  if (report.members.length === 0) {
    return null;
  }
  return (
    <Card data-slot="report-members">
      <CardHeader>
        <CardTitle>{t("report_members_title")}</CardTitle>
        <CardDescription>
          {t(
            report.subject.kind === "page"
              ? "report_members_page"
              : "report_members_group"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table stacked>
          <TableHeader>
            <TableRow>
              <TableHead>{t(reportKindMessage[kind])}</TableHead>
              <TableHead>{t("report_uptime")}</TableHead>
              <TableHead>{t("report_column_target_status")}</TableHead>
              <TableHead>{t("report_downtime")}</TableHead>
              <TableHead>{t("report_observed")}</TableHead>
              <TableHead>{t("report_outages")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.members.map((line) => (
              <TableRow data-member={line.id} key={line.id}>
                <TableCell>
                  <MemberName
                    kind={kind === "component" ? "component" : "monitor"}
                    line={line}
                  />
                </TableCell>
                <TableCell className="tabular-nums" label={t("report_uptime")}>
                  {line.uptime ? (
                    <bdi dir="ltr">{formatUptime(locale, line.uptime)}</bdi>
                  ) : (
                    <span className="text-muted-foreground">
                      {t("report_uptime_none")}
                    </span>
                  )}
                </TableCell>
                <TableCell label={t("report_column_target_status")}>
                  {line.budget ? (
                    <Badge variant={line.budget.met ? "up" : "down"}>
                      {t(line.budget.met ? "report_met" : "report_missed")}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell label={t("report_downtime")}>
                  <Minutes ms={line.figures.downtimeMs} />
                </TableCell>
                <TableCell label={t("report_observed")}>
                  <Minutes ms={line.figures.observedMs} />
                </TableCell>
                <TableCell className="tabular-nums" label={t("report_outages")}>
                  {formatNumber(locale, line.figures.outages)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OutageRow({
  clock,
  outage,
}: {
  readonly clock: TimeOptions;
  readonly outage: ReportOutage;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <TableRow data-outage={outage.startedAt}>
      <TableCell>
        <Link
          className="underline-offset-4 hover:underline"
          params={{ id: outage.monitorId }}
          to="/admin/monitors/$id"
        >
          <bdi>{outage.monitorName}</bdi>
        </Link>
      </TableCell>
      <TableCell
        className="sm:whitespace-nowrap"
        label={t("monitor_outage_detected")}
      >
        {formatDateTimeWithZone(locale, outage.startedAt, clock)}
      </TableCell>
      <TableCell
        className="sm:whitespace-nowrap"
        label={t("report_outage_ended")}
      >
        {outage.endedAt === undefined ? (
          <Badge variant="down">{t("report_outage_open")}</Badge>
        ) : (
          formatDateTimeWithZone(locale, outage.endedAt, clock)
        )}
      </TableCell>
      <TableCell label={t("report_downtime")}>
        <Minutes ms={outage.downtimeMs} />
      </TableCell>
      <TableCell label={t("monitor_check_reason")}>
        {t(
          reasonMessageId(
            reasonName(outage.reason) ?? "unknown",
            outage.checkType
          )
        )}
      </TableCell>
      <TableCell
        className="sm:whitespace-nowrap"
        label={t("report_outage_acknowledged")}
      >
        {outage.acknowledgedAt === undefined
          ? null
          : formatDateTimeWithZone(locale, outage.acknowledgedAt, clock)}
      </TableCell>
    </TableRow>
  );
}

function WorstCard({
  clock,
  report,
}: {
  readonly clock: TimeOptions;
  readonly report: Report;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card data-slot="report-worst">
      <CardHeader>
        <CardTitle>{t("report_worst_title")}</CardTitle>
        <CardDescription>{t("report_worst_description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {report.worst.length === 0 ? (
          <p className="text-muted-foreground" data-slot="report-worst-empty">
            {t("report_worst_empty")}
          </p>
        ) : (
          <Table stacked>
            <TableHeader>
              <TableRow>
                <TableHead>{t("report_kind_monitor")}</TableHead>
                <TableHead>{t("monitor_outage_detected")}</TableHead>
                <TableHead>{t("report_outage_ended")}</TableHead>
                <TableHead>{t("report_downtime")}</TableHead>
                <TableHead>{t("monitor_check_reason")}</TableHead>
                <TableHead>{t("report_outage_acknowledged")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.worst.map((outage) => (
                <OutageRow
                  clock={clock}
                  key={`${outage.monitorId}@${outage.startedAt}`}
                  outage={outage}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export interface ReportViewProps {
  readonly clock: TimeOptions;
  readonly report: Report;
}

export function ReportView({ clock, report }: ReportViewProps): ReactNode {
  const { locale, t } = useMessages();
  const day = (text: string) =>
    formatDay(locale, Date.parse(`${text}T00:00:00Z`), clock.calendar);
  return (
    <section
      className="flex flex-col gap-6"
      data-open={report.open}
      data-slot="report"
    >
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          {t(reportKindMessage[report.subject.kind])}
        </p>
        <h2 className="font-semibold text-xl" data-slot="report-subject">
          <NameText name={report.subject.name} />
        </h2>
        <p className="text-muted-foreground text-sm" data-slot="report-range">
          {t("report_range", {
            from: day(report.from),
            to: day(report.to),
          })}
          {" · "}
          {t("report_made", {
            when: formatDateTimeWithZone(locale, report.madeAt, clock),
          })}
        </p>
      </header>
      {report.open ? (
        <Alert data-slot="report-open" variant="warning">
          <AlertDescription>{t("report_open")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 md:grid-cols-2">
        <UptimeCard report={report} />
        <BudgetCard report={report} />
      </div>
      <FiguresCard report={report} />
      <MembersCard report={report} />
      <WorstCard clock={clock} report={report} />
      <Card data-slot="report-notes" size="sm">
        <CardHeader>
          <CardTitle>{t("report_notes_title")}</CardTitle>
          <CardDescription>{t("report_notes")}</CardDescription>
        </CardHeader>
      </Card>
    </section>
  );
}

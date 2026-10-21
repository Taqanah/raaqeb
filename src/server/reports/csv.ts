/**
 * A report as CSV (CONTEXT.md "Report"): UTF-8 with a byte order mark so a
 * spreadsheet reads Arabic, CRLF lines, quotes doubled. Durations are
 * minutes and times are ISO 8601 in UTC, whatever the operator's calendar
 * and zone: a file is read by programs too. The titles are in the language
 * asked for, handed in as words. Pure.
 */
import { memberKind, reportKindMessage } from "@/shared/domain/report.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { reasonMessageId, reasonName } from "@/shared/schemas/reason.ts";
import type {
  Report,
  ReportLine,
  ReportName,
  ReportOutage,
  ReportSubjectKind,
} from "@/shared/schemas/report.ts";

/** The words a file is written in: a message, and a name as the reader reads it. */
export interface CsvWords {
  readonly name: (name: ReportName) => string;
  readonly text: (id: MessageId) => string;
}

const byteOrderMark = "\uFEFF";
const lineEnd = "\r\n";
const minuteMs = 60_000;
/** What a spreadsheet reads as a formula when a cell starts with it. */
const formulaStart = /^[=+\-@\t\r]/;
const needsQuotes = /[",\r\n]/;

/** A text cell: quoted when it holds a comma, a quote or a line break, and made harmless to a spreadsheet when it would read as a formula. */
function textCell(text: string): string {
  const safe = formulaStart.test(text) ? `'${text}` : text;
  return needsQuotes.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Minutes to three decimals, no grouping, none for no value. */
function minutes(ms: number | undefined): string {
  return ms === undefined
    ? ""
    : String(Math.round((ms / minuteMs) * 1000) / 1000);
}

/** A percentage with exactly its decimals. */
function percent(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

const iso = (ms: number) => new Date(ms).toISOString();

function lineCells(
  words: CsvWords,
  report: Report,
  kind: ReportSubjectKind,
  line: ReportLine
): string[] {
  const { budget, figures, uptime } = line;
  return [
    textCell(words.text(reportKindMessage[kind])),
    textCell(words.name(line.name)),
    report.from,
    report.to,
    String(report.target),
    uptime ? percent(uptime.percent, uptime.decimals) : "",
    budget ? words.text(budget.met ? "report_met" : "report_missed") : "",
    minutes(figures.downtimeMs),
    minutes(figures.observedMs),
    minutes(figures.maintenanceMs),
    minutes(figures.noDataMs),
    minutes(figures.degradedMs),
    budget ? minutes(budget.allowedMs) : "",
    budget ? minutes(budget.leftMs) : "",
    budget ? percent(budget.usedRatio * 100, 1) : "",
    String(figures.outages),
    String(figures.incidents),
    minutes(figures.recoveryMs),
    minutes(figures.acknowledgeMs),
  ];
}

function outageCells(words: CsvWords, outage: ReportOutage): string[] {
  return [
    textCell(outage.monitorName),
    iso(outage.startedAt),
    outage.endedAt === undefined ? "" : iso(outage.endedAt),
    minutes(outage.downtimeMs),
    textCell(words.text(reasonId(outage))),
    outage.acknowledgedAt === undefined ? "" : iso(outage.acknowledgedAt),
  ];
}

/** The message id of an outage's reason. */
function reasonId(outage: ReportOutage): MessageId {
  return reasonMessageId(reasonName(outage.reason) ?? "unknown");
}

/** The file: the subject's line and its members', then a blank line and the worst outages. */
export function reportCsv(report: Report, words: CsvWords): string {
  const { text } = words;
  const minutesTitle = (id: MessageId) =>
    textCell(`${text(id)} (${text("report_unit_minutes")})`);
  const lines = [
    [
      textCell(text("report_column_kind")),
      textCell(text("report_column_name")),
      textCell(text("report_from")),
      textCell(text("report_to")),
      textCell(`${text("report_target_label")} (%)`),
      textCell(`${text("report_uptime")} (%)`),
      textCell(text("report_column_target_status")),
      minutesTitle("report_downtime"),
      minutesTitle("report_observed"),
      minutesTitle("report_maintenance"),
      minutesTitle("report_no_data"),
      minutesTitle("report_degraded"),
      minutesTitle("report_budget_allowed"),
      minutesTitle("report_budget_left"),
      textCell(`${text("report_budget_used")} (%)`),
      textCell(text("report_outages")),
      textCell(text("report_incidents")),
      minutesTitle("report_recovery"),
      minutesTitle("report_acknowledge"),
    ],
    lineCells(words, report, report.subject.kind, report.subject),
    ...report.members.map((member) =>
      lineCells(words, report, memberKind(report.subject.kind), member)
    ),
  ];
  const worst =
    report.worst.length === 0
      ? []
      : [
          [],
          [
            textCell(text("report_column_name")),
            textCell(text("monitor_outage_detected")),
            textCell(text("report_outage_ended")),
            minutesTitle("report_downtime"),
            textCell(text("monitor_check_reason")),
            textCell(text("report_outage_acknowledged")),
          ],
          ...report.worst.map((outage) => outageCells(words, outage)),
        ];
  return (
    byteOrderMark +
    [...lines, ...worst].map((cells) => cells.join(",")).join(lineEnd) +
    lineEnd
  );
}

/** The file's name: what the report is about and its days, which are plain characters whatever the subject is called. */
export function reportFileName(report: Report): string {
  return `raaqeb-report-${report.subject.kind}-${report.from}-${report.to}.csv`;
}

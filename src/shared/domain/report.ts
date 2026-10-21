/**
 * The ranges and the error budget of a report (CONTEXT.md "Report",
 * "Uptime target", "Error budget"). A range is whole UTC days, written as
 * `yyyy-mm-dd` with the last day inclusive, whatever calendar the operator
 * reads dates in. Pure: `now` is a parameter.
 */
import type { MessageId } from "@/shared/i18n/messages.ts";
import {
  type ErrorBudget,
  type ReportSubjectKind,
  reportMaxDays,
} from "@/shared/schemas/report.ts";

/** The words that name what a report is about, and what a member of it is. */
export const reportKindMessage = {
  component: "report_kind_component",
  group: "report_kind_group",
  monitor: "report_kind_monitor",
  page: "report_kind_page",
} as const satisfies Record<ReportSubjectKind, MessageId>;

/** What the members of a report on this kind are: a group's are monitors, a page's are components. */
export function memberKind(kind: ReportSubjectKind): ReportSubjectKind {
  return kind === "page" ? "component" : "monitor";
}

/** A report's range as the server reads it. */
export interface ReportPeriod {
  /** The first day, `yyyy-mm-dd`. */
  readonly from: string;
  /** The range's start, UTC milliseconds. */
  readonly fromMs: number;
  /** Whether the range reaches today. */
  readonly open: boolean;
  /** The last day, `yyyy-mm-dd`, inclusive; today when the range asked for a day after it. */
  readonly to: string;
  /** The range's end, exclusive: the day after the last, or `now` while the range is open. */
  readonly toMs: number;
}

const dayMs = 86_400_000;

/** A `yyyy-mm-dd` text's UTC midnight, or nothing for text that is not a day of the calendar (30 February is not rolled into March). */
function dayStart(text: string): number | undefined {
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text
    ? undefined
    : ms;
}

/** The range of `from` to `to`, both inclusive; nothing for a date that is not a day, a last day before the first, a first day after today, or more than a year of days. */
export function reportPeriod(
  from: string,
  to: string,
  now: number
): ReportPeriod | undefined {
  const fromMs = dayStart(from);
  const lastMs = dayStart(to);
  if (
    fromMs === undefined ||
    lastMs === undefined ||
    lastMs < fromMs ||
    fromMs > now ||
    (lastMs - fromMs) / dayMs + 1 > reportMaxDays
  ) {
    return;
  }
  const end = lastMs + dayMs;
  // The figures stop at now, so a last day after today is printed as today.
  const today = Math.floor(now / dayMs) * dayMs;
  return {
    from,
    fromMs,
    open: end > now,
    to: lastMs > today ? isoDay(today) : to,
    toMs: Math.min(end, now),
  };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The first and last day of the `months` months from the one at `month` (counted from 1). */
function monthsFrom(year: number, month: number, months: number) {
  return {
    from: isoDay(Date.UTC(year, month - 1, 1)),
    to: isoDay(Date.UTC(year, month - 1 + months, 0)),
  };
}

/** The first and last day of a Gregorian month, `month` counted from 1. */
export function monthDates(
  year: number,
  month: number
): { readonly from: string; readonly to: string } {
  return monthsFrom(year, month, 1);
}

/** The first and last day of a Gregorian quarter, `quarter` counted from 1. */
export function quarterDates(
  year: number,
  quarter: number
): { readonly from: string; readonly to: string } {
  return monthsFrom(year, (quarter - 1) * 3 + 1, 3);
}

/** Whether a range is exactly one month, one quarter or neither. */
export function rangeKind(
  from: string,
  to: string
): "custom" | "month" | "quarter" {
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7));
  const asMonth = monthsFrom(year, month, 1);
  if (asMonth.from === from && asMonth.to === to) {
    return "month";
  }
  // A quarter starts in January, April, July or October.
  const asQuarter = monthsFrom(year, month, 3);
  return month % 3 === 1 && asQuarter.from === from && asQuarter.to === to
    ? "quarter"
    : "custom";
}

/** What an uptime target allows over the observed time, or nothing with no observed time. */
export function errorBudget(
  reading: { readonly downtimeMs: number; readonly observedMs: number },
  target: number
): ErrorBudget | undefined {
  const { downtimeMs, observedMs } = reading;
  if (observedMs <= 0) {
    return;
  }
  // Integer arithmetic: a quarter of 200 monitors times 10^5 is past what a double holds exactly. The target has at most three decimals, so a thousandth of a percent is the unit.
  const unit = 100_000n;
  const down = BigInt(downtimeMs);
  const observed = BigInt(observedMs);
  const share = unit - BigInt(Math.round(target * 1000));
  const allowed = (observed * share) / unit;
  return {
    allowedMs: Number(allowed),
    leftMs: Number(allowed - down),
    met: down * unit <= observed * share,
    usedRatio: (downtimeMs * 100_000) / (observedMs * Number(share)),
  };
}

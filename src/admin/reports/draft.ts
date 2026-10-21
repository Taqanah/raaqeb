/**
 * What the report form holds (CONTEXT.md "Report"): the subject, how the
 * period is picked and its parts as typed, the target as typed. A month or a
 * quarter is Gregorian, and the form shows its dates in the operator's
 * calendar; a custom range is typed in it, as `yyyy-mm-dd` whatever it
 * shows. Pure: `now` is a parameter.
 */
import { monthDates, quarterDates, rangeKind } from "@/shared/domain/report.ts";
import {
  defaultUptimeTarget,
  type ReportSearch,
  type ReportSubjectKind,
  targetDecimals,
  uptimeTargetMax,
  uptimeTargetMin,
} from "@/shared/schemas/report.ts";

export type PeriodKind = "custom" | "month" | "quarter";

export interface ReportDraft {
  /** The first day of a custom range, `yyyy-mm-dd`. */
  readonly from: string;
  /** The group's name, or the id of the monitor, component or status page; empty until chosen. */
  readonly id: string;
  readonly kind: ReportSubjectKind;
  /** `yyyy-mm`. */
  readonly month: string;
  readonly period: PeriodKind;
  /** `yyyy-q`, the quarter counted from 1. */
  readonly quarter: string;
  /** The uptime target as typed. */
  readonly target: string;
  /** The last day of a custom range, `yyyy-mm-dd`. */
  readonly to: string;
}

/** How many months and quarters back the form lists. */
export const monthsListed = 24;
export const quartersListed = 8;

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** The months the form lists, `yyyy-mm`, the one of `now` first, with `selected` kept when it is older. */
export function monthChoices(now: number, selected?: string): string[] {
  const at = new Date(now);
  const months = Array.from({ length: monthsListed }, (_, back) => {
    const month = new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - back, 1)
    );
    return `${month.getUTCFullYear()}-${twoDigits(month.getUTCMonth() + 1)}`;
  });
  return selected === undefined || months.includes(selected)
    ? months
    : [...months, selected];
}

/** The quarters the form lists, `yyyy-q`, the one of `now` first, with `selected` kept when it is older. */
export function quarterChoices(now: number, selected?: string): string[] {
  const at = new Date(now);
  const current = at.getUTCFullYear() * 4 + Math.floor(at.getUTCMonth() / 3);
  const quarters = Array.from({ length: quartersListed }, (_, back) => {
    const index = current - back;
    return `${Math.floor(index / 4)}-${(index % 4) + 1}`;
  });
  return selected === undefined || quarters.includes(selected)
    ? quarters
    : [...quarters, selected];
}

/** The year and the number of a `yyyy-mm` or `yyyy-q` choice. */
function partsOf(choice: string): [number, number] {
  const [year = 0, number = 1] = choice.split("-").map(Number);
  return [year, number];
}

/** The form as the address asks for it, or, with nothing asked, the last whole month against the default target. */
export function draftOf(search: ReportSearch, now: number): ReportDraft {
  const [lastMonth = ""] = monthChoices(now).slice(1);
  const [lastQuarter = ""] = quarterChoices(now).slice(1);
  const asked =
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : undefined;
  const kind = asked ? rangeKind(asked.from, asked.to) : "month";
  const [year, number] = asked
    ? partsOf(asked.from.slice(0, 7))
    : partsOf(lastMonth);
  const month = asked && kind === "month" ? asked.from.slice(0, 7) : lastMonth;
  const quarter =
    asked && kind === "quarter"
      ? `${year}-${Math.floor((number - 1) / 3) + 1}`
      : lastQuarter;
  const dates = asked ?? monthDates(...partsOf(lastMonth));
  return {
    from: dates.from,
    id: search.id ?? "",
    kind: search.subject ?? "monitor",
    month,
    period: kind,
    quarter,
    target: String(search.target ?? defaultUptimeTarget),
    to: dates.to,
  };
}

/** The first and last day the draft's period names. */
export function datesOf(draft: ReportDraft): {
  readonly from: string;
  readonly to: string;
} {
  if (draft.period === "month") {
    return monthDates(...partsOf(draft.month));
  }
  if (draft.period === "quarter") {
    return quarterDates(...partsOf(draft.quarter));
  }
  return { from: draft.from, to: draft.to };
}

/** The address that asks for the draft's report, or nothing while a part is missing or not a number. */
export function searchOf(draft: ReportDraft): ReportSearch | undefined {
  const typed = Number(draft.target);
  // Cut to its places; the product is rounded first so 99.95 is not read as 99.949999.
  const scale = 10 ** targetDecimals;
  const target = Math.floor(Number((typed * scale).toFixed(4))) / scale;
  if (
    draft.id === "" ||
    draft.target.trim() === "" ||
    !Number.isFinite(typed) ||
    target < uptimeTargetMin ||
    target > uptimeTargetMax
  ) {
    return;
  }
  return { ...datesOf(draft), id: draft.id, subject: draft.kind, target };
}

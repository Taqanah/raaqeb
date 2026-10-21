/**
 * The report form (CONTEXT.md "Report"): what to report on, the period and
 * the uptime target. A plain GET form to the page's own address, so it works
 * as typed; with the script running it asks the router instead. A month and
 * a quarter are listed by their Gregorian names and their dates are written
 * under them in the operator's calendar; a custom range is typed in it.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { TimeField } from "@/admin/maintenance/time-field.tsx";
import { useContentIn } from "@/admin/shell/content.tsx";
import { FormFooter } from "@/admin/shell/page.tsx";
import { reportKindMessage } from "@/shared/domain/report.ts";
import {
  formatDay,
  formatMonth,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type ReportChoices,
  type ReportSearch,
  type ReportSubjectKind,
  reportSubjectKinds,
  uptimeTargetMax,
  uptimeTargetMin,
} from "@/shared/schemas/report.ts";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import {
  datesOf,
  draftOf,
  monthChoices,
  type PeriodKind,
  quarterChoices,
  type ReportDraft,
  searchOf,
} from "./draft.ts";

const periodKinds: readonly PeriodKind[] = ["month", "quarter", "custom"];
const periodMessage = {
  custom: "report_period_custom",
  month: "report_period_month",
  quarter: "report_period_quarter",
} as const;

export interface ReportFormProps {
  readonly choices: ReportChoices;
  /** The operator's calendar, clock and zone. */
  readonly clock: TimeOptions;
  /** The server's read time: the months listed end at its month. */
  readonly now: number;
  readonly onSubmit: (search: ReportSearch) => void;
  /** What the address asks for now. */
  readonly search: ReportSearch;
}

interface Option {
  readonly label: string;
  readonly value: string;
}

export function ReportForm({
  choices,
  clock,
  now,
  onSubmit,
  search,
}: ReportFormProps): ReactNode {
  const { locale, t } = useMessages();
  const contentIn = useContentIn();
  const collator = useMemo(() => new Intl.Collator(locale), [locale]);
  const options = useMemo((): Readonly<
    Record<ReportSubjectKind, readonly Option[]>
  > => {
    const sorted = (list: Option[]) =>
      list.toSorted((a, b) => collator.compare(a.label, b.label));
    return {
      component: sorted(
        choices.components.map((each) => ({
          label: contentIn(each.name),
          value: each.id,
        }))
      ),
      group: sorted(
        choices.groups.map((name) => ({ label: name, value: name }))
      ),
      monitor: sorted(
        choices.monitors.map((each) => ({ label: each.name, value: each.id }))
      ),
      page: sorted(
        choices.pages.map((each) => ({
          label: contentIn(each.name),
          value: each.id,
        }))
      ),
    };
  }, [choices, collator, contentIn]);
  const [draft, setDraft] = useState<ReportDraft>(() => {
    const asked = draftOf(search, now);
    // A subject not asked for is the first of its kind, so one click makes a report.
    return asked.id === ""
      ? { ...asked, id: options[asked.kind][0]?.value ?? "" }
      : asked;
  });
  const change = useCallback(
    (patch: Partial<ReportDraft>) => setDraft((was) => ({ ...was, ...patch })),
    []
  );
  const onKind = useCallback(
    (kind: unknown) => {
      const chosen = reportSubjectKinds.find((each) => each === kind);
      if (chosen) {
        change({ id: options[chosen][0]?.value ?? "", kind: chosen });
      }
    },
    [change, options]
  );
  const onPeriod = useCallback(
    (period: unknown) => {
      const chosen = periodKinds.find((each) => each === period);
      if (chosen) {
        change({ period: chosen });
      }
    },
    [change]
  );
  const onText = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { name, value } = event.currentTarget;
      if (
        name === "id" ||
        name === "month" ||
        name === "quarter" ||
        name === "target"
      ) {
        change({ [name]: value });
      }
    },
    [change]
  );
  const onDate = useCallback(
    (name: "from" | "to", value: string) =>
      change({ [name]: value.slice(0, 10) }),
    [change]
  );
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      const asked = searchOf(draft);
      if (asked) {
        event.preventDefault();
        onSubmit(asked);
      }
    },
    [draft, onSubmit]
  );

  const dates = datesOf(draft);
  const day = (text: string) =>
    formatDay(locale, Date.parse(`${text}T00:00:00Z`), clock.calendar);
  const subjects = options[draft.kind];
  return (
    <Card data-slot="report-form">
      <CardHeader divided>
        <CardTitle>{t("report_title")}</CardTitle>
        <CardDescription>{t("report_lead")}</CardDescription>
      </CardHeader>
      <form action="/admin/reports" method="get" onSubmit={submit}>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel id="report-subject-label">
                {t("report_subject_label")}
              </FieldLabel>
              <Segmented
                aria-labelledby="report-subject-label"
                data-name="subject"
                name="subject"
                onValueChange={onKind}
                value={draft.kind}
              >
                {reportSubjectKinds.map((kind) => (
                  <SegmentedItem key={kind} value={kind}>
                    {t(reportKindMessage[kind])}
                  </SegmentedItem>
                ))}
              </Segmented>
              <NativeSelect
                aria-label={t(reportKindMessage[draft.kind])}
                className="w-full"
                disabled={subjects.length === 0}
                name="id"
                onChange={onText}
                value={draft.id}
              >
                {subjects.map((each) => (
                  <NativeSelectOption key={each.value} value={each.value}>
                    {each.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {subjects.length === 0 ? (
                <FieldDescription data-slot="report-subject-none">
                  {t("report_subject_none")}
                </FieldDescription>
              ) : null}
            </Field>
            <Field>
              <FieldLabel id="report-period-label">
                {t("report_period_label")}
              </FieldLabel>
              <Segmented
                aria-labelledby="report-period-label"
                data-name="period"
                name="period"
                onValueChange={onPeriod}
                value={draft.period}
              >
                {periodKinds.map((kind) => (
                  <SegmentedItem key={kind} value={kind}>
                    {t(periodMessage[kind])}
                  </SegmentedItem>
                ))}
              </Segmented>
              {draft.period === "month" ? (
                <NativeSelect
                  aria-label={t("report_month_label")}
                  className="w-full"
                  name="month"
                  onChange={onText}
                  value={draft.month}
                >
                  {monthChoices(now, draft.month).map((month) => (
                    <NativeSelectOption key={month} value={month}>
                      {formatMonth(locale, month, "gregorian")}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
              {draft.period === "quarter" ? (
                <NativeSelect
                  aria-label={t("report_quarter_label")}
                  className="w-full"
                  name="quarter"
                  onChange={onText}
                  value={draft.quarter}
                >
                  {quarterChoices(now, draft.quarter).map((quarter) => {
                    const [year, number] = quarter.split("-");
                    return (
                      <NativeSelectOption key={quarter} value={quarter}>
                        {t("report_quarter_name", {
                          quarter: number,
                          year,
                        })}
                      </NativeSelectOption>
                    );
                  })}
                </NativeSelect>
              ) : null}
              {draft.period === "custom" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <TimeField
                    clock={clock}
                    label={t("report_from")}
                    name="from"
                    now={now}
                    onChange={onDate}
                    timeless
                    value={`${draft.from}T00:00`}
                  />
                  <TimeField
                    clock={clock}
                    label={t("report_to")}
                    name="to"
                    now={now}
                    onChange={onDate}
                    timeless
                    value={`${draft.to}T00:00`}
                  />
                </div>
              ) : null}
              {/* The range in the operator's calendar, whichever way it was picked; the days it sends stay Gregorian. */}
              <FieldDescription data-slot="report-dates">
                {t("report_range", {
                  from: day(dates.from),
                  to: day(dates.to),
                })}
                {". "}
                {t("report_dates_note")}
              </FieldDescription>
              <input name="from" type="hidden" value={dates.from} />
              <input name="to" type="hidden" value={dates.to} />
            </Field>
            <Field>
              <FieldLabel htmlFor="report-target">
                {t("report_target_label")}
              </FieldLabel>
              <Input
                className="w-40"
                dir="ltr"
                id="report-target"
                inputMode="decimal"
                max={uptimeTargetMax}
                min={uptimeTargetMin}
                name="target"
                onChange={onText}
                step="any"
                type="number"
                unit="%"
                value={draft.target}
              />
              <FieldDescription>
                {t("report_target_description")}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <FormFooter>
          <Button
            data-slot="generate-report"
            disabled={searchOf(draft) === undefined}
            type="submit"
          >
            {t("report_generate")}
          </Button>
        </FormFooter>
      </form>
    </Card>
  );
}

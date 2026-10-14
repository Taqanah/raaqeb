/**
 * A maintenance window's start or end in the operator's calendar: the date
 * as the native date field in Gregorian, and in Hijri as the day, month and
 * year in Umm al-Qura, the Gregorian date under them for Hijri with
 * Gregorian; then the hour and minute on the operator's clock in either.
 * The value is `datetime-local` text in the operator's zone, so the draft
 * and what the form sends are the same in every calendar.
 */
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import {
  dayPeriods,
  formatDay,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import {
  hijriDateOf,
  hijriMonthDays,
  hijriMonthNames,
  hijriWallTime,
} from "@/shared/i18n/hijri.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { wallTime } from "@/shared/i18n/timezone.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";

export interface TimeFieldProps {
  /** The operator's calendar, clock and zone, from the loader. */
  readonly clock: TimeOptions;
  /** The refusal shown under the field. */
  readonly error?: string;
  readonly label: string;
  readonly name: "ends" | "starts";
  /** The server's read time: the Hijri years offered start at its year. */
  readonly now: number;
  readonly onChange: (name: "ends" | "starts", value: string) => void;
  /** `datetime-local` text in the operator's zone. */
  readonly value: string;
}

/** Years offered past the later of the server's and the field's. */
const yearsAhead = 5;

const twoDigits = (value: number) => String(value).padStart(2, "0");
const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** A part of a time the operator chooses: the Hijri date's, and the clock's, where the period is the 12-hour clock's half of the day. */
export type HijriPart = "day" | "hour" | "minute" | "month" | "period" | "year";

const parts: ReadonlySet<string> = new Set<HijriPart>([
  "day",
  "hour",
  "minute",
  "month",
  "period",
  "year",
]);

function isPart(part: string | undefined): part is HijriPart {
  return part !== undefined && parts.has(part);
}

/**
 * The field's `datetime-local` text once one part changes. A 12-hour hour
 * (1 to 12) keeps the half of the day, and the half of the day (0 or 12)
 * keeps the hour; a day the new month lacks reads as its last.
 */
export function withPart(
  value: string,
  part: HijriPart,
  chosen: number,
  twelve: boolean
): string {
  let hour = Number(value.slice(11, 13));
  if (part === "hour") {
    hour = twelve ? (chosen % 12) + (hour >= 12 ? 12 : 0) : chosen;
  } else if (part === "period") {
    hour = (hour % 12) + chosen;
  }
  // The clock's parts leave the date as written, in any calendar.
  if (part === "hour" || part === "minute" || part === "period") {
    const minute = part === "minute" ? chosen : Number(value.slice(14, 16));
    return `${value.slice(0, 11)}${twoDigits(hour)}:${twoDigits(minute)}`;
  }
  const date = hijriDateOf(value);
  return hijriWallTime(
    {
      day: part === "day" ? chosen : date.day,
      month: part === "month" ? chosen : date.month,
      year: part === "year" ? chosen : date.year,
    },
    hour,
    Number(value.slice(14, 16))
  );
}

export function TimeField(props: TimeFieldProps): ReactNode {
  const { clock, error, label, name, onChange, value } = props;
  const { locale, t } = useMessages();
  const twelve = clock.clock === "12h";
  const onPart = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { dataset, value: chosen } = event.currentTarget;
      if (isPart(dataset.part)) {
        onChange(name, withPart(value, dataset.part, Number(chosen), twelve));
      }
    },
    [name, onChange, twelve, value]
  );
  const onPeriod = useCallback(
    (period: unknown) =>
      onChange(
        name,
        withPart(value, "period", period === "pm" ? 12 : 0, twelve)
      ),
    [name, onChange, twelve, value]
  );
  const onDate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(name, `${event.currentTarget.value}T${value.slice(11, 16)}`),
    [name, onChange, value]
  );
  const hour = Number(value.slice(11, 13));
  const [am, pm] = dayPeriods(locale);
  const common = { invalid: Boolean(error), onChange: onPart };
  const gregorian = clock.calendar === "gregorian";
  return (
    <Field>
      <FieldLabel htmlFor={name} id={`${name}-label`}>
        {label}
      </FieldLabel>
      <fieldset
        aria-labelledby={`${name}-label`}
        className="flex min-w-0 flex-col gap-2"
        data-slot={gregorian ? "gregorian-time" : "hijri-time"}
        data-value={value}
      >
        {gregorian ? (
          <Input
            aria-invalid={error ? true : undefined}
            className="w-auto self-start"
            dir="ltr"
            id={name}
            name={`${name}-date`}
            onChange={onDate}
            type="date"
            value={value.slice(0, 10)}
          />
        ) : (
          <HijriDate {...props} onPart={onPart} />
        )}
        <div className="flex items-center gap-2">
          {/* Hours before minutes, as a time is written in either language. */}
          <div className="flex items-center gap-1" dir="ltr">
            <Part
              {...common}
              label={t("maintenance_field_hour")}
              name={`${name}-hour`}
              options={
                twelve
                  ? [12, ...numbers(1, 11)].map((each) => [each, String(each)])
                  : numbers(0, 23).map((each) => [each, twoDigits(each)])
              }
              part="hour"
              value={twelve ? hour % 12 || 12 : hour}
            />
            <span aria-hidden="true" className="text-muted-foreground">
              :
            </span>
            <Part
              {...common}
              label={t("maintenance_field_minute")}
              name={`${name}-minute`}
              options={numbers(0, 59).map((each) => [each, twoDigits(each)])}
              part="minute"
              value={Number(value.slice(14, 16))}
            />
          </div>
          {twelve ? (
            <Segmented
              aria-label={t("maintenance_field_period")}
              className="w-auto"
              data-name={`${name}-period`}
              name={`${name}-period`}
              onValueChange={onPeriod}
              value={hour >= 12 ? "pm" : "am"}
            >
              <SegmentedItem value="am">{am}</SegmentedItem>
              <SegmentedItem value="pm">{pm}</SegmentedItem>
            </Segmented>
          ) : null}
        </div>
        {clock.calendar === "hijri_gregorian" ? (
          <FieldDescription data-slot="gregorian-date">
            {formatDay(locale, Date.parse(value.slice(0, 10)), "gregorian")}
          </FieldDescription>
        ) : null}
      </fieldset>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/** The Hijri day, month and year, each a select. */
function HijriDate({
  clock,
  error,
  name,
  now,
  onPart,
  value,
}: TimeFieldProps & {
  readonly onPart: (event: ChangeEvent<HTMLSelectElement>) => void;
}): ReactNode {
  const { locale, t } = useMessages();
  const date = hijriDateOf(value);
  const thisYear = hijriDateOf(wallTime(now, clock.timeZone)).year;
  const years = numbers(
    Math.min(thisYear, date.year),
    Math.max(thisYear, date.year) + yearsAhead
  );
  const months = hijriMonthNames(locale);
  const common = { invalid: Boolean(error), onChange: onPart };
  return (
    <div className="flex gap-2">
      <Part
        {...common}
        id={name}
        label={t("maintenance_field_day")}
        name={`${name}-day`}
        options={numbers(1, hijriMonthDays(date.year, date.month)).map(
          (day) => [day, String(day)]
        )}
        part="day"
        value={date.day}
      />
      <Part
        {...common}
        className="min-w-0 flex-1"
        label={t("maintenance_field_month")}
        name={`${name}-month`}
        options={months.map((month, index) => [index + 1, month])}
        part="month"
        value={date.month}
      />
      <Part
        {...common}
        label={t("maintenance_field_year")}
        name={`${name}-year`}
        options={years.map((year) => [year, String(year)])}
        part="year"
        value={date.year}
      />
    </div>
  );
}

/** One part of a time: a select with its own spoken label. */
function Part({
  className,
  id,
  invalid,
  label,
  name,
  onChange,
  options,
  part,
  value,
}: {
  readonly className?: string;
  readonly id?: string;
  readonly invalid: boolean;
  readonly label: string;
  readonly name: string;
  readonly onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly options: readonly (readonly [number, string])[];
  readonly part: HijriPart;
  readonly value: number;
}): ReactNode {
  return (
    <NativeSelect
      aria-invalid={invalid ? true : undefined}
      aria-label={label}
      className={className}
      data-part={part}
      id={id}
      name={name}
      onChange={onChange}
      value={value}
    >
      {options.map(([option, text]) => (
        <NativeSelectOption key={option} value={option}>
          {text}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

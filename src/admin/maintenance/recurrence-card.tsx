/**
 * The recurrence picker (CONTEXT.md "Maintenance series"): once, weekly or
 * monthly, and for a series the days it falls on, its start time on the
 * chosen zone's clock, its length in hours and minutes, and the zone. The
 * line under the choice says what the option chosen does; a picker, never a
 * cron line.
 */
import { type ChangeEvent, type ReactNode, useCallback, useMemo } from "react";
import { TimeZonePicker } from "@/admin/settings/time-zone-picker.tsx";
import { type TimeOptions, weekdayNames } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { timeZones } from "@/shared/i18n/timezone.ts";
import { monthWeeks } from "@/shared/schemas/maintenance.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
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
import type { RecurrenceDraft, Repeat } from "./series-draft.ts";
import { TimeField } from "./time-field.tsx";
import type { WindowFieldErrors } from "./window-draft.ts";

type OnRecurrence = (
  update: (current: RecurrenceDraft) => RecurrenceDraft
) => void;

const repeatWords: Readonly<
  Record<Repeat, { readonly hint: MessageId; readonly label: MessageId }>
> = {
  monthly: {
    hint: "maintenance_repeat_monthly_hint",
    label: "maintenance_repeat_monthly",
  },
  once: {
    hint: "maintenance_repeat_once_hint",
    label: "maintenance_repeat_once",
  },
  weekly: {
    hint: "maintenance_repeat_weekly_hint",
    label: "maintenance_repeat_weekly",
  },
};

const repeats: readonly Repeat[] = ["once", "weekly", "monthly"];

function isRepeat(value: unknown): value is Repeat {
  return repeats.some((each) => each === value);
}

/** How the window repeats, with the line that says what the choice does. A series' own page offers weekly and monthly alone. */
export function RepeatChoice({
  onRecurrence,
  series = false,
  value,
}: {
  readonly onRecurrence: OnRecurrence;
  readonly series?: boolean;
  readonly value: Repeat;
}): ReactNode {
  const { t } = useMessages();
  const onValue = useCallback(
    (next: unknown) => {
      if (isRepeat(next)) {
        onRecurrence((current) => ({ ...current, repeat: next }));
      }
    },
    [onRecurrence]
  );
  return (
    <Field>
      <FieldLabel id="repeat-label">{t("maintenance_field_repeat")}</FieldLabel>
      <Segmented
        aria-labelledby="repeat-label"
        data-slot="repeat"
        name="repeat"
        onValueChange={onValue}
        value={value}
      >
        {repeats
          .filter((each) => !(series && each === "once"))
          .map((each) => (
            <SegmentedItem key={each} value={each}>
              {t(repeatWords[each].label)}
            </SegmentedItem>
          ))}
      </Segmented>
      <FieldDescription>{t(repeatWords[value].hint)}</FieldDescription>
    </Field>
  );
}

const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const twoDigits = (value: number) => String(value).padStart(2, "0");

/** A series' times: its days, its start time, its length and its zone, under the repeat choice. */
export function RecurrenceCard({
  clock,
  errors,
  lead,
  now,
  onRecurrence,
  recurrence,
}: {
  readonly clock: TimeOptions;
  readonly errors: WindowFieldErrors;
  /** Above the days: how the window repeats. */
  readonly lead: ReactNode;
  readonly now: number;
  readonly onRecurrence: OnRecurrence;
  readonly recurrence: RecurrenceDraft;
}): ReactNode {
  const { t } = useMessages();
  const onTime = useCallback(
    (_name: "time", value: string) =>
      onRecurrence((current) => ({ ...current, time: value.slice(11, 16) })),
    [onRecurrence]
  );
  const onZone = useCallback(
    (timeZone: string) => onRecurrence((current) => ({ ...current, timeZone })),
    [onRecurrence]
  );
  const zones = useMemo(() => timeZones(), []);
  // The picker's own zone: its clock reads the start time, whatever the operator's.
  const zoneClock = { ...clock, timeZone: recurrence.timeZone };
  return (
    <Card>
      <CardHeader divided>
        <CardTitle>{t("maintenance_section_times")}</CardTitle>
        <CardDescription>{t("maintenance_series_times_hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {lead}
        {recurrence.repeat === "weekly" ? (
          <Weekdays
            error={errors.weekdays && t(errors.weekdays)}
            onRecurrence={onRecurrence}
            recurrence={recurrence}
          />
        ) : (
          <MonthDay onRecurrence={onRecurrence} recurrence={recurrence} />
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <TimeField
            clock={zoneClock}
            dateless
            label={t("maintenance_field_time")}
            name="time"
            now={now}
            onChange={onTime}
            value={`2000-01-01T${recurrence.time}`}
          />
          <Duration
            error={errors.duration && t(errors.duration)}
            onRecurrence={onRecurrence}
            recurrence={recurrence}
          />
        </div>
        <Field>
          <FieldLabel id="series-zone-label">
            {t("maintenance_times_zone")}
          </FieldLabel>
          <TimeZonePicker
            defaultValue={recurrence.timeZone}
            labelledBy="series-zone-label"
            name="timeZone"
            onZone={onZone}
            suggested={[clock.timeZone]}
            zones={zones}
          />
        </Field>
      </CardContent>
    </Card>
  );
}

/** The weekly days to tick, Sunday first. */
function Weekdays({
  error,
  onRecurrence,
  recurrence,
}: {
  readonly error: string | undefined;
  readonly onRecurrence: OnRecurrence;
  readonly recurrence: RecurrenceDraft;
}): ReactNode {
  const { locale, t } = useMessages();
  const names = weekdayNames(locale);
  return (
    <Field>
      <FieldLabel id="weekdays-label">
        {t("maintenance_field_weekdays")}
      </FieldLabel>
      <ul aria-labelledby="weekdays-label" className="flex flex-wrap gap-2">
        {names.map((name, weekday) => (
          <Weekday
            chosen={recurrence.weekdays.includes(weekday)}
            invalid={error !== undefined}
            key={name}
            name={name}
            onRecurrence={onRecurrence}
            weekday={weekday}
          />
        ))}
      </ul>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function Weekday({
  chosen,
  invalid,
  name,
  onRecurrence,
  weekday,
}: {
  readonly chosen: boolean;
  readonly invalid: boolean;
  readonly name: string;
  readonly onRecurrence: OnRecurrence;
  readonly weekday: number;
}): ReactNode {
  const onChecked = useCallback(
    (checked: boolean) =>
      onRecurrence((current) => ({
        ...current,
        weekdays: checked
          ? [...current.weekdays.filter((each) => each !== weekday), weekday]
          : current.weekdays.filter((each) => each !== weekday),
      })),
    [onRecurrence, weekday]
  );
  const id = `weekday-${weekday}`;
  return (
    <li data-slot="weekday" data-weekday={weekday}>
      <label
        className="flex min-h-control cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm has-data-checked:border-action"
        htmlFor={id}
      >
        <Checkbox
          aria-invalid={invalid ? true : undefined}
          checked={chosen}
          id={id}
          name={id}
          onCheckedChange={onChecked}
        />
        {name}
      </label>
    </li>
  );
}

/** The monthly day: a day of the month, or the nth of a weekday. */
function MonthDay({
  onRecurrence,
  recurrence,
}: {
  readonly onRecurrence: OnRecurrence;
  readonly recurrence: RecurrenceDraft;
}): ReactNode {
  const { locale, t } = useMessages();
  const onMonthly = useCallback(
    (monthly: unknown) => {
      if (monthly === "day" || monthly === "weekday") {
        onRecurrence((current) => ({ ...current, monthly }));
      }
    },
    [onRecurrence]
  );
  const onSelect = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { name, value } = event.currentTarget;
      onRecurrence((current) => {
        if (name === "day") {
          return { ...current, day: Number(value) };
        }
        if (name === "weekday") {
          return { ...current, weekday: Number(value) };
        }
        const week = monthWeeks.find((each) => each === value);
        return week ? { ...current, week } : current;
      });
    },
    [onRecurrence]
  );
  return (
    <>
      <Field>
        <FieldLabel id="monthly-label">
          {t("maintenance_field_monthly_on")}
        </FieldLabel>
        <Segmented
          aria-labelledby="monthly-label"
          data-slot="monthly"
          name="monthly"
          onValueChange={onMonthly}
          value={recurrence.monthly}
        >
          <SegmentedItem value="day">
            {t("maintenance_monthly_on_day")}
          </SegmentedItem>
          <SegmentedItem value="weekday">
            {t("maintenance_monthly_on_weekday")}
          </SegmentedItem>
        </Segmented>
      </Field>
      {recurrence.monthly === "day" ? (
        <Field>
          <FieldLabel htmlFor="day">
            {t("maintenance_field_day_of_month")}
          </FieldLabel>
          <NativeSelect
            className="w-auto self-start"
            id="day"
            name="day"
            onChange={onSelect}
            value={recurrence.day}
          >
            {numbers(1, 31).map((day) => (
              <NativeSelectOption key={day} value={day}>
                {day}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {recurrence.day > 28 ? (
            <FieldDescription>
              {t("maintenance_day_of_month_short")}
            </FieldDescription>
          ) : null}
        </Field>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="week">
              {t("maintenance_field_week")}
            </FieldLabel>
            <NativeSelect
              id="week"
              name="week"
              onChange={onSelect}
              value={recurrence.week}
            >
              {monthWeeks.map((week) => (
                <NativeSelectOption key={week} value={week}>
                  {t("maintenance_week", { week })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="weekday">
              {t("maintenance_field_weekday")}
            </FieldLabel>
            <NativeSelect
              id="weekday"
              name="weekday"
              onChange={onSelect}
              value={recurrence.weekday}
            >
              {weekdayNames(locale).map((name, weekday) => (
                <NativeSelectOption key={name} value={weekday}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
      )}
    </>
  );
}

/** The length: whole hours typed, then the minutes past them. */
function Duration({
  error,
  onRecurrence,
  recurrence,
}: {
  readonly error: string | undefined;
  readonly onRecurrence: OnRecurrence;
  readonly recurrence: RecurrenceDraft;
}): ReactNode {
  const { t } = useMessages();
  const onHours = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const hours = event.currentTarget.value;
      onRecurrence((current) => ({ ...current, hours }));
    },
    [onRecurrence]
  );
  const onMinutes = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const minutes = Number(event.currentTarget.value);
      onRecurrence((current) => ({ ...current, minutes }));
    },
    [onRecurrence]
  );
  const invalid = error ? true : undefined;
  return (
    <Field>
      <FieldLabel htmlFor="hours" id="duration-label">
        {t("maintenance_field_duration")}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          aria-invalid={invalid}
          aria-label={t("maintenance_field_hours")}
          className="w-28"
          dir="ltr"
          id="hours"
          inputMode="numeric"
          max={168}
          min={0}
          name="hours"
          onChange={onHours}
          type="number"
          unit={t("maintenance_hours_unit")}
          value={recurrence.hours}
        />
        <NativeSelect
          aria-invalid={invalid}
          aria-label={t("maintenance_field_minutes")}
          name="minutes"
          onChange={onMinutes}
          value={recurrence.minutes}
        >
          {numbers(0, 59).map((minute) => (
            <NativeSelectOption key={minute} value={minute}>
              {twoDigits(minute)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-muted-foreground text-sm">
          {t("maintenance_minutes_unit")}
        </span>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/**
 * The calendar as a segmented control, shaped like the clock's:
 * each option shows the same day in its calendar, by its day and month
 * without the year, so the difference is seen
 * before it is chosen. The account page adds "as the install", which shows
 * the calendar it follows.
 */
import type { ReactNode } from "react";
import { formatDayAndMonth } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { type Calendar, calendars } from "@/shared/schemas/clock.ts";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";

/** A fixed day, 1 January 2026, so each option's sample is the same day and renders alike on the server and in the browser. */
const sampleDay = Date.UTC(2026, 0, 1);

export function CalendarChoice({
  defaultValue,
  follow,
  labelledBy,
  name,
  onCalendar,
}: {
  readonly defaultValue: string;
  /** "As the install", with the value it stands for; only the account page offers it. */
  readonly follow?: { readonly calendar: Calendar; readonly value: string };
  readonly labelledBy: string;
  readonly name: string;
  readonly onCalendar?: (value: unknown) => void;
}): ReactNode {
  const { locale, t } = useMessages();
  const sample = (calendar: Calendar) =>
    formatDayAndMonth(locale, sampleDay, calendar);
  return (
    <Segmented
      aria-labelledby={labelledBy}
      data-name={name}
      defaultValue={defaultValue}
      name={name}
      onValueChange={onCalendar}
    >
      {follow ? (
        <SegmentedItem hint={sample(follow.calendar)} value={follow.value}>
          {t("setting_follow_install")}
        </SegmentedItem>
      ) : null}
      {calendars.map((calendar) => (
        <SegmentedItem hint={sample(calendar)} key={calendar} value={calendar}>
          {t(`setting_calendar_${calendar}`)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

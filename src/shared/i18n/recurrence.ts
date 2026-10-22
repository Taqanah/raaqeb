/**
 * The days a maintenance series repeats on, in words for a visitor and a
 * subscriber (CONTEXT.md "Maintenance series"): no start time, since each
 * occurrence's own times are shown beside them in the reader's time zone.
 */
import type { RecurrenceDays } from "@/shared/schemas/maintenance.ts";
import { intlLocale } from "./format.ts";
import type { MessagesContext } from "./react.tsx";

/** «كل أحد وثلاثاء», "The second Tuesday of every month". */
export function repeatWords(
  { locale, t }: MessagesContext,
  days: RecurrenceDays
): string {
  if (days.repeat === "monthly_day") {
    return t("maintenance_repeats_monthly_day", { day: String(days.day) });
  }
  if (days.repeat === "monthly_weekday") {
    return t("maintenance_repeats_monthly_weekday", {
      week: days.week,
      weekday: t("maintenance_weekday", { weekday: String(days.weekday) }),
    });
  }
  if (days.weekdays.length === 7) {
    return t("maintenance_repeats_daily");
  }
  const names = days.weekdays.map((weekday) =>
    t("maintenance_weekday", { weekday: String(weekday) })
  );
  return t("maintenance_repeats_weekly", {
    days: new Intl.ListFormat(intlLocale(locale)).format(names),
  });
}

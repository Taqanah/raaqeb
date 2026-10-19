/**
 * The words and marks the maintenance screens share (CONTEXT.md
 * "Maintenance window", "Maintenance series"): a window's stage as a badge,
 * blue while it runs as the maintenance status is, a refusal by its reason,
 * and a series' recurrence in words.
 */
import type { ReactNode } from "react";
import { formatClockTime, intlLocale } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { type MessagesContext, useMessages } from "@/shared/i18n/react.tsx";
import type { Clock } from "@/shared/schemas/clock.ts";
import type {
  MaintenanceRefusal,
  MaintenanceStage,
  Recurrence,
} from "@/shared/schemas/maintenance.ts";
import { Badge, type BadgeProps } from "@/shared/ui/badge.tsx";

export const stageWords: Readonly<Record<MaintenanceStage, MessageId>> = {
  completed: "maintenance_stage_completed",
  in_progress: "maintenance_stage_in_progress",
  scheduled: "maintenance_stage_scheduled",
};

export const refusalWords: Readonly<Record<MaintenanceRefusal, MessageId>> = {
  changed: "maintenance_refused_changed",
  invalid: "app_form_invalid",
  not_found: "maintenance_not_found",
  unavailable: "maintenance_unavailable",
};

const stageVariants: Readonly<
  Record<MaintenanceStage, NonNullable<BadgeProps["variant"]>>
> = {
  completed: "up",
  in_progress: "maintenance",
  scheduled: "secondary",
};

export function StageBadge({
  stage,
}: {
  readonly stage: MaintenanceStage;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Badge
      data-slot="window-stage"
      data-stage={stage}
      variant={stageVariants[stage]}
    >
      {t(stageWords[stage])}
    </Badge>
  );
}

/** A series' recurrence in words, its time on the clock format: «كل أحد وثلاثاء، الساعة 2:00 ص», "The second Tuesday of every month at 2:00 AM". */
export function recurrenceWords(
  { locale, t }: MessagesContext,
  recurrence: Recurrence,
  clock: Clock
): string {
  const { days } = recurrence;
  const time = formatClockTime(locale, recurrence.time, clock);
  if (days.repeat === "monthly_day") {
    return t("maintenance_recurrence_monthly_day", {
      day: String(days.day),
      time,
    });
  }
  if (days.repeat === "monthly_weekday") {
    return t("maintenance_recurrence_monthly_weekday", {
      time,
      week: days.week,
      weekday: t("maintenance_weekday", { weekday: String(days.weekday) }),
    });
  }
  if (days.weekdays.length === 7) {
    return t("maintenance_recurrence_daily", { time });
  }
  const names = days.weekdays.map((weekday) =>
    t("maintenance_weekday", { weekday: String(weekday) })
  );
  return t("maintenance_recurrence_weekly", {
    days: new Intl.ListFormat(intlLocale(locale)).format(names),
    time,
  });
}

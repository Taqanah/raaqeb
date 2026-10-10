/**
 * The words and marks the maintenance screens share (CONTEXT.md
 * "Maintenance window"): a window's stage as a badge, blue while
 * it runs as the maintenance status is, and a refusal by its reason.
 */
import type { ReactNode } from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MaintenanceRefusal,
  MaintenanceStage,
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

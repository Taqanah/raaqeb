/**
 * The words and marks the incident screens share (CONTEXT.md "Impact
 * level", "Incident"): an impact level and a stage as badges, a
 * refusal by its reason, and a time shown relative with its absolute form
 * and zone on hover. An impact level takes the colour of the
 * status it suggests; a stage is neutral until resolved.
 */
import type { ReactNode } from "react";
import {
  formatDateTimeWithZone,
  formatWhen,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  ImpactLevel,
  IncidentRefusal,
  IncidentStage,
} from "@/shared/schemas/incident.ts";
import { Badge, type BadgeProps } from "@/shared/ui/badge.tsx";

export const impactWords: Readonly<Record<ImpactLevel, MessageId>> = {
  critical: "incident_impact_critical",
  major: "incident_impact_major",
  minor: "incident_impact_minor",
  none: "incident_impact_none",
};

export const stageWords: Readonly<Record<IncidentStage, MessageId>> = {
  identified: "incident_stage_identified",
  investigating: "incident_stage_investigating",
  monitoring: "incident_stage_monitoring",
  resolved: "incident_stage_resolved",
};

export const refusalWords: Readonly<Record<IncidentRefusal, MessageId>> = {
  changed: "incident_refused_changed",
  invalid: "app_form_invalid",
  not_found: "incident_not_found",
  resolved: "incident_refused_resolved",
  unavailable: "incident_unavailable",
};

export const impactVariants: Readonly<
  Record<ImpactLevel, NonNullable<BadgeProps["variant"]>>
> = {
  critical: "down",
  major: "partial",
  minor: "degraded",
  none: "secondary",
};

export function ImpactBadge({
  impact,
}: {
  readonly impact: ImpactLevel;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Badge
      data-impact={impact}
      data-slot="incident-impact"
      variant={impactVariants[impact]}
    >
      {t(impactWords[impact])}
    </Badge>
  );
}

export function StageBadge({
  stage,
}: {
  readonly stage: IncidentStage;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Badge
      data-slot="incident-stage"
      data-stage={stage}
      variant={stage === "resolved" ? "up" : "secondary"}
    >
      {t(stageWords[stage])}
    </Badge>
  );
}

/** A time relative to the server's read under a day, absolute after, with the absolute form and its zone on hover. */
export function When({
  at,
  clock,
  now,
}: {
  readonly at: number;
  readonly clock: TimeOptions;
  readonly now: number;
}): ReactNode {
  const { locale } = useMessages();
  return (
    <time
      className="tabular-nums"
      dateTime={new Date(at).toISOString()}
      title={formatDateTimeWithZone(locale, at, clock)}
    >
      {formatWhen(locale, at, { ...clock, now })}
    </time>
  );
}

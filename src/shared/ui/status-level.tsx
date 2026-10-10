/**
 * A status level as the admin and the public page show it (CONTEXT.md
 * "Status level"): its word in the catalog, or the label a page
 * renamed it to, and its colour, each level mapped onto the status family,
 * partial outage on its own orange.
 */
import type { ReactNode } from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { type StatusLevel, statusLevels } from "@/shared/schemas/status.ts";
import { Badge, type BadgeProps, type BadgeVariant } from "./badge.tsx";
import { cn } from "./cn.ts";

export const levelWords: Readonly<Record<StatusLevel, MessageId>> = {
  degraded_performance: "component_level_degraded_performance",
  major_outage: "component_level_major_outage",
  operational: "component_level_operational",
  partial_outage: "component_level_partial_outage",
  under_maintenance: "component_level_under_maintenance",
};

export const levelVariants: Readonly<
  Record<StatusLevel, NonNullable<BadgeProps["variant"]>>
> = {
  degraded_performance: "degraded",
  major_outage: "down",
  operational: "up",
  partial_outage: "partial",
  under_maintenance: "maintenance",
};

/** The badge variants of the levels a status page picked its own colour for. */
export function pageColourVariants(
  colours: Partial<Record<StatusLevel, string>>
): ReadonlySet<BadgeVariant> {
  return new Set(
    statusLevels.flatMap((level) =>
      colours[level] ? [levelVariants[level]] : []
    )
  );
}

export function StatusLevelBadge({
  className,
  label,
  level,
  mark,
  slot,
}: {
  readonly className?: string;
  /** Whether the badge draws its mark; off beside the level's own icon. */
  readonly mark?: boolean;
  /** A page's own name for the level, shown in place of the catalog's word. */
  readonly label?: string | undefined;
  readonly level: StatusLevel;
  readonly slot?: string;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Badge
      className={className}
      data-level={level}
      data-slot={slot}
      mark={mark}
      variant={levelVariants[level]}
    >
      {label ?? t(levelWords[level])}
    </Badge>
  );
}

/** The level's colour each icon fills with, by the status family's variable. */
const iconColours: Readonly<Record<StatusLevel, string>> = {
  degraded_performance: "text-status-degraded",
  major_outage: "text-status-down",
  operational: "text-status-up",
  partial_outage: "text-status-partial",
  under_maintenance: "text-status-maintenance",
};

/** A level as a filled disc whose glyph tells it apart without its colour: a tick, a clock, a mark, a cross. Decorative: the level's word sits beside it. */
export function StatusLevelIcon({
  className,
  level,
}: {
  readonly className?: string;
  readonly level: StatusLevel;
}): ReactNode {
  const glyph = {
    degraded_performance: "M12 7.5v5.5M12 16.5v.01",
    major_outage: "m9 9 6 6M15 9l-6 6",
    operational: "m8 12.5 2.5 2.5 5.5-5.5",
    partial_outage: "M12 7.5v5.5M12 16.5v.01",
    under_maintenance: "M12 7v5l3 2",
  }[level];
  return (
    <svg
      aria-hidden="true"
      className={cn("size-[1.125rem] shrink-0", iconColours[level], className)}
      data-level={level}
      data-slot="level-icon"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" fill="currentColor" r="11" />
      <path
        d={glyph}
        fill="none"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  );
}

/**
 * Status levels as a segmented control, apart from the badge module
 * so the public page, which shows levels and never sets one, loads none of
 * the radio group's code.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { StatusDot } from "./badge.tsx";
import { cn } from "./cn.ts";
import { Segmented, SegmentedItem } from "./segmented.tsx";
import { levelVariants, levelWords } from "./status-level.tsx";

/** Status levels as a segmented control, each with its colour's dot, one click to set. */
export function LevelChoice({
  className,
  disabled,
  label,
  levels,
  name,
  onLevel,
  slot,
  value,
}: {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly levels: readonly StatusLevel[];
  readonly name: string;
  readonly onLevel: (value: unknown) => void;
  readonly slot?: string;
  readonly value: StatusLevel;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Segmented
      aria-label={label}
      // Four levels: two rows of two where a row cannot hold them.
      className={cn("max-sm:grid max-sm:grid-cols-2", className)}
      data-slot={slot}
      disabled={disabled}
      name={name}
      onValueChange={onLevel}
      value={value}
    >
      {levels.map((level) => (
        <SegmentedItem key={level} value={level}>
          <StatusDot variant={levelVariants[level]} />
          {t(levelWords[level])}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

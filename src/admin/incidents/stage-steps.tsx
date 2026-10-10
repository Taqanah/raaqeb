/**
 * An incident's stage as steps: the stages in their
 * order on one segmented control, the ones before the chosen one ticked, so
 * the choice also says how far the incident has come; no numbers.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { IncidentStage } from "@/shared/schemas/incident.ts";
import { cn } from "@/shared/ui/cn.ts";
import { CheckIcon } from "@/shared/ui/icons.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { stageWords } from "./incident-words.tsx";

export function StageSteps({
  label,
  onStage,
  stages,
  value,
}: {
  readonly label: string;
  readonly onStage: (value: unknown) => void;
  readonly stages: readonly IncidentStage[];
  readonly value: IncidentStage;
}): ReactNode {
  const { t } = useMessages();
  const at = stages.indexOf(value);
  return (
    <Segmented
      aria-label={label}
      // Four stages: two rows of two on a phone.
      className={cn(stages.length > 3 && "max-sm:grid max-sm:grid-cols-2")}
      data-slot="incident-stage-choice"
      name="stage"
      onValueChange={onStage}
      value={value}
    >
      {stages.map((stage, index) => (
        <SegmentedItem key={stage} value={stage}>
          {index < at ? (
            <CheckIcon aria-hidden="true" className="size-3.5 text-action" />
          ) : null}
          {t(stageWords[stage])}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

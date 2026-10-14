/**
 * The affected components of an incident being written: every
 * component as a row to tick, with its status now and whether monitors
 * drive it; a ticked one takes the status the incident sets on it. A
 * component the incident already affects stays ticked, only set back to
 * operational.
 */
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { useContentIn } from "@/admin/shell/content.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  IncidentComponent,
  IncidentStatus,
} from "@/shared/schemas/incident.ts";
import { type HandSetLevel, handSetLevels } from "@/shared/schemas/status.ts";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import { LevelChoice } from "@/shared/ui/level-choice.tsx";
import { StatusLevelBadge } from "@/shared/ui/status-level.tsx";
import { withoutComponent, withStatus } from "./incident-draft.ts";

export interface AffectedComponentsProps {
  /** Every component, in creation order. */
  readonly components: readonly IncidentComponent[];
  /** The components the incident already affects, which stay. */
  readonly locked: readonly string[];
  readonly onChange: (statuses: IncidentStatus[]) => void;
  readonly statuses: readonly IncidentStatus[];
}

export function AffectedComponents({
  components,
  locked,
  onChange,
  statuses,
}: AffectedComponentsProps): ReactNode {
  const { t } = useMessages();
  if (components.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("incident_components_none")}{" "}
        <Link
          className="underline underline-offset-4"
          to="/admin/components/new"
        >
          {t("component_add")}
        </Link>
      </p>
    );
  }
  const chosen = new Map(statuses.map((each) => [each.componentId, each]));
  return (
    <ul className="flex flex-col" data-slot="incident-components">
      {components.map((component) => (
        <AffectedRow
          component={component}
          key={component.id}
          locked={locked}
          onChange={onChange}
          status={chosen.get(component.id)?.status}
          statuses={statuses}
        />
      ))}
    </ul>
  );
}

/** The status a component starts at when ticked: its status now, or operational under maintenance, which an incident never sets. */
function settable(component: IncidentComponent): HandSetLevel {
  return component.status === "under_maintenance"
    ? "operational"
    : component.status;
}

/** One component: ticked when the incident affects it, with the status it sets; one the incident already affects stays ticked. */
function AffectedRow({
  component,
  locked,
  onChange,
  status,
  statuses,
}: {
  readonly component: IncidentComponent;
  readonly locked: readonly string[];
  readonly onChange: (statuses: IncidentStatus[]) => void;
  readonly status: HandSetLevel | undefined;
  readonly statuses: readonly IncidentStatus[];
}): ReactNode {
  const { t } = useMessages();
  const name = useContentIn()(component.name);
  const onTick = useCallback(
    (checked: boolean) => {
      onChange(
        checked
          ? withStatus(statuses, component.id, settable(component))
          : withoutComponent(statuses, component.id, locked)
      );
    },
    [component, locked, onChange, statuses]
  );
  const onStatus = useCallback(
    (value: unknown) => {
      const level = handSetLevels.find((each) => each === value);
      if (level) {
        onChange(withStatus(statuses, component.id, level));
      }
    },
    [component.id, onChange, statuses]
  );
  const id = `affect-${component.id}`;
  const isLocked = locked.includes(component.id);
  return (
    <li
      className="flex min-h-control flex-wrap items-center gap-x-3 gap-y-2 border-border border-b py-2 last:border-b-0"
      data-component={component.id}
      // Only an affected one is an incident component; the others are choices.
      data-slot={status ? "incident-component" : "incident-component-choice"}
    >
      <Checkbox
        aria-describedby={isLocked ? `${id}-locked` : undefined}
        checked={status !== undefined}
        disabled={isLocked}
        id={id}
        onCheckedChange={onTick}
      />
      <label
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"
        htmlFor={id}
      >
        <bdi className="max-w-full truncate font-medium text-sm">{name}</bdi>
        {component.linked ? (
          <span className="text-muted-foreground text-xs">
            {t("incident_component_linked")}
          </span>
        ) : null}
      </label>
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {t("incident_component_now")}
        <StatusLevelBadge level={component.status} />
      </span>
      {isLocked ? (
        // Why the box cannot be cleared, under the name.
        <p
          className="ms-7 w-full text-muted-foreground text-xs"
          data-slot="incident-component-locked"
          id={`${id}-locked`}
        >
          {t("incident_component_locked")}
        </p>
      ) : null}
      {status ? (
        <LevelChoice
          // Its own line under the name, in line with it past the box, so the four levels have the row's width.
          className="ms-7 w-[calc(100%-1.75rem)]"
          label={name}
          levels={handSetLevels}
          name={`status-${component.id}`}
          onLevel={onStatus}
          slot="incident-component-status"
          value={status}
        />
      ) : null}
    </li>
  );
}

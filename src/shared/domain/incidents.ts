/**
 * What an incident's updates say about it (CONTEXT.md "Incident", "Incident
 * update"): the stage it is at, the status its latest update set
 * on each affected component, and which components it affects. Shared,
 * because the incident page's update editor starts from the latest
 * statuses. Pure.
 */
import type {
  Incident,
  IncidentStage,
  IncidentStatus,
} from "@/shared/schemas/incident.ts";

/** The stage its latest update moved it to. */
export function incidentStage(incident: Incident): IncidentStage {
  // Every incident is written with its first update, so there is always one.
  return incident.updates.at(-1)?.stage ?? "investigating";
}

/** The status its latest update set on each component that update names. */
export function latestStatuses(incident: Incident): readonly IncidentStatus[] {
  return incident.updates.at(-1)?.statuses ?? [];
}

/** Every component any of its updates named, in the order they were first named. */
export function affectedComponents(incident: Incident): string[] {
  return [
    ...new Set(
      incident.updates.flatMap((update) =>
        update.statuses.map((each) => each.componentId)
      )
    ),
  ];
}

/**
 * An incident's shapes (CONTEXT.md "Incident", "Incident update", "Impact
 * level"): a human-written record of a problem belonging to
 * the install, with an impact level and a lifecycle of updates. Each update
 * moves the incident to a stage and sets a status on each affected
 * component. The affected components are the ones its updates name; an
 * update may add one and never removes one, so the latest update names them
 * all. The admin's reads, inputs and results are here
 * too, so the admin never imports the server.
 */
import { z } from "zod";
import { type Content, contentSchema } from "./content.ts";
import {
  type HandSetLevel,
  handSetLevelSchema,
  type StatusLevel,
} from "./status.ts";

/** How bad an incident is for visitors, Statuspage's machine values. */
export const impactLevels = ["none", "minor", "major", "critical"] as const;
export const impactLevelSchema = z.enum(impactLevels);
export type ImpactLevel = z.infer<typeof impactLevelSchema>;

/** The lifecycle in order, Statuspage's machine values. */
export const incidentStages = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;
export const incidentStageSchema = z.enum(incidentStages);
export type IncidentStage = z.infer<typeof incidentStageSchema>;

/** The stages an open incident moves between, in any order; resolved ends it for good. */
export const openStages = [
  "investigating",
  "identified",
  "monitoring",
] as const;
export const openStageSchema = z.enum(openStages);
export type OpenStage = z.infer<typeof openStageSchema>;

export const incidentTitleMaxLength = 200;
export const incidentMessageMaxLength = 5000;

/** The status one update set on one affected component: one a hand may set, never under maintenance, which only a maintenance window sets. */
export interface IncidentStatus {
  /** The status the page showed for the component just before this update first named it: only on that update, and absent on one written before Raaqeb kept it. */
  readonly before?: StatusLevel;
  readonly componentId: string;
  readonly status: HandSetLevel;
}

export interface IncidentUpdate {
  /** The operator's email when the update was written; the admin shows it, a public view never does. */
  readonly author: string;
  readonly createdAt: number;
  readonly id: string;
  /** Plain text in each locale; each paragraph picks its own direction. */
  readonly message: Content;
  readonly stage: IncidentStage;
  /** Each affected component's status, in the components' creation order. */
  readonly statuses: readonly IncidentStatus[];
}

export interface IncidentFields {
  readonly impact: ImpactLevel;
  readonly title: Content;
}

export interface Incident extends IncidentFields {
  readonly createdAt: number;
  readonly id: string;
  /** Its resolving update's time; nothing while it is open. */
  readonly resolvedAt: number | undefined;
  readonly updatedAt: number;
  /** Oldest first; the first is the one it was created with. */
  readonly updates: readonly IncidentUpdate[];
}

const titleSchema = contentSchema(incidentTitleMaxLength);
const messageSchema = contentSchema(incidentMessageMaxLength);

/** Each affected component's status; a component named twice keeps its first. */
const statusesSchema = z
  .array(
    z.object({ componentId: z.string().min(1), status: handSetLevelSchema })
  )
  .transform((statuses) =>
    statuses.filter(
      (each, index) =>
        statuses.findIndex(
          (other) => other.componentId === each.componentId
        ) === index
    )
  );

export const incidentFieldsSchema = z.object({
  impact: impactLevelSchema,
  title: titleSchema,
});

/** A new incident: its fields and its first update, which starts it at an open stage with at least one affected component. */
export const incidentCreateSchema = incidentFieldsSchema.extend({
  message: messageSchema,
  stage: openStageSchema,
  statuses: statusesSchema.refine((statuses) => statuses.length > 0),
});
export type IncidentCreateInput = z.infer<typeof incidentCreateSchema>;

/** An update of an open incident: an open stage with every affected component's status, or the resolving one, which keeps the status the incident set on components set by hand or returns them to the status they had before. */
export const incidentUpdateSchema = z.union([
  z.object({
    message: messageSchema,
    stage: openStageSchema,
    statuses: statusesSchema.refine((statuses) => statuses.length > 0),
  }),
  z.object({
    keep: z.boolean(),
    message: messageSchema,
    stage: z.literal("resolved"),
  }),
]);
export type IncidentUpdateInput = z.infer<typeof incidentUpdateSchema>;

export const incidentIdSchema = z.object({ id: z.string().min(1) });

export const incidentEditSchema = z.object({
  id: z.string().min(1),
  input: incidentFieldsSchema,
});

export const incidentPostSchema = z.object({
  id: z.string().min(1),
  input: incidentUpdateSchema,
});

/** A fix of one update's text; its time, stage and statuses stay. */
export const updateFixSchema = z.object({
  id: z.string().min(1),
  message: messageSchema,
  updateId: z.string().min(1),
});

/** The new-incident page's search: the monitor whose down notification's "open incident" link led here. */
export const newIncidentSearchSchema = z.object({
  monitor: z.string().min(1).optional().catch(undefined),
});

/** A component as the incident screens offer and name it. */
export interface IncidentComponent {
  readonly id: string;
  /** Linked to a monitor, so its status follows the monitors once the incident is resolved. */
  readonly linked: boolean;
  readonly name: Content;
  /** Its status now. */
  readonly status: StatusLevel;
}

/** One incident as the list shows it. */
export interface IncidentListItem {
  /** The affected components, in the order they were first named. */
  readonly components: readonly {
    readonly id: string;
    readonly name: Content;
  }[];
  readonly createdAt: number;
  readonly id: string;
  readonly impact: ImpactLevel;
  readonly resolvedAt: number | undefined;
  readonly stage: IncidentStage;
  readonly title: Content;
}

export interface IncidentList {
  /** Whether any component exists: an incident names the ones it affects, so none can publish without one. */
  readonly anyComponent: boolean;
  /** Open ones first, then resolved ones, each newest first. */
  readonly incidents: readonly IncidentListItem[];
  /** When the server read the list, so durations render the same on both sides. */
  readonly now: number;
}

/** What the new-incident page reads. */
export interface NewIncident {
  /** Every component, in creation order. */
  readonly components: readonly IncidentComponent[];
  /** From the "open incident" link: the monitor's name as the title and the components linked to it at their status now. */
  readonly prefill:
    | {
        readonly statuses: readonly IncidentStatus[];
        readonly title: string;
      }
    | undefined;
}

/** What an incident's page reads. */
export interface IncidentPage {
  /** Every component, in creation order: the affected ones are named from here, the others may be added. */
  readonly components: readonly IncidentComponent[];
  readonly incident: Incident;
  readonly now: number;
}

/** `changed`: another update landed, or a component went, since the page read the incident. */
export type IncidentRefusal =
  | "changed"
  | "invalid"
  | "not_found"
  | "resolved"
  | "unavailable";

/** A stored record this version cannot read; `id` names it. */
interface Corrupt {
  readonly id: string;
  readonly ok: false;
  readonly reason: "corrupt";
}

export type IncidentListResult =
  | { readonly ok: true; readonly list: IncidentList }
  | { readonly ok: false; readonly reason: "unavailable" }
  | Corrupt;

export type NewIncidentResult =
  | { readonly ok: true; readonly form: NewIncident }
  | { readonly ok: false; readonly reason: "unavailable" }
  | Corrupt;

export type IncidentPageResult =
  | { readonly ok: true; readonly page: IncidentPage }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" }
  | Corrupt;

export type IncidentSaveResult =
  | { readonly ok: true; readonly incident: Incident }
  | { readonly ok: false; readonly reason: IncidentRefusal };

export type IncidentDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: IncidentRefusal };

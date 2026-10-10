/**
 * A maintenance window's shapes (CONTEXT.md "Maintenance window"): a scheduled period with a start and an end, belonging to the
 * install, during which its affected components show under maintenance.
 * Its stage is the scheduler's alone: scheduled until its start, in
 * progress until its end, then completed. What the
 * operator may change follows the stage: everything while scheduled; the
 * title, the message and the end while in progress; the title and the
 * message once completed. The admin's reads, inputs and results are here
 * too, so the admin never imports the server.
 */
import { z } from "zod";
import { type Content, contentSchema } from "./content.ts";
import type { StatusLevel } from "./status.ts";

/** The lifecycle in order, Statuspage's machine values. */
export const maintenanceStages = [
  "scheduled",
  "in_progress",
  "completed",
] as const;
export const maintenanceStageSchema = z.enum(maintenanceStages);
export type MaintenanceStage = z.infer<typeof maintenanceStageSchema>;

export const maintenanceTitleMaxLength = 200;
export const maintenanceMessageMaxLength = 5000;

export interface MaintenanceWindow {
  /** The affected components, in the components' creation order. */
  readonly componentIds: readonly string[];
  readonly createdAt: number;
  readonly endsAt: number;
  readonly id: string;
  /** Plain text in each locale; each paragraph picks its own direction. */
  readonly message: Content;
  readonly stage: MaintenanceStage;
  readonly startsAt: number;
  readonly title: Content;
  readonly updatedAt: number;
}

const titleSchema = contentSchema(maintenanceTitleMaxLength);
const messageSchema = contentSchema(maintenanceMessageMaxLength);
/** A time the form typed, in UTC milliseconds; the module judges it against now. */
const timeSchema = z.int().nonnegative();

/** A new window, or every field of a scheduled one. A component named twice is affected once. */
export const maintenanceInputSchema = z.object({
  componentIds: z
    .array(z.string().min(1))
    .min(1)
    .transform((ids) => [...new Set(ids)]),
  endsAt: timeSchema,
  message: messageSchema,
  startsAt: timeSchema,
  title: titleSchema,
});
export type MaintenanceInput = z.infer<typeof maintenanceInputSchema>;

/** What a window in progress may change: its text and its end. */
export const runningEditSchema = z.object({
  endsAt: timeSchema,
  message: messageSchema,
  title: titleSchema,
});
export type RunningEdit = z.infer<typeof runningEditSchema>;

/** What a completed window may change: its text. */
export const textEditSchema = z.object({
  message: messageSchema,
  title: titleSchema,
});
export type TextEdit = z.infer<typeof textEditSchema>;

/** An edit as the form posts it for the stage it read: everything, the text and the end, or the text. */
export const maintenanceEditInputSchema = z.union([
  maintenanceInputSchema,
  runningEditSchema,
  textEditSchema,
]);
export type MaintenanceEditInput = z.infer<typeof maintenanceEditInputSchema>;

export const maintenanceEditSchema = z.object({
  id: z.string().min(1),
  input: maintenanceEditInputSchema,
});

export const maintenanceIdSchema = z.object({ id: z.string().min(1) });

/** A component as the maintenance screens offer and name it. */
export interface MaintenanceComponent {
  readonly id: string;
  readonly name: Content;
  /** Its status now. */
  readonly status: StatusLevel;
}

/** One window as the list shows it. */
export interface MaintenanceListItem {
  /** The affected components that still exist, in creation order. */
  readonly components: readonly {
    readonly id: string;
    readonly name: Content;
  }[];
  readonly endsAt: number;
  readonly id: string;
  readonly stage: MaintenanceStage;
  readonly startsAt: number;
  readonly title: Content;
}

export interface MaintenanceList {
  /** Whether any component exists: a window names the ones it affects, so none can be scheduled without one. */
  readonly anyComponent: boolean;
  /** When the server read the list, so times render the same on both sides. */
  readonly now: number;
  /** In progress first, then scheduled ones soonest first, then completed ones newest first. */
  readonly windows: readonly MaintenanceListItem[];
}

/** What the new-window page reads. */
export interface NewMaintenance {
  /** Every component, in creation order. */
  readonly components: readonly MaintenanceComponent[];
  /** When the server read the page; the form's first times count from it. */
  readonly now: number;
}

/** What a window's page reads. */
export interface MaintenancePage {
  /** Every component, in creation order. */
  readonly components: readonly MaintenanceComponent[];
  readonly now: number;
  readonly window: MaintenanceWindow;
}

/** `changed`: the window started, ended or went since the page read it, so what the page posted no longer applies. */
export type MaintenanceRefusal =
  | "changed"
  | "invalid"
  | "not_found"
  | "unavailable";

/** A stored record this version cannot read; `id` names it. */
interface Corrupt {
  readonly id: string;
  readonly ok: false;
  readonly reason: "corrupt";
}

export type MaintenanceListResult =
  | { readonly ok: true; readonly list: MaintenanceList }
  | { readonly ok: false; readonly reason: "unavailable" }
  | Corrupt;

export type NewMaintenanceResult =
  | { readonly ok: true; readonly form: NewMaintenance }
  | { readonly ok: false; readonly reason: "unavailable" }
  | Corrupt;

export type MaintenancePageResult =
  | { readonly ok: true; readonly page: MaintenancePage }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" }
  | Corrupt;

export type MaintenanceSaveResult =
  | { readonly ok: true; readonly window: MaintenanceWindow }
  | { readonly ok: false; readonly reason: MaintenanceRefusal };

export type MaintenanceDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MaintenanceRefusal };

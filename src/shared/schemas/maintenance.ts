/**
 * A maintenance window's shapes (CONTEXT.md "Maintenance window"): a scheduled period with a start and an end, belonging to the
 * install, during which its affected components show under maintenance.
 * A maintenance series (CONTEXT.md "Maintenance series") repeats one by its
 * recurrence, each occurrence an ordinary window.
 * Its stage is the scheduler's alone: scheduled until its start, in
 * progress until its end, then completed. What the
 * operator may change follows the stage: everything while scheduled; the
 * title, the message and the end while in progress; the title and the
 * message once completed. The admin's reads, inputs and results are here
 * too, so the admin never imports the server.
 */
import { z } from "zod";
import { timeZoneSchema } from "./clock.ts";
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
  /** The maintenance series it is an occurrence of; none for a window scheduled on its own, or once its series ended. */
  readonly seriesId?: string;
  readonly stage: MaintenanceStage;
  readonly startsAt: number;
  readonly title: Content;
  readonly updatedAt: number;
}

/** A day of the week as `Date.getUTCDay` counts it: 0 is Sunday. */
export const weekdaySchema = z.int().min(0).max(6);

/** Which of a month's weekdays of one name: the first to the fourth, or the last. */
export const monthWeeks = [
  "first",
  "second",
  "third",
  "fourth",
  "last",
] as const;
export const monthWeekSchema = z.enum(monthWeeks);
export type MonthWeek = z.infer<typeof monthWeekSchema>;

/** The days a recurrence falls on: weekly on one or more weekdays, monthly on a day of the month (29 to 31 fall on a shorter month's last day), or monthly on an nth weekday. */
export const recurrenceDaysSchema = z.discriminatedUnion("repeat", [
  z.object({
    repeat: z.literal("weekly"),
    weekdays: z
      .array(weekdaySchema)
      .min(1)
      .transform((days) => [...new Set(days)].toSorted((a, b) => a - b)),
  }),
  z.object({ day: z.int().min(1).max(31), repeat: z.literal("monthly_day") }),
  z.object({
    repeat: z.literal("monthly_weekday"),
    week: monthWeekSchema,
    weekday: weekdaySchema,
  }),
]);
export type RecurrenceDays = z.output<typeof recurrenceDaysSchema>;

/** A series' longest occurrence: a week. */
export const occurrenceMaxMinutes = 7 * 24 * 60;

/** How a maintenance series repeats: on its days, at a start time on its zone's clock (`02:30`), for a number of minutes. */
export const recurrenceSchema = z.object({
  days: recurrenceDaysSchema,
  minutes: z.int().min(1).max(occurrenceMaxMinutes),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: timeZoneSchema,
});
export type Recurrence = z.output<typeof recurrenceSchema>;

export interface MaintenanceSeries {
  /** The affected components, in the components' creation order. */
  readonly componentIds: readonly string[];
  readonly createdAt: number;
  readonly id: string;
  readonly message: Content;
  readonly recurrence: Recurrence;
  /** Every occurrence starting before it was scheduled; the series schedules the ones from it on. */
  readonly scheduledUntil: number;
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

/** A new series, or every field of one: its occurrences take its text and components. */
export const seriesInputSchema = z.object({
  componentIds: maintenanceInputSchema.shape.componentIds,
  message: messageSchema,
  recurrence: recurrenceSchema,
  title: titleSchema,
});
export type SeriesInput = z.infer<typeof seriesInputSchema>;

export const seriesEditSchema = z.object({
  id: z.string().min(1),
  input: seriesInputSchema,
});

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
  /** The series it is an occurrence of. */
  readonly seriesId?: string;
  readonly stage: MaintenanceStage;
  readonly startsAt: number;
  readonly title: Content;
}

/** One series as the list shows it. */
export interface MaintenanceSeriesItem {
  /** The affected components that still exist, in creation order. */
  readonly components: MaintenanceListItem["components"];
  readonly id: string;
  /** When its next occurrence starts: the soonest scheduled one, else the first it has yet to schedule. */
  readonly next: number;
  readonly recurrence: Recurrence;
  readonly title: Content;
}

export interface MaintenanceList {
  /** Whether any component exists: a window names the ones it affects, so none can be scheduled without one. */
  readonly anyComponent: boolean;
  /** When the server read the list, so times render the same on both sides. */
  readonly now: number;
  /** Every series, in creation order. */
  readonly series: readonly MaintenanceSeriesItem[];
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
  /** The series the window is an occurrence of. */
  readonly series?: { readonly id: string; readonly title: Content };
  readonly window: MaintenanceWindow;
}

/** What a series' page reads. */
export interface MaintenanceSeriesPage {
  /** Every component, in creation order. */
  readonly components: readonly MaintenanceComponent[];
  /** When the first occurrence it has yet to schedule starts. */
  readonly next: number;
  readonly now: number;
  /** Its occurrences in progress and scheduled, soonest first. */
  readonly occurrences: readonly MaintenanceListItem[];
  readonly series: MaintenanceSeries;
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

export type MaintenanceSeriesPageResult =
  | { readonly ok: true; readonly page: MaintenanceSeriesPage }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" }
  | Corrupt;

export type MaintenanceSeriesSaveResult =
  | { readonly ok: true; readonly series: MaintenanceSeries }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "not_found" | "unavailable";
    };

export type MaintenanceSaveResult =
  | { readonly ok: true; readonly window: MaintenanceWindow }
  | { readonly ok: false; readonly reason: MaintenanceRefusal };

export type MaintenanceDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MaintenanceRefusal };

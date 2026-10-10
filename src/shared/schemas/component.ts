/**
 * A component's shapes (CONTEXT.md "Component", "Link"):
 * something the install reports on, belonging to the install rather than
 * to a page, with its hand-set status and the monitors linked to it. The
 * hand-set status counts only while no monitor is linked and no incident
 * sets one; a linked component's status is derived.
 * The component list and form's views and results are here too, so the
 * admin never imports the server.
 */
import { z } from "zod";
import type { DisplayedUptime } from "@/shared/domain/uptime.ts";
import type { CheckResult } from "./check.ts";
import {
  type Content,
  contentSchema,
  optionalContentSchema,
} from "./content.ts";
import type { OverviewDay } from "./overview.ts";
import {
  type HandSetLevel,
  handSetLevelSchema,
  type StatusLevel,
} from "./status.ts";

export const componentNameMaxLength = 100;
export const componentDescriptionMaxLength = 500;

/** The days a component's uptime spans on the admin list. */
export const componentUptimeDays = 90;

/** The days the admin list's bar shows, the last of the uptime's. */
export const componentBarDays = 30;

export interface ComponentFields {
  /** A line a visitor reads beside the name, in each locale. */
  readonly description: Content | undefined;
  /** The linked monitors, in the monitors' creation order. */
  readonly monitorIds: readonly string[];
  /** In each locale; the install language's is required. */
  readonly name: Content;
  /** The hand-set status; stored whatever the links, shown only while none exist. */
  readonly status: HandSetLevel;
}

export interface Component extends ComponentFields {
  readonly createdAt: number;
  readonly id: string;
  readonly updatedAt: number;
}

export const componentInputSchema = z.object({
  description: optionalContentSchema(componentDescriptionMaxLength),
  // A monitor named twice is linked once.
  monitorIds: z.array(z.string().min(1)).transform((ids) => [...new Set(ids)]),
  name: contentSchema(componentNameMaxLength),
  status: handSetLevelSchema,
});
export type ComponentInput = z.infer<typeof componentInputSchema>;

export const componentEditSchema = z.object({
  id: z.string().min(1),
  input: componentInputSchema,
});

export const componentIdSchema = z.object({ id: z.string().min(1) });

/** The form's read: a stored component's, or the new form's with no id. */
export const componentFormSchema = z.object({
  id: z.string().min(1).optional(),
});

/** One component as the list shows it. */
export interface ComponentListItem {
  readonly component: Component;
  /** Its last `componentBarDays` UTC days for its bar, oldest first, today last. */
  readonly days: readonly OverviewDay[];
  /** How many status pages show it. */
  readonly pages: number;
  /** Its status now. */
  readonly status: StatusLevel;
  /** Over the last `componentUptimeDays` days; nothing with no observed time. */
  readonly uptime: DisplayedUptime | undefined;
}

/** A monitor the form offers to link. */
export interface LinkableMonitor {
  readonly id: string;
  readonly name: string;
  readonly paused: boolean;
  /** Its latest check's result; nothing before its first check. */
  readonly state: CheckResult | undefined;
  /** The URL, `host:port` or name it checks; a heartbeat monitor has none. */
  readonly target: string | undefined;
}

/** A status page that shows the component. */
export interface ShowingPage {
  readonly id: string;
  readonly title: Content;
}

/** What the component form reads: the stored component, or nothing for a new one. */
export interface ComponentForm {
  readonly component: Component | undefined;
  /** The open incidents that set the stored component's status, in creation order. */
  readonly incidents: readonly {
    readonly id: string;
    readonly title: Content;
  }[];
  /** The maintenance windows in progress that put the stored component under maintenance, in creation order. */
  readonly maintenance: readonly {
    readonly id: string;
    readonly title: Content;
  }[];
  /** Every monitor, in the order the monitors list starts from (creation). */
  readonly monitors: readonly LinkableMonitor[];
  readonly pages: readonly ShowingPage[];
  /** The stored component's status now. */
  readonly status: StatusLevel | undefined;
}

export type ComponentRefusal = "invalid" | "not_found" | "unavailable";

export type ComponentListResult =
  | { readonly ok: true; readonly components: readonly ComponentListItem[] }
  | { readonly ok: false; readonly reason: "unavailable" }
  /** A stored record this version cannot read; `id` names it. */
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string };

export type ComponentFormResult =
  | { readonly ok: true; readonly form: ComponentForm }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" }
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string };

export type ComponentSaveResult =
  | { readonly ok: true; readonly component: Component }
  | { readonly ok: false; readonly reason: ComponentRefusal };

export type ComponentDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ComponentRefusal };

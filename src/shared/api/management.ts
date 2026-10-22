/**
 * The management API's operations (CONTEXT.md "Management API"), one table:
 * each one's method and path under `/api/v1/`, the permission it needs,
 * the input it takes and the record it answers. The input is the very
 * schema the admin form posts, and the permission is the one the matching
 * server function's middleware names: `src/routes/-api.ts` answers each
 * operation by calling that server function, so the check runs once, in
 * the same code. The OpenAPI document and the website's reference are
 * written from this table, and the end-to-end suite calls every operation
 * as every role.
 */
import { z } from "zod";
import type { Permission } from "@/shared/domain/roles.ts";
import { channelInputSchema } from "@/shared/schemas/channel.ts";
import { componentInputSchema } from "@/shared/schemas/component.ts";
import {
  incidentCreateSchema,
  incidentFieldsSchema,
  incidentUpdateSchema,
  updateFixSchema,
} from "@/shared/schemas/incident.ts";
import {
  maintenanceEditInputSchema,
  maintenanceInputSchema,
  seriesInputSchema,
} from "@/shared/schemas/maintenance.ts";
import { monitorInputSchema } from "@/shared/schemas/monitor.ts";
import { pageCreateSchema, pageInputSchema } from "@/shared/schemas/page.ts";
import {
  channelDetailSchema,
  channelItemSchema,
  channelRecordSchema,
  checkAskedSchema,
  componentItemSchema,
  componentRecordSchema,
  groupRecordSchema,
  incidentItemSchema,
  incidentRecordSchema,
  maintenanceSeriesDetailSchema,
  maintenanceSeriesItemSchema,
  maintenanceSeriesRecordSchema,
  maintenanceWindowItemSchema,
  maintenanceWindowRecordSchema,
  monitorDetailSchema,
  monitorItemSchema,
  monitorRecordSchema,
  monitorTestRecordSchema,
  notificationRecordSchema,
  statusPageDetailSchema,
  statusPageItemSchema,
  statusPageRecordSchema,
} from "./records.ts";

/** Where the management API answers; every path below starts with it. */
export const managementPrefix = "/api/v1/";

/** The areas the document groups the operations by. */
export const managementTags = {
  Channels:
    "Notification channels: where a monitor's alerts go. A secret field is write-only: a read names the fields that hold one, never the value.",
  Components:
    "The things a status page reports on, each with a status derived from its linked monitors or set by hand.",
  Groups:
    "The folders monitors sit in, one level deep. A group exists while a monitor is in it.",
  Incidents: "Incidents and their updates, as a status page shows them.",
  Maintenance:
    "Maintenance windows, and the series that schedule one on each of their days.",
  Monitors:
    "The checks Raaqeb runs: create, change, pause, resume, delete, test a draft, and ask for a check now.",
  "Page management":
    "Status pages: their address, language, customization and the components they show.",
} as const;
export type ManagementTag = keyof typeof managementTags;

/** One operation of the management API. */
export interface ManagementOperation {
  /** What a success answers; nothing answers 204 with no body. */
  readonly answer?: z.ZodType;
  /** What the request body holds; nothing for an operation that takes none. */
  readonly body?: z.ZodType;
  readonly description: string;
  /** A request body the operation accepts, for the document and the website. */
  readonly example?: unknown;
  /** A list answers its records a page at a time, `answer` being one record. */
  readonly list?: true;
  readonly method: "delete" | "get" | "post" | "put";
  readonly path: string;
  /** What the matching server function's middleware names (shared/domain/roles.ts); an API key also needs its role to allow it. */
  readonly permission: Permission;
  /** The refusals beside the shared ones, each answered 409 with its reason. */
  readonly refusals?: readonly string[];
  readonly status: 200 | 201 | 202 | 204;
  readonly summary: string;
  readonly tag: ManagementTag;
}

/** The monitors a group takes in, each leaving the group it was in. */
export const groupMonitorsSchema = z.object({
  monitorIds: z.array(z.string().min(1)).min(1).max(1000),
});

/** An update's text fix: its time, stage and statuses stay. */
export const updateFixBodySchema = updateFixSchema.pick({ message: true });

const monitorExample = {
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    type: "http",
    url: "https://example.com/health",
  },
  group: "Website",
  intervalMs: 60_000,
  name: "Website",
  retries: 1,
  timeoutMs: 10_000,
};

const keptSecret =
  "A credential the body leaves out keeps the stored one, as the admin form does.";

/** Every operation, by the name its operationId is made of. */
export const managementOperations = {
  listMonitors: {
    answer: monitorItemSchema,
    description:
      "Every monitor in creation order, with its latest check's result.",
    list: true,
    method: "get",
    path: "/api/v1/monitors",
    permission: "read",
    status: 200,
    summary: "List monitors",
    tag: "Monitors",
  },
  createMonitor: {
    answer: monitorRecordSchema,
    body: monitorInputSchema,
    description:
      "Creates a monitor; its first check runs at once. The body is what the admin's monitor form saves, credentials included, which are kept sealed and never answered.",
    example: monitorExample,
    method: "post",
    path: "/api/v1/monitors",
    permission: "monitors",
    status: 201,
    summary: "Create a monitor",
    tag: "Monitors",
  },
  testMonitor: {
    answer: monitorTestRecordSchema,
    body: monitorInputSchema,
    description:
      "Runs one check of a monitor that is not saved, as the form's test does, and records nothing. It waits for the check, up to the timeout.",
    example: monitorExample,
    method: "post",
    path: "/api/v1/monitors/test",
    permission: "monitors",
    status: 200,
    summary: "Test a monitor before saving it",
    tag: "Monitors",
  },
  readMonitor: {
    answer: monitorDetailSchema,
    description:
      "One monitor, with the names of its stored credentials and, for a heartbeat monitor, its address.",
    method: "get",
    path: "/api/v1/monitors/{monitorId}",
    permission: "read",
    status: 200,
    summary: "Read a monitor",
    tag: "Monitors",
  },
  editMonitor: {
    answer: monitorDetailSchema,
    body: monitorInputSchema,
    description: `Replaces every field of the monitor with the body's, and answers the monitor as its read does. ${keptSecret}`,
    example: monitorExample,
    method: "put",
    path: "/api/v1/monitors/{monitorId}",
    permission: "monitors",
    status: 200,
    summary: "Change a monitor",
    tag: "Monitors",
  },
  deleteMonitor: {
    description:
      "Deletes the monitor and its history. Deleting one that is gone answers 204 as well.",
    method: "delete",
    path: "/api/v1/monitors/{monitorId}",
    permission: "monitors",
    status: 204,
    summary: "Delete a monitor",
    tag: "Monitors",
  },
  testStoredMonitor: {
    answer: monitorTestRecordSchema,
    body: monitorInputSchema,
    description: `Runs one check of the body's fields against a stored monitor and records nothing, as the form's test does while editing. ${keptSecret}`,
    example: monitorExample,
    method: "post",
    path: "/api/v1/monitors/{monitorId}/test",
    permission: "monitors",
    status: 200,
    summary: "Test a change to a monitor",
    tag: "Monitors",
  },
  pauseMonitor: {
    description:
      "Stops the monitor's checks; its time while paused is no data. Pausing a paused monitor changes nothing.",
    method: "post",
    path: "/api/v1/monitors/{monitorId}/pause",
    permission: "monitors",
    status: 204,
    summary: "Pause a monitor",
    tag: "Monitors",
  },
  resumeMonitor: {
    description:
      "Starts the monitor's checks again, the first at once. Resuming a running monitor changes nothing.",
    method: "post",
    path: "/api/v1/monitors/{monitorId}/resume",
    permission: "monitors",
    status: 204,
    summary: "Resume a monitor",
    tag: "Monitors",
  },
  checkMonitor: {
    answer: checkAskedSchema,
    description:
      "Runs the monitor's next check at the scheduler's next tick, as the admin's check now does, and answers before it runs.",
    method: "post",
    path: "/api/v1/monitors/{monitorId}/check",
    permission: "check_now",
    refusals: ["paused", "heartbeat"],
    status: 202,
    summary: "Check a monitor now",
    tag: "Monitors",
  },
  listGroups: {
    answer: groupRecordSchema,
    description: "Every group with its monitors, by name.",
    list: true,
    method: "get",
    path: "/api/v1/groups",
    permission: "read",
    status: 200,
    summary: "List groups",
    tag: "Groups",
  },
  addToGroup: {
    body: groupMonitorsSchema,
    description:
      "Moves the monitors into the group, making it when none has that name yet. A monitor already in it stays.",
    example: { monitorIds: ["8b2f…", "c41a…"] },
    method: "post",
    path: "/api/v1/groups/{groupName}/monitors",
    permission: "monitors",
    status: 204,
    summary: "Move monitors into a group",
    tag: "Groups",
  },
  deleteGroup: {
    description:
      "Takes every monitor out of the group, which ends it. The monitors stay. A group no monitor is in answers 204 as well.",
    method: "delete",
    path: "/api/v1/groups/{groupName}",
    permission: "monitors",
    status: 204,
    summary: "Ungroup a group's monitors",
    tag: "Groups",
  },
  listPages: {
    answer: statusPageItemSchema,
    description: "Every status page, with its status level now.",
    list: true,
    method: "get",
    path: "/api/v1/status-pages",
    permission: "read",
    status: 200,
    summary: "List status pages",
    tag: "Page management",
  },
  createPage: {
    answer: statusPageRecordSchema,
    body: pageCreateSchema,
    description:
      "Creates an unpublished status page with its title in the page language; the rest starts at its defaults.",
    example: { locale: "en", slug: "status", title: "Example status" },
    method: "post",
    path: "/api/v1/status-pages",
    permission: "pages",
    refusals: ["slug_taken"],
    status: 201,
    summary: "Create a status page",
    tag: "Page management",
  },
  readPage: {
    answer: statusPageDetailSchema,
    description:
      "One status page, with the components it shows in order and its images.",
    method: "get",
    path: "/api/v1/status-pages/{pageId}",
    permission: "read",
    status: 200,
    summary: "Read a status page",
    tag: "Page management",
  },
  editPage: {
    answer: statusPageRecordSchema,
    body: pageInputSchema,
    description:
      "Replaces every field of the page with the body's, as the page editor saves it: read the page, change what you need, and send it back whole.",
    method: "put",
    path: "/api/v1/status-pages/{pageId}",
    permission: "pages",
    refusals: ["slug_taken", "domain_taken", "domain_public_address"],
    status: 200,
    summary: "Change a status page",
    tag: "Page management",
  },
  deletePage: {
    description:
      "Deletes the page and its subscribers; the components it showed stay. Deleting one that is gone answers 204 as well.",
    method: "delete",
    path: "/api/v1/status-pages/{pageId}",
    permission: "pages",
    status: 204,
    summary: "Delete a status page",
    tag: "Page management",
  },
  listComponents: {
    answer: componentItemSchema,
    description: "Every component in creation order, with its status now.",
    list: true,
    method: "get",
    path: "/api/v1/components",
    permission: "read",
    status: 200,
    summary: "List components",
    tag: "Components",
  },
  createComponent: {
    answer: componentRecordSchema,
    body: componentInputSchema,
    description:
      "Creates a component, its name in the install language at least.",
    example: {
      monitorIds: [],
      name: { ar: "الموقع", en: "Website" },
      status: "operational",
    },
    method: "post",
    path: "/api/v1/components",
    permission: "pages",
    status: 201,
    summary: "Create a component",
    tag: "Components",
  },
  readComponent: {
    answer: componentItemSchema,
    description: "One component, with its status now.",
    method: "get",
    path: "/api/v1/components/{componentId}",
    permission: "read",
    status: 200,
    summary: "Read a component",
    tag: "Components",
  },
  editComponent: {
    answer: componentRecordSchema,
    body: componentInputSchema,
    description: "Replaces every field of the component with the body's.",
    method: "put",
    path: "/api/v1/components/{componentId}",
    permission: "pages",
    status: 200,
    summary: "Change a component",
    tag: "Components",
  },
  deleteComponent: {
    description:
      "Deletes the component from every page that shows it, with each incident and maintenance window of which it is the last affected component. Deleting one that is gone answers 204 as well.",
    method: "delete",
    path: "/api/v1/components/{componentId}",
    permission: "pages",
    status: 204,
    summary: "Delete a component",
    tag: "Components",
  },
  listIncidents: {
    answer: incidentItemSchema,
    description: "Open incidents first, then resolved ones, each newest first.",
    list: true,
    method: "get",
    path: "/api/v1/incidents",
    permission: "read",
    status: 200,
    summary: "List incidents",
    tag: "Incidents",
  },
  createIncident: {
    answer: incidentRecordSchema,
    body: incidentCreateSchema,
    description:
      "Publishes an incident with its first update, which names each affected component and the status it sets; the pages' subscribers are told.",
    example: {
      impact: "minor",
      message: { en: "We are looking into slow page loads." },
      stage: "investigating",
      statuses: [{ componentId: "3f9e…", status: "degraded_performance" }],
      title: { en: "Slow page loads" },
    },
    method: "post",
    path: "/api/v1/incidents",
    permission: "incidents",
    refusals: ["changed"],
    status: 201,
    summary: "Open an incident",
    tag: "Incidents",
  },
  readIncident: {
    answer: incidentRecordSchema,
    description: "One incident with every update, oldest first.",
    method: "get",
    path: "/api/v1/incidents/{incidentId}",
    permission: "read",
    status: 200,
    summary: "Read an incident",
    tag: "Incidents",
  },
  editIncident: {
    answer: incidentRecordSchema,
    body: incidentFieldsSchema,
    description:
      "Changes the incident's title and impact; its updates stay as they are.",
    example: { impact: "major", title: { en: "Slow page loads" } },
    method: "put",
    path: "/api/v1/incidents/{incidentId}",
    permission: "incidents",
    status: 200,
    summary: "Change an incident",
    tag: "Incidents",
  },
  deleteIncident: {
    description:
      "Deletes the incident and its updates from every page. Deleting one that is gone answers 204 as well.",
    method: "delete",
    path: "/api/v1/incidents/{incidentId}",
    permission: "incidents_delete",
    status: 204,
    summary: "Delete an incident",
    tag: "Incidents",
  },
  postUpdate: {
    answer: incidentRecordSchema,
    body: incidentUpdateSchema,
    description:
      "Adds an update: an open stage with every affected component's status, or the resolving one, which keeps the statuses on components set by hand (`keep`) or returns them to what they were. The pages' subscribers are told.",
    example: {
      message: { en: "A fix is out; we are watching." },
      stage: "monitoring",
      statuses: [{ componentId: "3f9e…", status: "operational" }],
    },
    method: "post",
    path: "/api/v1/incidents/{incidentId}/updates",
    permission: "incidents",
    refusals: ["changed", "resolved"],
    status: 201,
    summary: "Post an incident update",
    tag: "Incidents",
  },
  fixUpdate: {
    answer: incidentRecordSchema,
    body: updateFixBodySchema,
    description:
      "Corrects an update's text; its time, stage and statuses stay, and nobody is told again.",
    example: { message: { en: "A fix is out; we are watching it." } },
    method: "put",
    path: "/api/v1/incidents/{incidentId}/updates/{updateId}",
    permission: "incidents",
    status: 200,
    summary: "Fix an update's text",
    tag: "Incidents",
  },
  listMaintenance: {
    answer: maintenanceWindowItemSchema,
    description:
      "Windows in progress first, then scheduled ones soonest first, then completed ones newest first.",
    list: true,
    method: "get",
    path: "/api/v1/maintenance-windows",
    permission: "read",
    status: 200,
    summary: "List maintenance windows",
    tag: "Maintenance",
  },
  createMaintenance: {
    answer: maintenanceWindowRecordSchema,
    body: maintenanceInputSchema,
    description:
      "Schedules a window over the affected components, from its start to its end; the pages' subscribers are told.",
    example: {
      componentIds: ["3f9e…"],
      endsAt: 1_798_765_200_000,
      message: { en: "The database moves to a new server." },
      startsAt: 1_798_758_000_000,
      title: { en: "Database upgrade" },
    },
    method: "post",
    path: "/api/v1/maintenance-windows",
    permission: "maintenance",
    status: 201,
    summary: "Schedule a maintenance window",
    tag: "Maintenance",
  },
  readMaintenance: {
    answer: maintenanceWindowRecordSchema,
    description: "One maintenance window.",
    method: "get",
    path: "/api/v1/maintenance-windows/{windowId}",
    permission: "read",
    status: 200,
    summary: "Read a maintenance window",
    tag: "Maintenance",
  },
  editMaintenance: {
    answer: maintenanceWindowRecordSchema,
    body: maintenanceEditInputSchema,
    description:
      "Changes what the window's stage allows: every field while scheduled, the text and the end while in progress, the text once completed. A body with more than the stage allows is refused as `changed`.",
    method: "put",
    path: "/api/v1/maintenance-windows/{windowId}",
    permission: "maintenance",
    refusals: ["changed"],
    status: 200,
    summary: "Change a maintenance window",
    tag: "Maintenance",
  },
  endMaintenance: {
    answer: maintenanceWindowRecordSchema,
    description: "Ends a window in progress now.",
    method: "post",
    path: "/api/v1/maintenance-windows/{windowId}/end",
    permission: "maintenance",
    refusals: ["changed"],
    status: 200,
    summary: "End a maintenance window now",
    tag: "Maintenance",
  },
  cancelMaintenance: {
    description:
      "Cancels a window that has not started, and tells the pages' subscribers. A window that started is ended, not cancelled. Cancelling one that is gone answers 204 as well.",
    method: "delete",
    path: "/api/v1/maintenance-windows/{windowId}",
    permission: "maintenance",
    refusals: ["changed"],
    status: 204,
    summary: "Cancel a maintenance window",
    tag: "Maintenance",
  },
  listSeries: {
    answer: maintenanceSeriesItemSchema,
    description: "Every maintenance series, in creation order.",
    list: true,
    method: "get",
    path: "/api/v1/maintenance-series",
    permission: "read",
    status: 200,
    summary: "List maintenance series",
    tag: "Maintenance",
  },
  createSeries: {
    answer: maintenanceSeriesRecordSchema,
    body: seriesInputSchema,
    description:
      "Starts a series that schedules a window on each of its days, at its time in its time zone, for its minutes.",
    example: {
      componentIds: ["3f9e…"],
      message: { en: "Weekly updates to the servers." },
      recurrence: {
        days: { repeat: "weekly", weekdays: [0] },
        minutes: 60,
        time: "02:00",
        timeZone: "Asia/Riyadh",
      },
      title: { en: "Weekly maintenance" },
    },
    method: "post",
    path: "/api/v1/maintenance-series",
    permission: "maintenance",
    status: 201,
    summary: "Start a maintenance series",
    tag: "Maintenance",
  },
  readSeries: {
    answer: maintenanceSeriesDetailSchema,
    description:
      "One maintenance series, with its occurrences in progress and scheduled.",
    method: "get",
    path: "/api/v1/maintenance-series/{seriesId}",
    permission: "read",
    status: 200,
    summary: "Read a maintenance series",
    tag: "Maintenance",
  },
  editSeries: {
    answer: maintenanceSeriesRecordSchema,
    body: seriesInputSchema,
    description:
      "Replaces every field of the series; its scheduled occurrences take the new text, components and times.",
    method: "put",
    path: "/api/v1/maintenance-series/{seriesId}",
    permission: "maintenance",
    status: 200,
    summary: "Change a maintenance series",
    tag: "Maintenance",
  },
  endSeries: {
    description:
      "Ends the series: its scheduled occurrences are cancelled, one in progress runs to its end, and the completed ones stay. Ending one that is gone answers 204 as well.",
    method: "delete",
    path: "/api/v1/maintenance-series/{seriesId}",
    permission: "maintenance",
    status: 204,
    summary: "End a maintenance series",
    tag: "Maintenance",
  },
  listChannels: {
    answer: channelItemSchema,
    description: "Every notification channel, in creation order.",
    list: true,
    method: "get",
    path: "/api/v1/channels",
    permission: "read",
    status: 200,
    summary: "List channels",
    tag: "Channels",
  },
  createChannel: {
    answer: channelRecordSchema,
    body: channelInputSchema,
    description:
      "Creates a notification channel. `values` holds each of the type's fields by name, as the admin form names them; a secret field is sealed and never answered.",
    example: {
      appliesToNew: true,
      name: "Operations",
      type: "slack",
      values: { url: "https://hooks.slack.com/services/T000/B000/XXXX" },
    },
    method: "post",
    path: "/api/v1/channels",
    permission: "channels",
    status: 201,
    summary: "Create a channel",
    tag: "Channels",
  },
  readChannel: {
    answer: channelDetailSchema,
    description:
      "One channel, with the names of its secret fields that hold a value, never the values.",
    method: "get",
    path: "/api/v1/channels/{channelId}",
    permission: "read",
    status: 200,
    summary: "Read a channel",
    tag: "Channels",
  },
  editChannel: {
    answer: channelRecordSchema,
    body: channelInputSchema,
    description:
      "Replaces every field of the channel with the body's. A secret field the body leaves out keeps its stored value.",
    method: "put",
    path: "/api/v1/channels/{channelId}",
    permission: "channels",
    status: 200,
    summary: "Change a channel",
    tag: "Channels",
  },
  deleteChannel: {
    description:
      "Deletes the channel; the monitors that selected it stop sending to it. Deleting one that is gone answers 204 as well.",
    method: "delete",
    path: "/api/v1/channels/{channelId}",
    permission: "channels",
    status: 204,
    summary: "Delete a channel",
    tag: "Channels",
  },
  testChannel: {
    answer: notificationRecordSchema,
    description:
      "Sends the channel a test message once, as the admin's send test does, and answers how it went. It waits for the send.",
    method: "post",
    path: "/api/v1/channels/{channelId}/test",
    permission: "channels",
    status: 200,
    summary: "Send a channel a test",
    tag: "Channels",
  },
} as const satisfies Readonly<Record<string, ManagementOperation>>;

export type ManagementOperationName = keyof typeof managementOperations;

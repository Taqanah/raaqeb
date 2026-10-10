/**
 * The SQLite schema. Mirrors schema/postgres.ts table for table and
 * column for column; schema/parity.test.ts fails when the two drift. Columns
 * are the lowest common denominator of both dialects: ids and JSON as text,
 * timestamps as integer milliseconds, booleans as integers.
 */
import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** A millisecond timestamp: a Date in code, an integer in the file. */
const millis = (name: string) => integer(name, { mode: "timestamp_ms" });
/** A boolean stored as 0 or 1. */
const flag = (name: string) => integer(name, { mode: "boolean" });

/** One row per setting (CONTEXT.md "Setting"): the value is JSON text parsed with Zod at the edge. */
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** The change counter (CONTEXT.md): one row, id 1, seeded by the first migration. */
export const changeCounter = sqliteTable("change_counter", {
  id: integer().primaryKey(),
  value: integer().notNull(),
});

// Better Auth's four core tables, prefixed auth_ and written in the
// repo's column conventions. The property names are Better Auth's field names;
// the adapter maps them onto the snake_case columns. v1 holds one operator
// account (CONTEXT.md); the table is Better Auth's, so more are additive.

/** The operator account's identity row. */
export const authUser = sqliteTable("auth_user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: flag("email_verified").notNull(),
  image: text(),
  // The two-factor plugin's flag: the second step is on for this account.
  twoFactorEnabled: flag("two_factor_enabled").notNull().default(sql`0`),
  createdAt: millis("created_at").notNull(),
  updatedAt: millis("updated_at").notNull(),
});

/** One signed-in browser; 7 days, refreshed daily. */
export const authSession = sqliteTable(
  "auth_session",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: millis("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [index("auth_session_user_id").on(table.userId)]
);

/** The credential account holding the Argon2id hash; the other columns are Better Auth's OAuth shape, unused in v1. */
export const authAccount = sqliteTable(
  "auth_account",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: millis("access_token_expires_at"),
    refreshTokenExpiresAt: millis("refresh_token_expires_at"),
    scope: text(),
    idToken: text("id_token"),
    password: text(),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [index("auth_account_user_id").on(table.userId)]
);

/** One-time codes (hashed), Better Auth's core reset token, the pending second step and the trusted browsers. */
export const authVerification = sqliteTable(
  "auth_verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: millis("expires_at").notNull(),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [index("auth_verification_identifier").on(table.identifier)]
);

/**
 * The two-factor plugin's own table, in its shape: the
 * authenticator app's secret and backup codes, both encrypted, one row per
 * account, unverified until the app's first code is entered.
 */
export const authTwoFactor = sqliteTable(
  "auth_two_factor",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    secret: text().notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: flag("verified").notNull().default(sql`1`),
    failedVerificationCount: integer("failed_verification_count")
      .notNull()
      .default(0),
    lockedUntil: millis("locked_until"),
  },
  (table) => [index("auth_two_factor_user_id").on(table.userId)]
);

// Monitors, groups and tags (CONTEXT.md "Group", "Tag"). The
// check-type part of a monitor is JSON text parsed by shared/schemas/monitor.ts;
// the columns are what the list, the scheduler and the filters read by name.

/** A folder a monitor belongs to, one level deep (CONTEXT.md "Group"). */
export const groups = sqliteTable("groups", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

/** One thing Raaqeb watches (CONTEXT.md "Monitor"); the schedule in milliseconds, paused as a flag. */
export const monitors = sqliteTable(
  "monitors",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text(),
    checkType: text("check_type").notNull(),
    target: text(),
    config: text().notNull(),
    intervalMs: integer("interval_ms").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    retries: integer().notNull(),
    degradedMs: integer("degraded_ms"),
    /** Days of check history; null follows the install default. */
    retentionDays: integer("retention_days"),
    /** The HTTP credentials as one install-key ciphertext; null when there are none. */
    credentials: text(),
    /** A heartbeat monitor's token, in its unique URL; null for every other check type. */
    heartbeatToken: text("heartbeat_token"),
    /** The monitor events that notify its channels, as a JSON array of their names; existing monitors get all five. */
    events: text()
      .notNull()
      .default(
        '["down","recovered","degraded_started","degraded_ended","certificate_expiring"]'
      ),
    /** How often a reminder repeats "still down"; null is off. */
    reminderMs: integer("reminder_ms"),
    paused: flag("paused").notNull(),
    /** When the monitor was paused; null while it runs. */
    pausedAt: integer("paused_at"),
    groupId: text("group_id").references(() => groups.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("monitors_group_id").on(table.groupId),
    // An index, not a column constraint: SQLite cannot add a UNIQUE column in place, and drizzle-kit's table rebuild would cascade-delete the history inside the migration's transaction.
    uniqueIndex("monitors_heartbeat_token").on(table.heartbeatToken),
  ]
);

/** A free label attached to any number of monitors (CONTEXT.md "Tag"). */
export const tags = sqliteTable("tags", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
});

/** Which tags a monitor carries. */
export const monitorTags = sqliteTable(
  "monitor_tags",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.tagId] }),
    index("monitor_tags_tag_id").on(table.tagId),
  ]
);

// Check history (CONTEXT.md "Head table", "Failure detail", "Capture"). The head table holds the open UTC day's checks, one plain
// row each, keyed by monitor and started-at with no autonumber column; the
// migration adds WITHOUT ROWID by hand. The
// detail and the capture share the key but not a foreign key to the head
// row: sealing moves the head row out while they stay for the raw window.

/** One check as the head table stores it: the result, the reason code and the numbers. */
export const checks = sqliteTable(
  "checks",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    result: integer().notNull(),
    responseMs: integer("response_ms"),
    statusCode: integer("status_code"),
    reason: integer().notNull(),
    attempts: integer().notNull(),
    bytes: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.startedAt] })]
);

/** The record beside a down check: the failed assertion, the reason's parameters and the raw error, JSON text and text. */
export const failureDetails = sqliteTable(
  "failure_details",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    assertion: text(),
    params: text().notNull(),
    error: text(),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.startedAt] })]
);

/** The response headers as JSON text and the first 4 KB of the body as bytes, when the capture mode kept them. */
export const captures = sqliteTable(
  "captures",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    headers: text().notNull(),
    body: blob({ mode: "buffer" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.startedAt] })]
);

/** What Raaqeb knows about an HTTPS monitor's current certificate (CONTEXT.md "Certificate record"): one row per monitor, replaced when the fingerprint changes. */
export const certificateRecords = sqliteTable("certificate_records", {
  monitorId: text("monitor_id")
    .primaryKey()
    .references(() => monitors.id, { onDelete: "cascade" }),
  subject: text().notNull(),
  issuer: text().notNull(),
  validFrom: integer("valid_from").notNull(),
  validTo: integer("valid_to").notNull(),
  names: text().notNull(),
  fingerprint: text().notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  /** The last warning sent for this certificate: 0 none, 1 at the threshold, 2 at 1 day. A new fingerprint starts at 0. */
  warned: integer().notNull().default(0),
});

/** One monitor being down (CONTEXT.md "Outage"): opened by the first confirmed down check, closed by the first recovered one, never deleted by retention. */
export const outages = sqliteTable(
  "outages",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    reason: integer().notNull(),
    /** When the operator acknowledged the outage, which stops its reminders; none until then. */
    acknowledgedAt: integer("acknowledged_at"),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.startedAt] })]
);

/** One incoming call to a heartbeat monitor's unique URL (CONTEXT.md "Heartbeat"): when it arrived and from which address. Each monitor keeps its latest hundred. */
export const heartbeats = sqliteTable(
  "heartbeats",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    arrivedAt: integer("arrived_at").notNull(),
    sourceIp: text("source_ip"),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.arrivedAt] })]
);

// Sealed days and rollups (CONTEXT.md "Sealed day", "Rollup"). The nightly sealing job moves each closed UTC day of a monitor out
// of the head table into one sealed day, the packed and compressed chunk,
// and writes that day's hourly and daily rollups from the same checks.
// Observed time is in milliseconds, like every duration here.

/** One closed UTC day of one monitor's checks: the chunk (storage/chunk.ts) with the day's check count and observed time beside it. */
export const sealedDays = sqliteTable(
  "sealed_days",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    day: integer("day").notNull(),
    checks: integer().notNull(),
    observedMs: integer("observed_ms").notNull(),
    chunk: blob({ mode: "buffer" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.day] })]
);

/** One UTC hour of one monitor's checks summed: the response times are of its up and degraded checks, none when it had none. */
export const hourlyRollups = sqliteTable(
  "hourly_rollups",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    hour: integer("hour").notNull(),
    checks: integer().notNull(),
    observedMs: integer("observed_ms").notNull(),
    averageMs: integer("average_ms"),
    minMs: integer("min_ms"),
    maxMs: integer("max_ms"),
    failed: integer().notNull(),
    degraded: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.hour] })]
);

/** One UTC day of one monitor's checks summed, as the hourly rollup is. */
export const dailyRollups = sqliteTable(
  "daily_rollups",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    day: integer("day").notNull(),
    checks: integer().notNull(),
    observedMs: integer("observed_ms").notNull(),
    averageMs: integer("average_ms"),
    minMs: integer("min_ms"),
    maxMs: integer("max_ms"),
    failed: integer().notNull(),
    degraded: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.day] })]
);

// Notification channels and the queue (CONTEXT.md "Notification channel",
// "Operator notification", "Subscriber notification").
// A channel keeps the values of its fields that are not secret as JSON text
// and its secret ones as one install-key ciphertext. One table is both the
// queue and the recent sends, of channels and of subscriptions alike: a
// pending row waits for its next attempt, a finished one records how it
// went, each channel keeps its newest fifty finished rows and each
// subscription its newest two.

/** A destination the install owns: its type, its fields, its channel language (null follows the install language) and whether new monitors start with it. */
export const channels = sqliteTable("channels", {
  id: text().primaryKey(),
  name: text().notNull(),
  type: text().notNull(),
  config: text().notNull(),
  /** The secret fields as one install-key ciphertext; null when the type has none. */
  credentials: text(),
  locale: text(),
  appliesToNew: flag("applies_to_new").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Which channels a monitor selects. */
export const monitorChannels = sqliteTable(
  "monitor_channels",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.channelId] }),
    index("monitor_channels_channel_id").on(table.channelId),
  ]
);

/** One notification for one channel or one subscription, never both: its payload, where it stands, and the last attempt's failure as a reason code with its parameters and text. */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text().primaryKey(),
    channelId: text("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    subscriptionId: text("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    kind: text().notNull(),
    payload: text().notNull(),
    status: text().notNull(),
    attempts: integer().notNull(),
    queuedAt: integer("queued_at").notNull(),
    nextAttemptAt: integer("next_attempt_at"),
    finishedAt: integer("finished_at"),
    reason: integer(),
    failure: text(),
  },
  (table) => [
    index("notifications_due").on(table.status, table.nextAttemptAt),
    index("notifications_channel").on(table.channelId, table.queuedAt),
    index("notifications_subscription").on(
      table.subscriptionId,
      table.queuedAt
    ),
    check(
      "notifications_target",
      sql`(${table.channelId} IS NULL) <> (${table.subscriptionId} IS NULL)`
    ),
  ]
);

// Components and status pages (CONTEXT.md "Component", "Link", "Status
// page", "Component group"). A component belongs to the
// install; a page shows components in its own order and groups, one level
// deep, groups and ungrouped components sharing one top-level order. A
// page's customization is one JSON text value parsed by
// shared/schemas/page.ts; its logo, favicon and cover are rows of their
// own, so reading a page never reads an image.

/** Something the install reports on: its hand-set status, which counts only while no monitor is linked. */
export const components = sqliteTable("components", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  status: text().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Which monitors drive a component's status (CONTEXT.md "Link"). */
export const componentMonitors = sqliteTable(
  "component_monitors",
  {
    componentId: text("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "cascade" }),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.componentId, table.monitorId] }),
    index("component_monitors_monitor_id").on(table.monitorId),
  ]
);

/** A public page: its slug, page language, custom domain, whether it is the default, whether it is published, and its customization as JSON text. */
export const statusPages = sqliteTable(
  "status_pages",
  {
    id: text().primaryKey(),
    slug: text().notNull().unique(),
    title: text().notNull(),
    locale: text().notNull(),
    customDomain: text("custom_domain").unique(),
    isDefault: flag("is_default").notNull(),
    // Public only once published; a new page starts unpublished, and the migration published the pages that existed.
    published: flag("published").notNull().default(sql`0`),
    customization: text().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // At most one default page: the database refuses a second.
    uniqueIndex("status_pages_default")
      .on(table.isDefault)
      .where(sql`"is_default" = 1`),
  ]
);

/** A one-level folder of components on one page, placed in the page's top-level order. */
export const componentGroups = sqliteTable(
  "component_groups",
  {
    id: text().primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    name: text().notNull(),
    position: integer().notNull(),
  },
  (table) => [index("component_groups_page_id").on(table.pageId)]
);

/** A component a page shows: in a group ordered inside it, or at the top level in the order groups share. */
export const pageComponents = sqliteTable(
  "page_components",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    componentId: text("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => componentGroups.id, {
      onDelete: "cascade",
    }),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pageId, table.componentId] }),
    index("page_components_component_id").on(table.componentId),
  ]
);

/** A page's logo, favicon or cover image: its bytes and the SHA-256 its URL carries. */
export const pageImages = sqliteTable(
  "page_images",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    contentType: text("content_type").notNull(),
    body: blob({ mode: "buffer" }).notNull(),
    hash: text().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pageId, table.kind] })]
);

/** A human-written record of a problem (CONTEXT.md "Incident"); `resolved_at` is its resolving update's time, null while it is open. */
export const incidents = sqliteTable("incidents", {
  id: text().primaryKey(),
  title: text().notNull(),
  impact: text().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  resolvedAt: integer("resolved_at"),
});

/** One timestamped message on an incident with the stage it moves to (CONTEXT.md "Incident update"); its author is the operator's email when written. */
export const incidentUpdates = sqliteTable(
  "incident_updates",
  {
    id: text().primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    stage: text().notNull(),
    message: text().notNull(),
    author: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("incident_updates_incident_id").on(table.incidentId)]
);

/** The status one update set on one affected component. The update that first names a component also keeps the status the page showed for it just before; null on any other update and on rows written before. */
export const incidentStatuses = sqliteTable(
  "incident_statuses",
  {
    updateId: text("update_id")
      .notNull()
      .references(() => incidentUpdates.id, { onDelete: "cascade" }),
    componentId: text("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "cascade" }),
    status: text().notNull(),
    statusBefore: text("status_before"),
  },
  (table) => [
    primaryKey({ columns: [table.updateId, table.componentId] }),
    index("incident_statuses_component_id").on(table.componentId),
  ]
);

/** A scheduled period during which its components show under maintenance (CONTEXT.md "Maintenance window"); only the scheduler moves `stage`. */
export const maintenanceWindows = sqliteTable("maintenance_windows", {
  id: text().primaryKey(),
  title: text().notNull(),
  message: text().notNull(),
  startsAt: integer("starts_at").notNull(),
  endsAt: integer("ends_at").notNull(),
  stage: text().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A component a maintenance window affects. */
export const maintenanceComponents = sqliteTable(
  "maintenance_components",
  {
    windowId: text("window_id")
      .notNull()
      .references(() => maintenanceWindows.id, { onDelete: "cascade" }),
    componentId: text("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.windowId, table.componentId] }),
    index("maintenance_components_component_id").on(table.componentId),
  ]
);

/** One subscriber tied to one status page through one channel (CONTEXT.md "Subscription"): the email address, or for a webhook the SHA-256 of its URL with the URL sealed by the install key; the locale of the address it signed up from; and the token in its links, in clear, since every message repeats it. */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text().primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    channel: text().notNull(),
    address: text().notNull(),
    credentials: text(),
    locale: text().notNull(),
    token: text().notNull(),
    status: text().notNull(),
    requestedAt: integer("requested_at").notNull(),
    confirmedAt: integer("confirmed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("subscriptions_token").on(table.token),
    uniqueIndex("subscriptions_address").on(
      table.pageId,
      table.channel,
      table.address
    ),
  ]
);

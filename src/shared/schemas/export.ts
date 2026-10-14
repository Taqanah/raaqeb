/**
 * The export file (CONTEXT.md "Export", "Import"): `raaqeb-export.jsonl.zst`, JSON Lines compressed with zstd. The
 * first line is the header with the install's configuration, one list per
 * stored table in the table's own columns; in the full mode each following
 * line is one record of history, tagged with its kind and its monitor. The
 * schemas here are codecs: decoding a line gives what storage holds (times
 * in UTC milliseconds, flags as 0 or 1, JSON columns as text, bytes as
 * bytes), and encoding it back gives the file's JSON (times as ISO 8601,
 * flags as booleans, JSON columns as values, bytes as base64). Credentials
 * are in clear in the file and sealed only in storage; the export and
 * import modules move them across.
 */
import { z } from "zod";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { channelTypeSchema } from "./channel.ts";
import { checkResults } from "./check.ts";
import { contentSchema } from "./content.ts";
import { credentialsSchema } from "./credentials.ts";
import { chartRangeSchema } from "./detail.ts";
import { impactLevelSchema, incidentStageSchema } from "./incident.ts";
import { maintenanceStageSchema } from "./maintenance.ts";
import {
  checkTypeSchema,
  monitorConfigSchema,
  monitorEventKinds,
  monitorFieldsSchema,
} from "./monitor.ts";
import {
  pageCustomizationSchema,
  pageImageKindSchema,
  subscriptionChannels,
} from "./page.ts";
import { reasonNameSchema } from "./reason.ts";
import { statusLevelSchema } from "./status.ts";
import { subscriptionStatusSchema } from "./subscription.ts";

/** The file's name, which the download carries. */
export const exportFileName = "raaqeb-export.jsonl.zst";

/** The format this version writes; an importer refuses any other. Raise it with any change to the file's shape (ADR-0011). */
export const exportVersion = 1;

/** The full mode carries the history after the header; the configuration mode is the header alone. */
export const exportModes = ["full", "configuration"] as const;
export const exportModeSchema = z.enum(exportModes);
export type ExportMode = z.infer<typeof exportModeSchema>;

/** The settings that travel; the rest belong to the install they were set on. */
export const travellingSettings = [
  "install_language",
  "time_zone",
  "clock",
  "calendar",
  "appearance_theme",
  "appearance_font_size",
  "appearance_density",
  "appearance_radius",
  "retention_days",
  "size_budget_bytes",
  "release_check_enabled",
] as const;
export type TravellingSetting = (typeof travellingSettings)[number];

/** A moment: ISO 8601 in the file, UTC milliseconds in storage. */
export const timeCodec = z.codec(
  z.iso.datetime({ offset: true }),
  z.number().int(),
  {
    decode: (text) => Date.parse(text),
    encode: (ms) => new Date(ms).toISOString(),
  }
);

/** A flag: a boolean in the file, 0 or 1 in storage. */
const flagCodec = z.codec(z.boolean(), z.number().int().min(0).max(1), {
  decode: (flag) => (flag ? 1 : 0),
  encode: (stored) => stored === 1,
});

/** Bytes: base64 in the file, bytes in storage. */
const bytesCodec = z.codec(z.base64(), z.instanceof(Uint8Array), {
  decode: (text) => Uint8Array.fromBase64(text),
  encode: (bytes) => bytes.toBase64(),
});

/**
 * A JSON column: its value in the file, the value's JSON text in storage.
 * The value is checked against the column's own schema and stored as it
 * came, never as the schema would rewrite it, so the file round-trips.
 */
function jsonTextCodec(schema: z.ZodType) {
  return z.codec(z.json(), z.string(), {
    decode: (value, context) => {
      if (!schema.safeParse(value).success) {
        context.issues.push({
          code: "custom",
          input: value,
          message: "the value does not fit its column",
        });
      }
      return JSON.stringify(value);
    },
    encode: (text) => JSON.parse(text),
  });
}

const id = z.string().min(1);
const count = z.number().int().min(0);
const plain = z.string();
/** Content: one text per locale, an object in the file and its JSON text in storage; one with no text in any locale refuses the line. */
const content = jsonTextCodec(contentSchema(Number.MAX_SAFE_INTEGER));
/** A monitor's numbers take the bounds its form takes, so an import cannot store one the form would refuse. */
const monitorFields = monitorFieldsSchema.shape;

/** A channel's values, or its secret ones: field name to value. */
const channelValuesSchema = z.record(z.string(), z.string());

/** Every stored table the configuration carries, in the order an import writes them, each row in its table's own columns. */
export const configurationSchema = z.object({
  settings: z.array(
    z.object({
      key: z.enum(travellingSettings),
      value: z.codec(z.json(), z.string(), {
        decode: (value) => JSON.stringify(value),
        encode: (stored) => JSON.parse(stored),
      }),
      updatedAt: timeCodec,
    })
  ),
  groups: z.array(z.object({ id, name: plain, createdAt: timeCodec })),
  tags: z.array(z.object({ id, name: plain })),
  channels: z.array(
    z.object({
      id,
      name: plain,
      type: channelTypeSchema,
      config: jsonTextCodec(channelValuesSchema),
      credentials: jsonTextCodec(channelValuesSchema).nullable(),
      locale: localeSchema.nullable(),
      appliesToNew: flagCodec,
      createdAt: timeCodec,
      updatedAt: timeCodec,
    })
  ),
  monitors: z.array(
    z.object({
      id,
      name: plain,
      description: plain.nullable(),
      checkType: checkTypeSchema,
      target: plain.nullable(),
      config: jsonTextCodec(monitorConfigSchema),
      intervalMs: monitorFields.intervalMs,
      timeoutMs: monitorFields.timeoutMs,
      retries: monitorFields.retries,
      degradedMs: monitorFields.degradedMs.unwrap().nullable(),
      retentionDays: monitorFields.retentionDays.unwrap().nullable(),
      credentials: jsonTextCodec(credentialsSchema).nullable(),
      heartbeatToken: plain.nullable(),
      events: jsonTextCodec(z.array(z.enum(monitorEventKinds))),
      reminderMs: monitorFields.reminderMs.unwrap().nullable(),
      paused: flagCodec,
      pausedAt: timeCodec.nullable(),
      groupId: id.nullable(),
      createdAt: timeCodec,
      updatedAt: timeCodec,
    })
  ),
  monitorTags: z.array(z.object({ monitorId: id, tagId: id })),
  monitorChannels: z.array(z.object({ monitorId: id, channelId: id })),
  components: z.array(
    z.object({
      id,
      name: content,
      description: content.nullable(),
      status: statusLevelSchema,
      createdAt: timeCodec,
      updatedAt: timeCodec,
    })
  ),
  componentMonitors: z.array(z.object({ componentId: id, monitorId: id })),
  statusPages: z.array(
    z.object({
      id,
      slug: plain,
      title: content,
      locale: localeSchema,
      customDomain: plain.nullable(),
      isDefault: flagCodec,
      // An export written before the switch has none, and its pages were public: they read as published.
      published: flagCodec.default(1),
      customization: jsonTextCodec(pageCustomizationSchema),
      createdAt: timeCodec,
      updatedAt: timeCodec,
    })
  ),
  componentGroups: z.array(
    z.object({ id, pageId: id, name: content, position: count })
  ),
  pageComponents: z.array(
    z.object({
      pageId: id,
      componentId: id,
      groupId: id.nullable(),
      position: count,
    })
  ),
  pageImages: z.array(
    z.object({
      pageId: id,
      kind: pageImageKindSchema,
      contentType: plain,
      body: bytesCodec,
      hash: plain,
      updatedAt: timeCodec,
    })
  ),
  incidents: z.array(
    z.object({
      id,
      title: content,
      impact: impactLevelSchema,
      createdAt: timeCodec,
      updatedAt: timeCodec,
      resolvedAt: timeCodec.nullable(),
    })
  ),
  incidentUpdates: z.array(
    z.object({
      id,
      incidentId: id,
      stage: incidentStageSchema,
      message: content,
      author: plain,
      createdAt: timeCodec,
    })
  ),
  incidentStatuses: z.array(
    z.object({
      updateId: id,
      componentId: id,
      status: statusLevelSchema,
      // An export written before Raaqeb kept it has none: it reads as unknown.
      statusBefore: statusLevelSchema.nullable().default(null),
    })
  ),
  maintenanceWindows: z.array(
    z.object({
      id,
      title: content,
      message: content,
      startsAt: timeCodec,
      endsAt: timeCodec,
      stage: maintenanceStageSchema,
      createdAt: timeCodec,
      updatedAt: timeCodec,
    })
  ),
  maintenanceComponents: z.array(z.object({ windowId: id, componentId: id })),
  subscriptions: z.array(
    z.object({
      id,
      pageId: id,
      channel: z.enum(subscriptionChannels),
      // The email address, or the SHA-256 of the webhook's URL, which an import computes again.
      address: plain,
      // The webhook's URL, in clear in the file.
      credentials: plain.nullable(),
      locale: localeSchema,
      token: plain,
      status: subscriptionStatusSchema,
      requestedAt: timeCodec,
      confirmedAt: timeCodec.nullable(),
      createdAt: timeCodec,
    })
  ),
});

/** The configuration as storage holds it: what `configurationSchema` decodes to. */
export type Configuration = z.output<typeof configurationSchema>;
export type ConfigurationTable = keyof Configuration;

/** The first line of the file. */
export const headerSchema = z.object({
  raaqeb: z.literal("export"),
  version: z.literal(exportVersion),
  mode: exportModeSchema,
  exportedAt: timeCodec,
  configuration: configurationSchema,
});
export type Header = z.output<typeof headerSchema>;

/** The version a first line names, read before the rest of it, so a file of another version is refused as such. */
export const versionProbeSchema = z.object({
  raaqeb: z.literal("export"),
  version: z.number(),
});

const rollupFields = {
  monitor: id,
  at: timeCodec,
  checks: count,
  observedMs: count,
  averageMs: count.nullable(),
  minMs: count.nullable(),
  maxMs: count.nullable(),
  failed: count,
  degraded: count,
};

/** One line of history: a check (sealed days decoded), an hourly or daily rollup, or an outage. */
export const recordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check"),
    monitor: id,
    at: timeCodec,
    result: z.enum(checkResults),
    responseMs: count.nullable(),
    statusCode: count.nullable(),
    reason: reasonNameSchema,
    attempts: count,
    bytes: count,
  }),
  z.object({ kind: z.literal("hourly"), ...rollupFields }),
  z.object({ kind: z.literal("daily"), ...rollupFields }),
  z.object({
    kind: z.literal("outage"),
    monitor: id,
    startedAt: timeCodec,
    endedAt: timeCodec.nullable(),
    reason: reasonNameSchema,
    // An export written before Raaqeb kept it has none: the outage reads as not acknowledged.
    acknowledgedAt: timeCodec.nullable().default(null),
  }),
]);
export type ExportRecord = z.output<typeof recordSchema>;

/** Why an import was refused. */
export const importRefusals = [
  "not_empty",
  "invalid",
  "version",
  "line_too_large",
  "unavailable",
] as const;
export type ImportRefusal = (typeof importRefusals)[number];

/** What `POST /admin/import` answers: what was imported, or why nothing was, with the line that failed when one did. */
export const importAnswerSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    monitors: count,
    pages: count,
    records: count,
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(importRefusals),
    line: z.number().int().min(1).optional(),
  }),
]);
export type ImportAnswer = z.infer<typeof importAnswerSchema>;

/** The download of one monitor's history: the export's records of it over one of the chart's ranges. */
export const historyDownloadSearchSchema = z.object({
  from: z.coerce.number().int().nonnegative().optional().catch(undefined),
  range: chartRangeSchema.catch("24h"),
  to: z.coerce.number().int().nonnegative().optional().catch(undefined),
});

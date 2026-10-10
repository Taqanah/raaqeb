import { describe, expect, test } from "bun:test";
import {
  type Configuration,
  configurationSchema,
  exportFileName,
  headerSchema,
  recordSchema,
  versionProbeSchema,
} from "./export.ts";

const empty: Configuration = {
  channels: [],
  componentGroups: [],
  componentMonitors: [],
  components: [],
  groups: [],
  incidentStatuses: [],
  incidentUpdates: [],
  incidents: [],
  maintenanceComponents: [],
  maintenanceWindows: [],
  monitorChannels: [],
  monitorTags: [],
  monitors: [],
  pageComponents: [],
  pageImages: [],
  settings: [],
  statusPages: [],
  subscriptions: [],
  tags: [],
};

const monitor: Configuration["monitors"][number] = {
  checkType: "tcp",
  config: '{"host":"db.example.test","port":5432,"type":"tcp"}',
  createdAt: Date.UTC(2026, 8, 1, 10, 30, 0, 125),
  credentials: null,
  degradedMs: null,
  description: null,
  events: '["down","recovered"]',
  groupId: null,
  heartbeatToken: null,
  id: "0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b",
  intervalMs: 60_000,
  name: "Database",
  paused: 1,
  pausedAt: Date.UTC(2026, 8, 2),
  reminderMs: null,
  retentionDays: null,
  retries: 0,
  target: "db.example.test:5432",
  timeoutMs: 10_000,
  updatedAt: Date.UTC(2026, 8, 2),
};

describe("the export file's format", () => {
  test("the file is JSON Lines under zstd", () => {
    expect(exportFileName).toBe("raaqeb-export.jsonl.zst");
  });

  test("the file writes times as ISO 8601 in UTC with milliseconds, flags as booleans, JSON columns as values and bytes as base64", () => {
    const file = configurationSchema.encode({
      ...empty,
      monitors: [monitor],
      pageImages: [
        {
          body: new Uint8Array([1, 2, 3]),
          contentType: "image/png",
          hash: "abc",
          kind: "logo",
          pageId: "p",
          updatedAt: Date.UTC(2026, 8, 3),
        },
      ],
    });
    expect(file.monitors[0]).toMatchObject({
      config: { host: "db.example.test", port: 5432, type: "tcp" },
      createdAt: "2026-09-01T10:30:00.125Z",
      events: ["down", "recovered"],
      paused: true,
      pausedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(file.pageImages[0]?.body).toBe("AQID");
  });

  test("a configuration read back from the file is what storage held", () => {
    const stored = { ...empty, monitors: [monitor] };
    const file = JSON.parse(JSON.stringify(configurationSchema.encode(stored)));
    expect(configurationSchema.parse(file)).toEqual(stored);
  });

  test("a status page carries whether it is published, and a page in an export written before the switch reads as published", () => {
    const page: Configuration["statusPages"][number] = {
      createdAt: Date.UTC(2026, 8, 1),
      customDomain: null,
      customization: "{}",
      id: "p",
      isDefault: 1,
      locale: "ar",
      published: 0,
      slug: "main",
      title: JSON.stringify({ ar: "الرئيسية" }),
      updatedAt: Date.UTC(2026, 8, 1),
    };
    const file = JSON.parse(
      JSON.stringify(
        configurationSchema.encode({ ...empty, statusPages: [page] })
      )
    );
    expect(file.statusPages[0].published).toBe(false);
    expect(configurationSchema.parse(file).statusPages[0]?.published).toBe(0);
    file.statusPages[0].published = undefined;
    expect(configurationSchema.parse(file).statusPages[0]?.published).toBe(1);
  });

  test("content travels as one text per locale, and content with no text in any locale refuses the line", () => {
    const component = {
      createdAt: Date.UTC(2026, 8, 1),
      description: null,
      id: "c",
      name: JSON.stringify({ ar: "الموقع", en: "Website" }),
      status: "operational" as const,
      updatedAt: Date.UTC(2026, 8, 1),
    };
    const file = JSON.parse(
      JSON.stringify(
        configurationSchema.encode({ ...empty, components: [component] })
      )
    );
    expect(file.components[0].name).toEqual({ ar: "الموقع", en: "Website" });
    expect(configurationSchema.parse(file).components[0]?.name).toBe(
      component.name
    );
    for (const name of [{}, { ar: " " }]) {
      file.components[0].name = name;
      expect(configurationSchema.safeParse(file).success).toBe(false);
    }
  });

  test("a JSON column whose value does not fit its schema refuses the line", () => {
    const file = JSON.parse(
      JSON.stringify(
        configurationSchema.encode({ ...empty, monitors: [monitor] })
      )
    );
    file.monitors[0].config = { port: "not a port", type: "tcp" };
    expect(configurationSchema.safeParse(file).success).toBe(false);
  });

  test("only the settings that travel may be in the file", () => {
    const setting = (key: string) => ({
      ...configurationSchema.encode(empty),
      settings: [{ key, updatedAt: "2026-09-01T00:00:00.000Z", value: "x" }],
    });
    expect(configurationSchema.safeParse(setting("time_zone")).success).toBe(
      true
    );
    for (const key of [
      "public_address",
      "better_auth_secrets",
      "operator_language",
      "auth_email_channel",
      "auth_email_tested",
      "release_check_result",
    ]) {
      expect(configurationSchema.safeParse(setting(key)).success).toBe(false);
    }
  });

  test("a header of another version is not this format, though its version can still be read", () => {
    const other = {
      configuration: configurationSchema.encode(empty),
      exportedAt: "2026-09-28T12:00:00.000Z",
      mode: "full",
      raaqeb: "export",
      version: 2,
    };
    expect(headerSchema.safeParse(other).success).toBe(false);
    expect(versionProbeSchema.parse(other).version).toBe(2);
  });

  test("a check record names its result and reason by name and its time in ISO 8601", () => {
    const line = {
      at: "2026-09-28T11:40:00.000Z",
      attempts: 2,
      bytes: 0,
      kind: "check",
      monitor: "m",
      reason: "timeout",
      responseMs: 10_000,
      result: "down",
      statusCode: null,
    } as const;
    const record = recordSchema.parse(line);
    expect(record).toMatchObject({ at: Date.UTC(2026, 8, 28, 11, 40) });
    expect(recordSchema.encode(record)).toEqual(line);
    expect(
      recordSchema.safeParse({ ...line, reason: "no such reason" }).success
    ).toBe(false);
  });

  test("hourly, daily and outage records carry their own fields", () => {
    const rollup = {
      at: "2026-08-18T00:00:00.000Z",
      averageMs: 150,
      checks: 3,
      degraded: 1,
      failed: 1,
      kind: "hourly",
      maxMs: 220,
      minMs: 100,
      monitor: "m",
      observedMs: 3_600_000,
    };
    expect(recordSchema.safeParse(rollup).success).toBe(true);
    expect(recordSchema.safeParse({ ...rollup, kind: "daily" }).success).toBe(
      true
    );
    expect(
      recordSchema.safeParse({
        endedAt: null,
        kind: "outage",
        monitor: "m",
        reason: "dns_failed",
        startedAt: "2026-09-28T11:55:00.000Z",
      }).success
    ).toBe(true);
    expect(recordSchema.safeParse({ ...rollup, kind: "weekly" }).success).toBe(
      false
    );
  });

  test("an outage carries when it was acknowledged; one from a file written before Raaqeb kept it reads as not acknowledged", () => {
    const outage = {
      endedAt: null,
      kind: "outage",
      monitor: "m",
      reason: "dns_failed",
      startedAt: "2026-09-28T11:55:00.000Z",
    };
    expect(recordSchema.parse(outage)).toMatchObject({ acknowledgedAt: null });
    expect(
      recordSchema.parse({
        ...outage,
        acknowledgedAt: "2026-09-28T12:00:00.000Z",
      })
    ).toMatchObject({ acknowledgedAt: Date.parse("2026-09-28T12:00:00.000Z") });
  });
});

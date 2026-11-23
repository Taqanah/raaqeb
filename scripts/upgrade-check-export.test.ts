import { describe, expect, test } from "bun:test";
import {
  type Configuration,
  exportVersion,
  headerSchema,
} from "@/shared/schemas/export.ts";
import {
  differences,
  type ExportLine,
  inventory,
  migrationNote,
  migrationProblems,
  shiftTimes,
  upgradeDifferences,
} from "./upgrade-check-export.ts";

const hour = 3_600_000;
const noon = "2026-09-28T12:00:00.000Z";

function header(
  configuration: Record<string, unknown[]>,
  exportedAt = noon
): ExportLine {
  return {
    configuration,
    exportedAt,
    mode: "full",
    raaqeb: "export",
    version: 1,
  };
}

const api = {
  credentials: '{"url":"postgres://u:hunter2@db/x"}',
  id: "m1",
  intervalMs: 60_000,
  name: "API",
};

const check = {
  at: "2026-09-28T09:00:00.000Z",
  kind: "check",
  monitor: "m1",
  result: "up",
};

describe("the seed's moments", () => {
  test("every moment of the header and of each record of history moves by the delta", () => {
    const [moved, record] = shiftTimes(
      [
        header({ monitors: [{ ...api, createdAt: noon }] }),
        { ...check, at: noon },
      ],
      2 * hour
    );
    expect(moved).toEqual(
      header(
        { monitors: [{ ...api, createdAt: "2026-09-28T14:00:00.000Z" }] },
        "2026-09-28T14:00:00.000Z"
      )
    );
    expect(record).toEqual({ ...check, at: "2026-09-28T14:00:00.000Z" });
  });

  test("a moment inside a nested value moves, and text that is no moment and every number stay", () => {
    const [moved] = shiftTimes(
      [
        {
          list: [{ at: noon }, "2026-09-28", "at 2026-09-28T12:00:00.000Z"],
          n: 1_790_000_000_000,
        },
      ],
      hour
    );
    expect(moved).toEqual({
      list: [
        { at: "2026-09-28T13:00:00.000Z" },
        "2026-09-28",
        "at 2026-09-28T12:00:00.000Z",
      ],
      n: 1_790_000_000_000,
    });
  });

  test("a moment written without fractions of a second or with an offset moves too", () => {
    expect(
      shiftTimes(
        [{ a: "2026-09-28T12:00:00Z", b: "2026-09-28T15:00:00+03:00" }],
        hour
      )
    ).toEqual([
      { a: "2026-09-28T13:00:00.000Z", b: "2026-09-28T13:00:00.000Z" },
    ]);
  });

  test("the lines it was given are not changed", () => {
    const lines = [{ at: noon }];
    shiftTimes(lines, hour);
    expect(lines).toEqual([{ at: noon }]);
  });
});

describe("what differs between the exports of one install", () => {
  const before = [
    header({
      monitorTags: [{ monitorId: "m1", tagId: "t1" }],
      monitors: [api],
      settings: [{ key: "clock", value: "24h" }],
    }),
    check,
    { ...check, at: "2026-09-28T09:20:00.000Z" },
  ];

  test("nothing differs when only the time of the export and the order of the rows do", () => {
    const [first, ...history] = before;
    expect(
      differences(before, [
        { ...first, exportedAt: "2026-10-09T00:00:00.000Z" },
        ...history.toReversed(),
      ])
    ).toEqual([]);
  });

  test("a monitor missing after the upgrade is named by its table and id", () => {
    const [first, ...history] = before;
    const gone = header({
      monitorTags: [{ monitorId: "m1", tagId: "t1" }],
      monitors: [],
      settings: [{ key: "clock", value: "24h" }],
    });
    expect(differences(before, [{ ...first, ...gone }, ...history])).toEqual([
      "monitors m1 is missing after the upgrade",
    ]);
  });

  test("a row that appears after the upgrade is named", () => {
    const [first, ...history] = before;
    const more = header({
      monitorTags: [{ monitorId: "m1", tagId: "t1" }],
      monitors: [api, { id: "m2" }],
      settings: [{ key: "clock", value: "24h" }],
    });
    expect(differences(before, [{ ...first, ...more }, ...history])).toEqual([
      "monitors m2 appeared after the upgrade",
    ]);
  });

  test("a changed row names the fields that differ and never their values", () => {
    const [first, ...history] = before;
    const changed = header({
      monitorTags: [{ monitorId: "m1", tagId: "t1" }],
      monitors: [
        { ...api, credentials: '{"url":"postgres://u:other@db/x"}', name: "B" },
      ],
      settings: [{ key: "clock", value: "24h" }],
    });
    const found = differences(before, [{ ...first, ...changed }, ...history]);
    expect(found).toEqual(["monitors m1 changed: credentials, name"]);
    expect(found.join()).not.toContain("hunter2");
  });

  test("the fields of a changed row are listed in alphabetical order whatever the order in the row", () => {
    const [first, ...history] = before;
    const rows = (monitor: Record<string, unknown>) => [
      { ...first, ...header({ monitors: [monitor] }) },
      ...history,
    ];
    expect(
      differences(
        rows({ name: "A", intervalMs: 1, id: "m1", credentials: "x" }),
        rows({ name: "B", intervalMs: 2, id: "m1", credentials: "y" })
      )
    ).toEqual(["monitors m1 changed: credentials, intervalMs, name"]);
  });

  test("a row of a join table has no id, so it is named by what it holds", () => {
    const [first, ...history] = before;
    const without = header({
      monitorTags: [],
      monitors: [api],
      settings: [{ key: "clock", value: "24h" }],
    });
    expect(differences(before, [{ ...first, ...without }, ...history])).toEqual(
      [
        'monitorTags {"monitorId":"m1","tagId":"t1"} is missing after the upgrade',
      ]
    );
  });

  test("a setting is named by its key", () => {
    const [first, ...history] = before;
    const other = header({
      monitorTags: [{ monitorId: "m1", tagId: "t1" }],
      monitors: [api],
      settings: [{ key: "clock", value: "12h" }],
    });
    expect(differences(before, [{ ...first, ...other }, ...history])).toEqual([
      "settings clock changed: value",
    ]);
  });

  test("a check missing from a monitor's history is named by its kind, monitor and moment", () => {
    expect(differences(before, before.slice(0, 2))).toEqual([
      "check m1 2026-09-28T09:20:00.000Z is missing after the upgrade",
    ]);
  });

  test("an outage that ends differently names the field", () => {
    const outage = {
      acknowledgedAt: null,
      endedAt: null,
      kind: "outage",
      monitor: "m1",
      reason: "timeout",
      startedAt: noon,
    };
    expect(
      differences(
        [...before, outage],
        [...before, { ...outage, acknowledgedAt: noon }]
      )
    ).toEqual(["outage m1 2026-09-28T12:00:00.000Z changed: acknowledgedAt"]);
  });

  test("a different export format or mode is named", () => {
    const [first, ...history] = before;
    expect(
      differences(before, [
        { ...first, mode: "configuration", version: 2 },
        ...history,
      ])
    ).toEqual(["the header's mode, version changed"]);
  });

  const image = {
    contentType: "image/png",
    body: "iVBORw0KGgo=",
    hash: "h1",
    updatedAt: noon,
  };
  const logo = { ...image, image: "logo", kind: "image", page: "p1" };
  const cover = { ...logo, image: "cover" };

  test("a page image on a line of its own is the header's page image row it replaced", () => {
    const [first, ...history] = before;
    expect(
      differences(
        [
          {
            ...first,
            configuration: {
              // In the order the export writes a row's fields.
              pageImages: [{ pageId: "p1", kind: "logo", ...image }],
            },
          },
          ...history,
        ],
        [{ ...first, configuration: { pageImages: [] } }, ...history, logo]
      )
    ).toEqual([]);
  });

  test("a page image line missing after the upgrade is named by its page and kind", () => {
    expect(differences([...before, logo, cover], [...before, cover])).toEqual([
      'pageImages {"pageId":"p1","kind":"logo","contentType":"image/png","body":"iVBORw0KGgo=","hash":"h1","updatedAt":"2026-09-28T12:00:00.000Z"} is missing after the upgrade',
    ]);
  });
});

describe("what a start logs of the database", () => {
  test("a database migrated forward is read as the version it found, the migrations applied and the version it left", () => {
    expect(
      migrationNote(
        "raaqeb: listening\nraaqeb: database is Raaqeb at version 12; migrated forward by 2 to 14\n"
      )
    ).toEqual({ applied: 2, from: 12, to: 14 });
  });

  test("a database with nothing to migrate is read as the same version before and after", () => {
    expect(
      migrationNote(
        "raaqeb: database is Raaqeb at version 14; nothing to migrate"
      )
    ).toEqual({ applied: 0, from: 14, to: 14 });
  });

  test("a start that logged no note on the database has none", () => {
    expect(migrationNote("raaqeb: listening")).toBeUndefined();
  });
});

describe("whether the migrations ran once", () => {
  const first =
    "raaqeb: database is Raaqeb at version 12; migrated forward by 2 to 14";
  const settled =
    "raaqeb: database is Raaqeb at version 14; nothing to migrate";

  test("a first start that migrated and a next start that found nothing to do are no problem", () => {
    expect(migrationProblems(first, settled)).toEqual([]);
  });

  test("a first start that found nothing to migrate is no problem either", () => {
    expect(
      migrationProblems(
        "raaqeb: database is Raaqeb at version 14; nothing to migrate",
        settled
      )
    ).toEqual([]);
  });

  test("a next start that migrates again is named", () => {
    expect(migrationProblems(first, first)).toEqual([
      "the next start migrated forward by 2 again",
      "the next start found version 12, where the first start left 14",
    ]);
  });

  test("a start with no note is named", () => {
    expect(migrationProblems("raaqeb: listening", settled)).toEqual([
      "the first start logged no note on the database",
    ]);
    expect(migrationProblems(first, "raaqeb: listening")).toEqual([
      "the next start logged no note on the database",
    ]);
  });
});

describe("what an export holds", () => {
  test("it counts the rows of each table and the records of each kind of history, leaving out what is empty", () => {
    expect(
      inventory([
        header({ monitors: [api, { id: "m2" }], settings: [], tags: [] }),
        check,
        { ...check, at: "2026-09-28T09:20:00.000Z" },
        { ...check, kind: "outage", startedAt: noon },
      ])
    ).toEqual({ check: 2, monitors: 2, outage: 1 });
  });
});

describe("what an upgrade may change in the export", () => {
  const exportedAt = Date.UTC(2026, 8, 28, 12);
  const monitor: Configuration["monitors"][number] = {
    checkType: "tcp",
    config: '{"host":"db.example.test","port":5432,"type":"tcp"}',
    confirmations: 1,
    createdAt: Date.UTC(2026, 8, 1),
    credentials: null,
    degradedMs: null,
    description: null,
    events: '["down","recovered","domain_expiring"]',
    fromMain: 1,
    groupId: null,
    heartbeatToken: null,
    id: "m1",
    intervalMs: 60_000,
    name: "Database",
    paused: 0,
    pausedAt: null,
    reminderMs: null,
    retentionDays: null,
    retries: 0,
    shareCredentials: 0,
    target: "db.example.test:5432",
    timeoutMs: 10_000,
    updatedAt: Date.UTC(2026, 8, 2),
  };
  const configuration: Configuration = {
    auditEntries: [],
    channels: [],
    componentGroups: [],
    componentMonitors: [],
    components: [],
    groups: [],
    incidentStatuses: [],
    incidentUpdates: [],
    incidents: [],
    maintenanceComponents: [],
    maintenanceSeries: [],
    maintenanceSeriesComponents: [],
    maintenanceWindows: [],
    monitorChannels: [],
    monitorProbes: [],
    monitorTags: [],
    monitors: [monitor],
    operatorAccounts: [],
    pageComponents: [],
    pageImages: [],
    probes: [],
    settings: [],
    statusPages: [],
    subscriptions: [],
    tags: [],
  };
  const entry = (id: string, at: number) => ({
    action: "sign_in.succeed",
    actorEmail: "operator@example.com",
    actorId: "a1",
    address: "127.0.0.1",
    at,
    detail: "{}",
    id,
    targetId: null,
  });
  const owner = {
    calendar: null,
    clock: null,
    createdAt: Date.UTC(2026, 8, 1),
    deactivatedAt: null,
    email: "operator@example.com",
    emailVerified: 1,
    id: "a1",
    language: null,
    name: "",
    role: "owner" as const,
    timeZone: null,
    updatedAt: Date.UTC(2026, 8, 1),
  };
  const record = {
    ...check,
    attempts: 1,
    bytes: 0,
    reason: "ok",
    responseMs: 12,
    statusCode: null,
  };
  const outage = {
    endedAt: null,
    kind: "outage",
    monitor: "m1",
    reason: "timeout",
    startedAt: "2026-09-28T09:00:00.000Z",
  };

  /** The lines the current version writes of a configuration, a check and an outage. */
  function written(rows: Configuration, at = exportedAt + hour): ExportLine[] {
    const first = headerSchema.encode({
      configuration: rows,
      exportedAt: at,
      mode: "full",
      raaqeb: "export",
      version: exportVersion,
    });
    return [
      JSON.parse(JSON.stringify(first)),
      record,
      { ...outage, acknowledgedAt: null },
    ];
  }

  /** What version 1 wrote of the same install: none of the tables, fields and defaults version 2 added; `more` adds what version 2 no longer reads. */
  function version1(
    more: {
      monitor?: Record<string, unknown>;
      tables?: Record<string, unknown[]>;
    } = {}
  ): ExportLine[] {
    const first = headerSchema.encode({
      configuration,
      exportedAt,
      mode: "full",
      raaqeb: "export",
      version: exportVersion,
    });
    const {
      auditEntries: _a,
      maintenanceSeries: _s,
      maintenanceSeriesComponents: _c,
      monitorProbes: _m,
      operatorAccounts: _o,
      probes: _p,
      ...older
    } = first.configuration;
    const {
      confirmations: _n,
      fromMain: _f,
      shareCredentials: _h,
      ...row
    } = older.monitors[0] ?? {};
    return [
      JSON.parse(
        JSON.stringify({
          ...first,
          configuration: {
            ...older,
            ...more.tables,
            monitors: [
              { ...row, ...more.monitor, events: ["down", "recovered"] },
            ],
          },
          version: 1,
        })
      ),
      record,
      outage,
    ];
  }

  test("a version 1 install upgraded in place differs only by what the new version reads into the file, its owner and its sign-ins, each named with its reason", () => {
    const after = written({
      ...configuration,
      auditEntries: [entry("e1", exportedAt + 2 * hour)],
      operatorAccounts: [owner],
    });
    expect(upgradeDifferences(version1(), after)).toEqual({
      allowed: [
        "the header's version changed: what the new version reads into the old file",
        "monitors m1 changed: confirmations, events, fromMain, shareCredentials: what the new version reads into the old file",
        "outage m1 2026-09-28T09:00:00.000Z changed: acknowledgedAt: what the new version reads into the old file",
        "operatorAccounts a1 appeared: the old file does not carry operatorAccounts",
        "auditEntries e1 appeared: the old file does not carry auditEntries",
      ],
      found: [],
    });
  });

  test("a loss is still found after the old file is read as the new version reads it", () => {
    const [first, , ...rest] = written({
      ...configuration,
      monitors: [{ ...monitor, events: '["down","recovered"]', name: "B" }],
    });
    expect(
      upgradeDifferences(version1(), [first ?? {}, ...rest]).found
    ).toEqual([
      "monitors m1 changed: events, name",
      `check m1 ${check.at} is missing after the upgrade`,
    ]);
  });

  test("a field of the old file the new version no longer reads is found, beside what reading adds", () => {
    expect(
      upgradeDifferences(
        version1({ monitor: { legacyField: "kept" } }),
        written(configuration)
      )
    ).toEqual({
      allowed: [
        "the header's version changed: what the new version reads into the old file",
        "monitors m1 changed: confirmations, events, fromMain, shareCredentials: what the new version reads into the old file",
        "outage m1 2026-09-28T09:00:00.000Z changed: acknowledgedAt: what the new version reads into the old file",
      ],
      found: [
        "monitors m1 changed: legacyField when the new version reads the old file",
      ],
    });
  });

  test("a table of the old file the new version no longer knows is found row by row", () => {
    expect(
      upgradeDifferences(
        version1({ tables: { legacyTable: [{ id: "l1", note: "kept" }] } }),
        written(configuration)
      ).found
    ).toEqual([
      "legacyTable l1 is missing when the new version reads the old file",
    ]);
  });

  test("a row the reading adds may carry the time the new version recorded it after the old export, and nothing else of it may differ", () => {
    const before = written(configuration, exportedAt);
    // The conversion's own time for the row, before the old export.
    const added = {
      key: "clock" as const,
      updatedAt: exportedAt - hour,
      value: '"24h"',
    };
    const read = written({ ...configuration, settings: [added] }, exportedAt);
    const upgraded = (row: typeof added) =>
      upgradeDifferences(
        before,
        written({ ...configuration, settings: [row] }),
        read
      );
    expect(upgraded({ ...added, updatedAt: exportedAt + hour })).toEqual({
      allowed: [
        "settings clock appeared: what the new version reads into the old file",
        "settings clock changed: updatedAt: recorded by the new version after the old export",
      ],
      found: [],
    });
    expect(
      upgraded({ ...added, updatedAt: exportedAt + hour, value: '"12h"' }).found
    ).toEqual(["settings clock changed: value"]);
    expect(upgraded({ ...added, updatedAt: exportedAt }).found).toEqual([
      "settings clock changed: updatedAt",
    ]);
  });

  test("between two versions of one format, only the audit entries made after the old export are allowed", () => {
    const before = written(
      { ...configuration, auditEntries: [entry("e0", exportedAt - hour)] },
      exportedAt
    );
    const after = written({
      ...configuration,
      auditEntries: [
        entry("e0", exportedAt - hour),
        entry("e1", exportedAt),
        entry("e2", exportedAt + 1),
      ],
    });
    expect(upgradeDifferences(before, after)).toEqual({
      allowed: [
        "auditEntries e2 (sign_in.succeed) appeared: written after the old export",
      ],
      found: ["auditEntries e1 appeared after the upgrade"],
    });
  });

  test("an old export the new version cannot read stops the check", () => {
    const [first, ...history] = version1();
    expect(() =>
      upgradeDifferences([{ ...first, mode: "other" }, ...history], [])
    ).toThrow("the new version cannot read the old export's first line");
    expect(() =>
      upgradeDifferences([first ?? {}, { kind: "check" }], [])
    ).toThrow("the new version cannot read line 2 of the old export");
  });
});

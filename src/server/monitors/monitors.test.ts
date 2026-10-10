import { afterEach, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { credentialMask } from "@/server/checks/capture.ts";
import type { DatabaseQuery } from "@/server/checks/database.ts";
import type { DockerRequest } from "@/server/checks/docker.ts";
import { liveIo } from "@/server/checks/io.ts";
import { publicAddress } from "@/server/settings/address.ts";
import {
  dismissGettingStarted,
  gettingStartedClosed,
} from "@/server/settings/getting-started.ts";
import { retentionDays } from "@/server/settings/retention.ts";
import { ChannelShapeError } from "@/server/storage/channels.ts";
import { ComponentShapeError } from "@/server/storage/components.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import { MaintenanceShapeError } from "@/server/storage/maintenance.ts";
import { OutageShapeError } from "@/server/storage/outages.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { CertificateRecord } from "@/shared/schemas/certificate.ts";
import {
  type HttpConfig,
  type MonitorInput,
  monitorEventKinds,
  monitorFieldsSchema,
  tagsMax,
} from "@/shared/schemas/monitor.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { openCredentials } from "./credentials.ts";
import { readMonitorDetail } from "./detail.ts";
import {
  changeMonitors,
  createMonitor,
  deleteMonitors,
  editMonitor,
  listMonitorChoices,
  listMonitors,
  pauseMonitors,
  readMonitorForm,
  resumeMonitors,
  testMonitor,
} from "./monitors.ts";

const key = await scratchInstallKey();

let open:
  | {
      storage: Storage;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    cleanup: scratch.cleanup,
    location: scratch.location,
    storage: opened.storage,
  };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const site: MonitorInput = {
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  intervalMs: 60_000,
  name: "الموقع",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

/** A storage whose repository fails, as a database outage would. */
function broken(store: Storage): Storage {
  const failing = () => Promise.reject(new Error("database gone"));
  return {
    ...store,
    monitors: {
      addChannel: failing,
      addTag: failing,
      allCredentials: failing,
      choices: failing,
      create: failing,
      credentialsOf: failing,
      find: failing,
      heartbeatTokenOf: failing,
      list: failing,
      organization: failing,
      pause: failing,
      remove: failing,
      removeChannel: failing,
      removeTag: failing,
      resume: failing,
      setGroup: failing,
      update: failing,
    },
  };
}

describe("the monitors module", () => {
  test("creates a monitor and advances the change counter", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    const result = await createMonitor(store, key, site);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.monitor.name).toBe("الموقع");
      expect(result.monitor.paused).toBe(false);
    }
    expect(await store.changeCounter()).toBe(before + 1);
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.monitors.length).toBe(1);
  });

  test("edits a monitor, and refuses an unknown id without touching the counter", async () => {
    const store = await storage();
    const created = await createMonitor(store, key, site);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const before = await store.changeCounter();
    const edited = await editMonitor(store, key, created.monitor.id, {
      ...site,
      name: "الموقع الجديد",
    });
    expect(edited.ok && edited.monitor.name).toBe("الموقع الجديد");
    expect(await store.changeCounter()).toBe(before + 1);
    expect(await editMonitor(store, key, "missing", site)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await store.changeCounter()).toBe(before + 1);
  });

  test("pauses, resumes and deletes in bulk, answering the count and advancing the counter once per call", async () => {
    const store = await storage();
    const first = await createMonitor(store, key, site);
    const second = await createMonitor(store, key, { ...site, name: "الثاني" });
    if (!(first.ok && second.ok)) {
      throw new Error("setup");
    }
    const ids = [first.monitor.id, second.monitor.id];
    const firstId = first.monitor.id;
    const before = await store.changeCounter();
    expect(await pauseMonitors(store, ids)).toEqual({ count: 2, ok: true });
    expect(await resumeMonitors(store, [firstId])).toEqual({
      count: 1,
      ok: true,
    });
    expect(await deleteMonitors(store, ids)).toEqual({ count: 2, ok: true });
    expect(await store.changeCounter()).toBe(before + 3);
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.monitors).toEqual([]);
  });

  test("a stored monitor that no longer fits the schema is reported as such, naming it, not as a database outage", async () => {
    const store = await storage();
    const created = await createMonitor(store, key, site);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const location = open?.location;
    if (!location) {
      throw new Error("no location");
    }
    await runSql(location, "UPDATE monitors SET config = ? WHERE id = ?", [
      '{"type":"ping"}',
      created.monitor.id,
    ]);
    expect(await listMonitors(store, Date.now())).toEqual({
      id: created.monitor.id,
      ok: false,
      reason: "corrupt",
    });
  });

  test("an edit repairs a stored monitor whose config no longer fits the schema", async () => {
    const store = await storage();
    const created = await createMonitor(store, key, site);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const location = open?.location;
    if (!location) {
      throw new Error("no location");
    }
    await runSql(location, "UPDATE monitors SET config = ? WHERE id = ?", [
      "not json",
      created.monitor.id,
    ]);
    const edited = await editMonitor(store, key, created.monitor.id, site);
    expect(edited.ok).toBe(true);
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.monitors.length).toBe(1);
  });

  test("a change counter that fails after the write reads as unavailable, so the caller re-reads rather than trusts the answer", async () => {
    const store = await storage();
    const failing = {
      ...store,
      bump: () => Promise.reject(new Error("counter gone")),
    };
    expect(await createMonitor(failing, key, site)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.monitors.length).toBe(1);
  });

  describe("the certificate record on an edit", () => {
    const secureConfig: HttpConfig = {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "off",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      tlsExpiryDays: 14,
      type: "http",
      url: "https://example.test/health",
    };
    const secure: MonitorInput = { ...site, config: secureConfig };
    const record = (monitorId: string): CertificateRecord => ({
      fingerprint: "61:53:A9:6F",
      issuer: "CN=Issuer",
      lastSeenAt: 1_700_000_000_000,
      monitorId,
      names: ["example.test"],
      subject: "CN=example.test",
      validFrom: 1_690_000_000_000,
      validTo: 1_710_000_000_000,
    });

    async function withRecord(store: Storage): Promise<string> {
      const created = await createMonitor(store, key, secure);
      if (!created.ok) {
        throw new Error(created.reason);
      }
      await store.certificates.replace(record(created.monitor.id));
      return created.monitor.id;
    }

    test("an edit that changes the host, the port or the scheme removes the record, so the reader is due again", async () => {
      const store = await storage();
      const urls = [
        "https://other.example.test/health",
        "https://example.test:8443/health",
        "http://example.test/health",
      ];
      const ids = await Promise.all(urls.map(() => withRecord(store)));
      const edits = await Promise.all(
        ids.map((id, index) =>
          editMonitor(store, key, id, {
            ...secure,
            config: { ...secureConfig, url: urls[index] ?? "" },
          })
        )
      );
      expect(edits.every((edit) => edit.ok)).toBe(true);
      const records = await Promise.all(
        ids.map((id) => store.certificates.find(id))
      );
      expect(records).toEqual([undefined, undefined, undefined]);
    });

    test("an edit that switches the expiry option off removes the record", async () => {
      const store = await storage();
      const id = await withRecord(store);
      await editMonitor(store, key, id, {
        ...secure,
        config: { ...secureConfig, tlsExpiryDays: undefined },
      });
      expect(await store.certificates.find(id)).toBeUndefined();
    });

    test("an edit that changes the path, the name or the threshold keeps the record", async () => {
      const store = await storage();
      const id = await withRecord(store);
      await editMonitor(store, key, id, {
        ...secure,
        config: {
          ...secureConfig,
          tlsExpiryDays: 7,
          url: "https://example.test/other",
        },
        name: "renamed",
      });
      expect(await store.certificates.find(id)).toEqual(record(id));
    });

    test("the record is dropped before the monitor is written, so a write that fails leaves a re-read, never a stale record", async () => {
      const store = await storage();
      const id = await withRecord(store);
      const failing: Storage = {
        ...store,
        monitors: {
          ...store.monitors,
          update: () => Promise.reject(new Error("database gone")),
        },
      };
      expect(
        await editMonitor(failing, key, id, {
          ...secure,
          config: { ...secureConfig, url: "https://other.example.test/" },
        })
      ).toEqual({ ok: false, reason: "unavailable" });
      expect(await store.certificates.find(id)).toBeUndefined();
    });

    test("deleting a monitor takes its record with it", async () => {
      const store = await storage();
      const id = await withRecord(store);
      await deleteMonitors(store, [id]);
      expect(await store.certificates.find(id)).toBeUndefined();
    });
  });

  test("the list names the monitors a window in progress covers, through the components linked to them", async () => {
    const store = await storage();
    const a = await createMonitor(store, key, site);
    const b = await createMonitor(store, key, { ...site, name: "API" });
    if (!(a.ok && b.ok)) {
      throw new Error("expected two monitors");
    }
    const web = await store.components.create({
      description: undefined,
      monitorIds: [a.monitor.id],
      name: { ar: "الموقع" },
      status: "operational",
    });
    const now = Date.now();
    await store.maintenance.create({
      componentIds: [web.id],
      endsAt: now + 3_600_000,
      message: { ar: "نص" },
      startsAt: now,
      title: { ar: "صيانة" },
    });
    const scheduled = await listMonitors(store, Date.now());
    expect(scheduled.ok && scheduled.covered).toEqual([]);
    await store.maintenance.advance(now);
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.covered).toEqual([a.monitor.id]);
  });

  test("a window this version cannot read leaves the list whole and every badge off", async () => {
    const store = await storage();
    const a = await createMonitor(store, key, site);
    if (!a.ok) {
      throw new Error(a.reason);
    }
    const web = await store.components.create({
      description: undefined,
      monitorIds: [a.monitor.id],
      name: { ar: "الموقع" },
      status: "operational",
    });
    const now = Date.now();
    await store.maintenance.create({
      componentIds: [web.id],
      endsAt: now + 3_600_000,
      message: { ar: "نص" },
      startsAt: now,
      title: { ar: "صيانة" },
    });
    await store.maintenance.advance(now);
    const failing: Storage = {
      ...store,
      maintenance: {
        ...store.maintenance,
        unfinished: () =>
          Promise.reject(new MaintenanceShapeError("w-unreadable")),
      },
    };
    const listed = await listMonitors(failing, Date.now());
    expect(listed.ok && listed.covered).toEqual([]);
    expect(listed.ok && listed.monitors.map((each) => each.id)).toEqual([
      a.monitor.id,
    ]);
  });

  test("a component this version cannot read leaves the monitor list and a monitor's page whole, with no badge and no bars", async () => {
    const store = await storage();
    const a = await createMonitor(store, key, site);
    if (!a.ok) {
      throw new Error(a.reason);
    }
    const failing: Storage = {
      ...store,
      components: {
        ...store.components,
        list: () => Promise.reject(new ComponentShapeError("c-unreadable")),
      },
    };
    const listed = await listMonitors(failing, Date.now());
    expect(listed.ok && listed.monitors.length).toBe(1);
    expect(listed.ok && listed.covered).toEqual([]);
    expect(listed.ok && listed.days).toEqual({});
    const detail = await readMonitorDetail(failing, a.monitor.id, {
      now: Date.now(),
      range: "24h",
      requestOrigin: undefined,
    });
    if (!detail.ok) {
      throw new Error(detail.reason);
    }
    expect(detail.detail.covered).toBe(false);
    expect(detail.detail.days).toEqual([]);
  });

  test.each([
    {
      record: "window",
      unreadable: (store: Storage): Storage => ({
        ...store,
        maintenance: {
          ...store.maintenance,
          since: () =>
            Promise.reject(new MaintenanceShapeError("w-unreadable")),
        },
      }),
    },
    {
      record: "outage",
      unreadable: (store: Storage): Storage => ({
        ...store,
        outages: {
          ...store.outages,
          since: () => Promise.reject(new OutageShapeError("m-unreadable", 0)),
        },
      }),
    },
  ])(
    "a bar's $record this version cannot read leaves the monitor list and a monitor's page whole, with no bars",
    async ({ unreadable }) => {
      const store = await storage();
      const id = await createdId(store, site);
      const failing = unreadable(store);
      const listed = await listMonitors(failing, Date.now());
      expect(listed.ok && listed.days).toEqual({});
      const detail = await readMonitorDetail(failing, id, {
        now: Date.now(),
        range: "24h",
        requestOrigin: undefined,
      });
      if (!detail.ok) {
        throw new Error(detail.reason);
      }
      expect(detail.detail.days).toEqual([]);
    }
  );

  test("the list carries each monitor's current state from its latest check; a monitor with no check yet has none", async () => {
    const store = await storage();
    const a = await createMonitor(store, key, site);
    const b = await createMonitor(store, key, { ...site, name: "API" });
    await createMonitor(store, key, { ...site, name: "New" });
    if (!(a.ok && b.ok)) {
      throw new Error("expected two monitors");
    }
    const check = (monitorId: string, startedAt: number) => ({
      attempts: 1,
      bytes: 10,
      monitorId,
      reason: reasons.ok,
      responseMs: 5,
      startedAt,
      statusCode: 200,
    });
    await store.checks.record({
      capture: undefined,
      check: { ...check(a.monitor.id, 1000), result: "down" },
      detail: undefined,
    });
    await store.checks.record({
      capture: undefined,
      check: { ...check(a.monitor.id, 2000), result: "up" },
      detail: undefined,
    });
    await store.checks.record({
      capture: undefined,
      check: { ...check(b.monitor.id, 1500), result: "degraded" },
      detail: undefined,
    });
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.states).toEqual({
      [a.monitor.id]: "up",
      [b.monitor.id]: "degraded",
    });
  });

  test("pausing ends the monitor's open outage at the pause time in the same write, so paused time is never downtime", async () => {
    const store = await storage();
    const created = await createMonitor(store, key, site);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const { id, updatedAt } = created.monitor;
    await store.outages.open(id, updatedAt, reasons.timeout);
    const before = Date.now();
    expect(await pauseMonitors(store, [id])).toEqual({ count: 1, ok: true });
    const [outage] = await store.outages.list(id);
    expect(outage?.startedAt).toBe(updatedAt);
    expect(outage?.endedAt).toBeGreaterThanOrEqual(before);
    expect(outage?.endedAt).toBeLessThanOrEqual(Date.now());
    // The outage ends when the monitor's row says it was paused: one transaction, never one without the other.
    const [row] = await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "SELECT updated_at FROM monitors WHERE id = ?",
      [id]
    );
    expect(outage?.endedAt).toBe(Number(row?.updated_at));
  });

  test("a latest check this version cannot read is reported as corrupt, naming its monitor", async () => {
    const store = await storage();
    const created = await createMonitor(store, key, site);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const { id } = created.monitor;
    await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "INSERT INTO checks (monitor_id, started_at, result, response_ms, status_code, reason, attempts, bytes) VALUES (?, ?, 0, 1, 200, 999, 1, 1)",
      [id, 1000]
    );
    expect(await listMonitors(store, Date.now())).toEqual({
      id,
      ok: false,
      reason: "corrupt",
    });
  });

  test("the command palette's read answers every monitor's id, name and target, and unavailable when the database fails, never throwing", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    expect(await listMonitorChoices(store)).toEqual({
      monitors: [{ id, name: "الموقع", target: "https://example.test/" }],
      ok: true,
    });
    expect(await listMonitorChoices(broken(store))).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("a database that fails mid-call answers unavailable and never throws", async () => {
    const store = broken(await storage());
    expect(await listMonitors(store, Date.now())).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await createMonitor(store, key, site)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await editMonitor(store, key, "x", site)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await pauseMonitors(store, ["x"])).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await resumeMonitors(store, ["x"])).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await deleteMonitors(store, ["x"])).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

/** The created monitor's id, or the test fails on the refusal. */
async function createdId(store: Storage, input: MonitorInput): Promise<string> {
  const result = await createMonitor(store, key, input);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.monitor.id;
}

/** The monitor's stored credentials, opened with the test's key. */
async function storedCredentials(store: Storage, id: string) {
  const sealed = await store.monitors.credentialsOf(id);
  return sealed === undefined ? undefined : openCredentials(key, sealed);
}

const secured: MonitorInput = {
  ...site,
  credentials: {
    auth: { kind: "basic", password: "كلمة-سر", user: "ops" },
    headers: [{ name: "X-Api-Key", value: "key-1" }],
  },
};

describe("the list's bar of each monitor", () => {
  test("the list carries each monitor's last 14 days, today's with its checks", async () => {
    const store = await storage();
    const created = await createMonitor(store, key, site);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const now = Date.now();
    await store.checks.record({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: created.monitor.id,
        reason: reasons.ok,
        responseMs: 80,
        result: "up",
        startedAt: now - 60_000,
        statusCode: 200,
      },
      detail: undefined,
    });
    const listed = await listMonitors(store, now);
    const days = listed.ok ? listed.days[created.monitor.id] : undefined;
    expect(days).toHaveLength(14);
    expect(days?.at(-1)?.date).toBe(new Date(now).toISOString().slice(0, 10));
    expect(days?.at(-1)?.responseMs).toBe(80);
  });
});

describe("a monitor's credentials through the module", () => {
  test("create seals them with the install key: the row holds ciphertext that opens to what was posted", async () => {
    const store = await storage();
    const id = await createdId(store, secured);
    const sealed = (await store.monitors.credentialsOf(id)) ?? "";
    expect(sealed.includes("كلمة-سر")).toBe(false);
    expect(sealed.includes("key-1")).toBe(false);
    expect(await storedCredentials(store, id)).toEqual({
      auth: { kind: "basic", password: "كلمة-سر", user: "ops" },
      headers: [{ name: "X-Api-Key", value: "key-1" }],
    });
  });

  test("a monitor saved without credentials stores none", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    expect(await store.monitors.credentialsOf(id)).toBe(undefined);
  });

  test("an edit that leaves a secret out keeps the stored one, and one that drops a header drops it", async () => {
    const store = await storage();
    const id = await createdId(store, {
      ...secured,
      credentials: {
        auth: { kind: "basic", password: "كلمة-سر", user: "ops" },
        headers: [
          { name: "X-Api-Key", value: "key-1" },
          { name: "X-Tenant", value: "t1" },
        ],
      },
    });
    const edited = await editMonitor(store, key, id, {
      ...site,
      credentials: {
        auth: { kind: "basic", user: "ops" },
        headers: [{ name: "X-Api-Key" }],
      },
    });
    expect(edited.ok).toBe(true);
    expect(await storedCredentials(store, id)).toEqual({
      auth: { kind: "basic", password: "كلمة-سر", user: "ops" },
      headers: [{ name: "X-Api-Key", value: "key-1" }],
    });
  });

  test("an edit without credentials clears them", async () => {
    const store = await storage();
    const id = await createdId(store, secured);
    await editMonitor(store, key, id, site);
    expect(await store.monitors.credentialsOf(id)).toBe(undefined);
  });

  test("a left-out secret with nothing stored is refused as invalid, and nothing is written", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    expect(
      await createMonitor(store, key, {
        ...site,
        credentials: { auth: { kind: "bearer" }, headers: [] },
      })
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      (await listMonitors(store, Date.now())).ok &&
        (await store.monitors.list())
    ).toEqual([]);
    const id = await createdId(store, site);
    const after = await store.changeCounter();
    expect(after).toBe(before + 1);
    expect(
      await editMonitor(store, key, id, {
        ...site,
        credentials: { headers: [{ name: "X-Api-Key" }] },
        name: "renamed",
      })
    ).toEqual({ ok: false, reason: "invalid" });
    expect((await store.monitors.find(id))?.name).toBe(site.name);
    expect(await store.changeCounter()).toBe(after);
  });

  test("credentials another install key sealed read as none: an edit that keeps a secret is refused, one that types it again saves", async () => {
    const store = await storage();
    const other = await scratchInstallKey();
    const result = await createMonitor(store, other, secured);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { id } = result.monitor;
    expect(
      await editMonitor(store, key, id, {
        ...site,
        credentials: { auth: { kind: "basic", user: "ops" }, headers: [] },
      })
    ).toEqual({ ok: false, reason: "invalid" });
    expect((await editMonitor(store, key, id, secured)).ok).toBe(true);
    expect((await storedCredentials(store, id))?.auth).toEqual({
      kind: "basic",
      password: "كلمة-سر",
      user: "ops",
    });
  });
});

describe("the form's read", () => {
  test("a new monitor gets no monitor, no credentials, the install's retention and the group and tag names in use", async () => {
    const store = await storage();
    await createdId(store, { ...site, group: "الإنتاج", tags: ["ويب", "عام"] });
    await createdId(store, { ...site, group: "التجربة", tags: ["عام"] });
    await store.settings.set(retentionDays, 180);
    const form = await readMonitorForm(store, key, undefined, undefined);
    expect(form).toEqual({
      credentials: { auth: undefined, headers: [], url: false },
      heartbeat: undefined,
      monitor: undefined,
      ok: true,
      options: {
        // Code point order, as the repository answers tags: the same on both backends whatever the collation.
        groups: ["الإنتاج", "التجربة"],
        retentionDefaultDays: 180,
        channels: [],
        tags: ["عام", "ويب"],
      },
      original: undefined,
    });
  });

  test("an edit reads the monitor and its credentials' names, never a secret", async () => {
    const store = await storage();
    const id = await createdId(store, secured);
    const form = await readMonitorForm(store, key, id, undefined);
    if (!form.ok) {
      throw new Error(form.reason);
    }
    expect(form.monitor?.id).toBe(id);
    expect(form.credentials).toEqual({
      auth: { kind: "basic", user: "ops" },
      headers: [{ name: "X-Api-Key" }],
      url: false,
    });
    const text = JSON.stringify(form);
    expect(text.includes("كلمة-سر")).toBe(false);
    expect(text.includes("key-1")).toBe(false);
    expect(form.options.retentionDefaultDays).toBe(90);
  });

  test("credentials this install's key cannot open read as none", async () => {
    const store = await storage();
    const result = await createMonitor(
      store,
      await scratchInstallKey(),
      secured
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const form = await readMonitorForm(
      store,
      key,
      result.monitor.id,
      undefined
    );
    expect(form.ok && form.credentials).toEqual({
      auth: undefined,
      headers: [],
      url: false,
    });
  });

  test("an unknown id is not found, a stored config this version cannot read is corrupt, and no database is unavailable", async () => {
    const store = await storage();
    expect(await readMonitorForm(store, key, "missing", undefined)).toEqual({
      ok: false,
      reason: "not_found",
    });
    const id = await createdId(store, site);
    await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "UPDATE monitors SET config = ? WHERE id = ?",
      ['{"type":"ping"}', id]
    );
    expect(await readMonitorForm(store, key, id, undefined)).toEqual({
      id,
      ok: false,
      reason: "corrupt",
    });
    expect(await readMonitorForm(broken(store), key, id, undefined)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

/** A local target that answers what the test sets and remembers the requests it got. */
function target() {
  const seen: Headers[] = [];
  let answer: () => Response = () => new Response("ok");
  const server = Bun.serve({
    fetch: (request) => {
      seen.push(request.headers);
      return answer();
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return {
    answer: (next: () => Response) => {
      answer = next;
    },
    seen,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}/health`,
  };
}

const probeConfig: HttpConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: "http://127.0.0.1/",
};

function probe(url: string, config: Partial<HttpConfig> = {}): MonitorInput {
  return { ...site, config: { ...probeConfig, ...config, url } };
}

describe("test now", () => {
  test("runs one check of the form as it stands and answers what the scheduler would store, with the response as a capture keeps it", async () => {
    const store = await storage();
    const local = target();
    try {
      local.answer(
        () =>
          new Response("x".repeat(5000), {
            headers: { "set-cookie": "session=1", "x-served-by": "edge" },
            status: 200,
          })
      );
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        probe(local.url),
        undefined
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(result.test.result).toBe("up");
      expect(result.test.reason).toBe("ok");
      expect(result.test.statusCode).toBe(200);
      expect(result.test.bytes).toBe(5000);
      expect(result.test.failure).toBe(undefined);
      expect(result.test.response?.body).toBe("x".repeat(4096));
      expect(result.test.response?.headers).toContainEqual({
        name: "set-cookie",
        value: undefined,
      });
      expect(result.test.response?.headers).toContainEqual({
        name: "x-served-by",
        value: "edge",
      });
    } finally {
      local.stop();
    }
  });

  test("records nothing: no check, no outage, no bump", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    const before = await store.changeCounter();
    const local = target();
    try {
      local.answer(() => new Response("down", { status: 503 }));
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        probe(local.url),
        id
      );
      expect(result.ok && result.test.result).toBe("down");
      expect(await store.checks.latest()).toEqual([]);
      expect(await store.outages.ongoing()).toEqual([]);
      expect(await store.changeCounter()).toBe(before);
    } finally {
      local.stop();
    }
  });

  test("makes one attempt whatever the retries, so the answer comes within the timeout", async () => {
    const store = await storage();
    const local = target();
    try {
      local.answer(() => new Response("down", { status: 500 }));
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        { ...probe(local.url), retries: 3 },
        undefined
      );
      expect(result.ok && result.test.result).toBe("down");
      expect(local.seen).toHaveLength(1);
    } finally {
      local.stop();
    }
  });

  test("a down check answers the failure detail: the assertion that failed and what it saw", async () => {
    const store = await storage();
    const local = target();
    try {
      local.answer(() => Response.json({ status: "degraded" }));
      const assertion = {
        kind: "json_equals",
        path: "status",
        value: "ok",
      } as const;
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        probe(local.url, {
          assertions: [{ codes: ["2xx"], kind: "status" }, assertion],
        }),
        undefined
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(result.test.reason).toBe("assertion_failed");
      expect(result.test.failure?.assertion).toEqual(assertion);
      expect(result.test.failure?.params).toEqual({
        expected: "ok",
        observed: "degraded",
        reason: "assertion_failed",
      });
    } finally {
      local.stop();
    }
  });

  test("sends the credentials the form posts, a left-out secret read from the monitor it edits", async () => {
    const store = await storage();
    const local = target();
    try {
      const id = await createdId(store, {
        ...probe(local.url),
        credentials: {
          auth: { kind: "bearer", token: "stored-token" },
          headers: [{ name: "X-Api-Key", value: "stored-key" }],
        },
      });
      await testMonitor(
        store,
        key,
        liveIo(),
        {
          ...probe(local.url),
          credentials: {
            auth: { kind: "bearer" },
            headers: [{ name: "X-Api-Key" }, { name: "X-New", value: "typed" }],
          },
        },
        id
      );
      const [headers] = local.seen;
      expect(headers?.get("authorization")).toBe("Bearer stored-token");
      expect(headers?.get("x-api-key")).toBe("stored-key");
      expect(headers?.get("x-new")).toBe("typed");
    } finally {
      local.stop();
    }
  });

  test("a target that echoes the token in its body and a response header shows neither, in the response or the failure", async () => {
    const store = await storage();
    const local = target();
    try {
      local.answer(
        () =>
          new Response(
            JSON.stringify({
              authorization: local.seen.at(-1)?.get("authorization"),
            }),
            {
              headers: {
                "x-echo": local.seen.at(-1)?.get("authorization") ?? "",
              },
              status: 200,
            }
          )
      );
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        {
          ...probe(local.url, {
            assertions: [{ kind: "body_contains", text: "welcome" }],
          }),
          credentials: {
            auth: { kind: "bearer", token: "echoed-token" },
            headers: [],
          },
        },
        undefined
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(local.seen[0]?.get("authorization")).toBe("Bearer echoed-token");
      expect(JSON.stringify(result.test).includes("echoed-token")).toBe(false);
      expect(result.test.response?.body).toBe(
        JSON.stringify({ authorization: `Bearer ${credentialMask}` })
      );
      expect(result.test.response?.headers).toContainEqual({
        name: "x-echo",
        value: `Bearer ${credentialMask}`,
      });
      expect(result.test.failure?.params).toMatchObject({
        observed: JSON.stringify({ authorization: `Bearer ${credentialMask}` }),
      });
    } finally {
      local.stop();
    }
  });

  test("a left-out secret with nothing stored is invalid, and nothing is sent", async () => {
    const store = await storage();
    const local = target();
    try {
      expect(
        await testMonitor(
          store,
          key,
          liveIo(),
          {
            ...probe(local.url),
            credentials: { auth: { kind: "bearer" }, headers: [] },
          },
          undefined
        )
      ).toEqual({ ok: false, reason: "invalid" });
      expect(local.seen).toHaveLength(0);
    } finally {
      local.stop();
    }
  });

  test("a TCP monitor is tested too, answering no response", async () => {
    const store = await storage();
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
    try {
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        {
          ...site,
          config: { host: "127.0.0.1", port: listener.port, type: "tcp" },
        },
        undefined
      );
      expect(result.ok && result.test.result).toBe("up");
      expect(result.ok && result.test.response).toBe(undefined);
    } finally {
      listener.stop(true);
    }
  });

  test("a heartbeat monitor has no check to run now and is invalid", async () => {
    const store = await storage();
    expect(
      await testMonitor(
        store,
        key,
        liveIo(),
        {
          ...site,
          config: {
            schedule: { everyMs: 60_000, kind: "every" },
            type: "heartbeat",
          },
        },
        undefined
      )
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("a form that leaves no secret out runs without reading the database, and a left-out secret the database cannot answer for is unavailable", async () => {
    const store = broken(await storage());
    const local = target();
    try {
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        probe(local.url),
        "some-id"
      );
      expect(result.ok && result.test.result).toBe("up");
      expect(
        await testMonitor(
          store,
          key,
          liveIo(),
          {
            ...probe(local.url),
            credentials: { auth: { kind: "bearer" }, headers: [] },
          },
          "some-id"
        )
      ).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      local.stop();
    }
  });
});

describe("what test now shows of a DNS or TCP check", () => {
  const dns = (expected?: string): MonitorInput => ({
    ...site,
    config: {
      expected,
      name: "example.test",
      recordType: "A",
      type: "dns",
    },
  });
  const answering = (records: readonly string[]) => ({
    ...liveIo(),
    resolve: () => Promise.resolve(records),
  });

  test("a DNS check that passes lists the records the resolver answered", async () => {
    const store = await storage();
    const result = await testMonitor(
      store,
      key,
      answering(["192.0.2.1", "192.0.2.2"]),
      dns(),
      undefined
    );
    expect(result.ok && result.test.result).toBe("up");
    expect(result.ok && result.test.records).toEqual([
      "192.0.2.1",
      "192.0.2.2",
    ]);
    expect(result.ok && result.test.address).toBe(undefined);
  });

  test("a DNS check whose answers miss the expected value lists them beside the mismatch", async () => {
    const store = await storage();
    const result = await testMonitor(
      store,
      key,
      answering(["192.0.2.1"]),
      dns("192.0.2.9"),
      undefined
    );
    expect(result.ok && result.test.reason).toBe("dns_mismatch");
    expect(result.ok && result.test.records).toEqual(["192.0.2.1"]);
  });

  test("a TCP check shows the address it connected to", async () => {
    const store = await storage();
    const result = await testMonitor(
      store,
      key,
      { ...liveIo(), connect: () => Promise.resolve("192.0.2.7") },
      {
        ...site,
        config: { host: "db.example.test", port: 5432, type: "tcp" },
      },
      undefined
    );
    expect(result.ok && result.test.result).toBe("up");
    expect(result.ok && result.test.address).toBe("192.0.2.7");
    expect(result.ok && result.test.records).toBe(undefined);
  });

  test("a query or a connection that failed shows no records and no address", async () => {
    const store = await storage();
    const refused = Object.assign(new Error("Failed to connect"), {
      code: "ECONNREFUSED",
    });
    const failing = {
      ...liveIo(),
      connect: () => Promise.reject(refused),
      resolve: () =>
        Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })),
    };
    const tcp = await testMonitor(
      store,
      key,
      failing,
      {
        ...site,
        config: { host: "db.example.test", port: 5432, type: "tcp" },
      },
      undefined
    );
    expect(tcp.ok && tcp.test.result).toBe("down");
    expect(tcp.ok && tcp.test.address).toBe(undefined);
    const query = await testMonitor(store, key, failing, dns(), undefined);
    expect(query.ok && query.test.result).toBe("down");
    expect(query.ok && query.test.records).toBe(undefined);
  });

  test("an HTTP check shows neither", async () => {
    const store = await storage();
    const local = target();
    try {
      const result = await testMonitor(
        store,
        key,
        liveIo(),
        probe(local.url),
        undefined
      );
      expect(result.ok && result.test.address).toBe(undefined);
      expect(result.ok && result.test.records).toBe(undefined);
    } finally {
      local.stop();
    }
  });

  test("the records and the address are never stored: no check is recorded", async () => {
    const store = await storage();
    const id = await createdId(store, dns());
    await testMonitor(store, key, answering(["192.0.2.1"]), dns(), id);
    expect(await store.checks.latest()).toEqual([]);
  });
});

describe("every field round-trips through the module the server functions call", () => {
  test("a monitor saved with every field, read back by the form and saved again with its secrets left out, stores the same monitor and keeps its secrets", async () => {
    const store = await storage();
    const full: MonitorInput = {
      config: {
        assertions: [
          { codes: ["2xx", "301"], kind: "status" },
          { kind: "json_matches", path: "version", pattern: "^2\\." },
          { kind: "response_time_under", ms: 800 },
        ],
        body: '{"ping":true}',
        captureMode: "always",
        followRedirects: false,
        ignoreTlsErrors: true,
        method: "POST",
        tlsExpiryDays: 30,
        type: "http",
        url: "https://api.example.test/health",
      },
      credentials: {
        auth: { kind: "basic", password: "كلمة-سر", user: "ops" },
        headers: [{ name: "X-Api-Key", value: "key-1" }],
      },
      degradedMs: 400,
      description: "واجهة الدفع",
      group: "الإنتاج",
      intervalMs: 300_000,
      name: "بوابة الدفع",
      retentionDays: 365,
      retries: 3,
      channels: [],
      events: [...monitorEventKinds],
      tags: ["دفع", "عام"],
      timeoutMs: 15_000,
    };
    const id = await createdId(store, full);
    const form = await readMonitorForm(store, key, id, undefined);
    if (!(form.ok && form.monitor)) {
      throw new Error("the form did not read");
    }
    // What the form posts back untouched: the read fields, and the credentials as names with every secret left out.
    expect(form.credentials).toEqual({
      auth: { kind: "basic", user: "ops" },
      headers: [{ name: "X-Api-Key" }],
      url: false,
    });
    const again: MonitorInput = {
      ...monitorFieldsSchema.parse(form.monitor),
      credentials: {
        auth: { kind: "basic", user: "ops" },
        headers: [{ name: "X-Api-Key" }],
      },
    };
    expect((await editMonitor(store, key, id, again)).ok).toBe(true);
    const { credentials: _, ...fields } = full;
    expect(await store.monitors.find(id)).toMatchObject(fields);
    expect(await storedCredentials(store, id)).toEqual({
      auth: { kind: "basic", password: "كلمة-سر", user: "ops" },
      headers: [{ name: "X-Api-Key", value: "key-1" }],
    });
  });
});

describe("a TCP or DNS monitor's credentials", () => {
  test("a TCP or DNS monitor stores no credentials, whatever the input carries", async () => {
    const store = await storage();
    const id = await createdId(store, {
      ...site,
      config: { host: "db.example.test", port: 5432, type: "tcp" },
      credentials: { auth: { kind: "bearer", token: "abc" }, headers: [] },
    });
    expect(await store.monitors.credentialsOf(id)).toBe(undefined);
    const http = await createdId(store, secured);
    await editMonitor(store, key, http, {
      ...site,
      config: { name: "example.test", recordType: "A", type: "dns" },
      credentials: { auth: { kind: "bearer", token: "abc" }, headers: [] },
    });
    expect(await store.monitors.credentialsOf(http)).toBe(undefined);
  });
});

describe("credentials this install's key cannot open", () => {
  test("an edit that posts no credentials leaves alone credentials this install's key cannot open, so restoring the right key recovers them", async () => {
    const store = await storage();
    const other = await scratchInstallKey();
    const result = await createMonitor(store, other, secured);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { id } = result.monitor;
    const sealed = await store.monitors.credentialsOf(id);
    expect(
      (await editMonitor(store, key, id, { ...site, name: "renamed" })).ok
    ).toBe(true);
    expect(await store.monitors.credentialsOf(id)).toBe(sealed);
    const restored = await readMonitorForm(store, other, id, undefined);
    expect(restored.ok && restored.credentials).toEqual({
      auth: { kind: "basic", user: "ops" },
      headers: [{ name: "X-Api-Key" }],
      url: false,
    });
    expect(
      (
        await editMonitor(store, key, id, {
          ...site,
          credentials: { auth: { kind: "bearer", token: "new" }, headers: [] },
        })
      ).ok
    ).toBe(true);
    expect((await storedCredentials(store, id))?.auth).toEqual({
      kind: "bearer",
      token: "new",
    });
  });
});

const backup: MonitorInput = {
  config: {
    schedule: { everyMs: 300_000, kind: "every" },
    type: "heartbeat",
  },
  intervalMs: 60_000,
  name: "النسخ الاحتياطي",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

async function tokenOf(store: Storage, id: string): Promise<string> {
  const token = await store.monitors.heartbeatTokenOf(id);
  if (token === undefined) {
    throw new Error("no token");
  }
  return token;
}

describe("a heartbeat monitor in the list", () => {
  test("the list names a heartbeat monitor that heard a heartbeat before its first check, and not one that heard none", async () => {
    const store = await storage();
    const heard = await createdId(store, backup);
    const silent = await createdId(store, { ...backup, name: "الصامت" });
    await store.heartbeats.record(
      await tokenOf(store, heard),
      1_700_000_000_000,
      undefined
    );
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.heard).toEqual([heard]);
    expect(listed.ok && listed.heard).not.toContain(silent);
  });

  test("once its first check is written, the monitor's state is the check's and it is no longer named as waiting", async () => {
    const store = await storage();
    const id = await createdId(store, backup);
    await store.heartbeats.record(
      await tokenOf(store, id),
      1_700_000_000_000,
      undefined
    );
    await store.checks.record({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: id,
        reason: reasons.ok,
        responseMs: undefined,
        result: "up",
        startedAt: 1_700_000_060_000,
        statusCode: undefined,
      },
      detail: undefined,
    });
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.states).toEqual({ [id]: "up" });
    expect(listed.ok && listed.heard).toEqual([]);
  });
});

describe("the monitors the list offers to acknowledge", () => {
  test("are those with an open outage nobody acknowledged, each with when that outage started: not one acknowledged, recovered or never down", async () => {
    const store = await storage();
    const down = await createdId(store, site);
    const acknowledged = await createdId(store, { ...site, name: "API" });
    const recovered = await createdId(store, { ...site, name: "Docs" });
    await createdId(store, { ...site, name: "Up" });
    const startedAt = Date.now() + 1000;
    for (const id of [down, acknowledged, recovered]) {
      // biome-ignore lint/performance/noAwaitInLoops: three outages, one after the other
      await store.outages.open(id, startedAt, reasons.timeout);
    }
    await store.outages.acknowledge(acknowledged, startedAt, startedAt + 1000);
    await store.outages.close(recovered, startedAt + 1000);
    const listed = await listMonitors(store, Date.now());
    expect(listed.ok && listed.acknowledgeable).toEqual({ [down]: startedAt });
  });

  test("an outage this version cannot read leaves the list whole, with nothing to acknowledge", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    const failing: Storage = {
      ...store,
      outages: {
        ...store.outages,
        ongoing: () => Promise.reject(new OutageShapeError(id, 0)),
      },
    };
    const listed = await listMonitors(failing, Date.now());
    expect(listed.ok && listed.acknowledgeable).toEqual({});
    expect(listed.ok && listed.monitors.map((each) => each.id)).toEqual([id]);
  });
});

describe("a heartbeat monitor in the form", () => {
  test("the edit form reads its unique URL at the public address, and no heartbeat before the first", async () => {
    const store = await storage();
    await store.settings.set(publicAddress, "https://status.example.test");
    const id = await createdId(store, backup);
    const token = await tokenOf(store, id);
    const form = await readMonitorForm(store, key, id, "http://10.0.0.5:3000");
    expect(form.ok && form.heartbeat).toEqual({
      last: undefined,
      url: `https://status.example.test/api/heartbeat/${token}`,
    });
  });

  test("without a stored public address the URL is at the request's origin, and with neither it is the path", async () => {
    const store = await storage();
    const id = await createdId(store, backup);
    const token = await tokenOf(store, id);
    const atOrigin = await readMonitorForm(
      store,
      key,
      id,
      "http://10.0.0.5:3000"
    );
    expect(atOrigin.ok && atOrigin.heartbeat?.url).toBe(
      `http://10.0.0.5:3000/api/heartbeat/${token}`
    );
    const bare = await readMonitorForm(store, key, id, undefined);
    expect(bare.ok && bare.heartbeat?.url).toBe(`/api/heartbeat/${token}`);
  });

  test("the edit form shows the last heartbeat with its source address", async () => {
    const store = await storage();
    const id = await createdId(store, backup);
    const token = await tokenOf(store, id);
    await store.heartbeats.record(token, 1_700_000_000_000, "203.0.113.7");
    await store.heartbeats.record(token, 1_700_000_060_000, "203.0.113.8");
    const form = await readMonitorForm(store, key, id, undefined);
    expect(form.ok && form.heartbeat?.last).toEqual({
      arrivedAt: 1_700_000_060_000,
      sourceIp: "203.0.113.8",
    });
  });

  test("another check type, and a new monitor, have no heartbeat URL", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    const form = await readMonitorForm(store, key, id, "https://a.example");
    expect(form.ok && form.heartbeat).toBeUndefined();
    const fresh = await readMonitorForm(
      store,
      key,
      undefined,
      "https://a.example"
    );
    expect(fresh.ok && fresh.heartbeat).toBeUndefined();
  });

  test("an edit asked to renew the URL gives the monitor a new token and moves the change counter", async () => {
    const store = await storage();
    const id = await createdId(store, backup);
    const before = await tokenOf(store, id);
    const counter = await store.changeCounter();
    const result = await editMonitor(store, key, id, backup, {
      renewHeartbeatUrl: true,
    });
    expect(result.ok).toBe(true);
    expect(await tokenOf(store, id)).not.toBe(before);
    expect(await store.changeCounter()).toBe(counter + 1);
  });

  test("an edit that does not ask keeps the URL", async () => {
    const store = await storage();
    const id = await createdId(store, backup);
    const before = await tokenOf(store, id);
    await editMonitor(store, key, id, { ...backup, name: "renamed" });
    expect(await tokenOf(store, id)).toBe(before);
  });

  test("a cron expression that parses but never fires, 30 February, is refused on create and on edit, and nothing is stored", async () => {
    const store = await storage();
    const never: MonitorInput = {
      ...backup,
      config: {
        schedule: { expression: "0 0 30 2 *", kind: "cron" },
        type: "heartbeat",
      },
    };
    expect(await createMonitor(store, key, never)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await store.monitors.list()).toEqual([]);
    const id = await createdId(store, backup);
    expect(await editMonitor(store, key, id, never)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect((await store.monitors.find(id))?.config).toEqual(backup.config);
  });

  test("a cron expression that fires is stored as typed", async () => {
    const store = await storage();
    const daily: MonitorInput = {
      ...backup,
      config: {
        graceMs: 3_600_000,
        schedule: { expression: "30 2 * * *", kind: "cron" },
        type: "heartbeat",
      },
    };
    const id = await createdId(store, daily);
    expect((await store.monitors.find(id))?.config).toEqual(daily.config);
  });
});

describe("a monitor's notification channels", () => {
  const channelFields = {
    config: {},
    locale: undefined,
    type: "webhook" as const,
  };

  test("the form offers every channel in creation order, with whether it applies to new monitors", async () => {
    const store = await storage();
    const ops = await store.channels.create({
      ...channelFields,
      appliesToNew: true,
      name: "ops",
    });
    const night = await store.channels.create({
      ...channelFields,
      appliesToNew: false,
      name: "night",
    });
    const form = await readMonitorForm(store, key, undefined, undefined);
    expect(form.ok && form.options.channels).toEqual([
      { appliesToNew: true, id: ops.id, name: "ops", type: "webhook" },
      { appliesToNew: false, id: night.id, name: "night", type: "webhook" },
    ]);
  });

  test("a saved monitor keeps the channels it selects, and an edit replaces them", async () => {
    const store = await storage();
    const ops = await store.channels.create({
      ...channelFields,
      appliesToNew: true,
      name: "ops",
    });
    const night = await store.channels.create({
      ...channelFields,
      appliesToNew: false,
      name: "night",
    });
    const id = await createdId(store, { ...site, channels: [ops.id] });
    expect((await store.monitors.find(id))?.channels).toEqual([ops.id]);
    await editMonitor(store, key, id, { ...site, channels: [night.id] });
    expect((await store.monitors.find(id))?.channels).toEqual([night.id]);
    const form = await readMonitorForm(store, key, id, undefined);
    expect(form.ok && form.monitor?.channels).toEqual([night.id]);
  });
});

describe("a duplicate's read", () => {
  test("a duplicate reads the original's fields as a new monitor with no credentials, saying it had some, and never a secret or a credential's name", async () => {
    const store = await storage();
    const id = await createdId(store, {
      ...secured,
      group: "الإنتاج",
      tags: ["ويب"],
    });
    const form = await readMonitorForm(store, key, undefined, undefined, id);
    if (!form.ok) {
      throw new Error(form.reason);
    }
    expect(form.monitor).toBe(undefined);
    expect(form.heartbeat).toBe(undefined);
    expect(form.credentials).toEqual({
      auth: undefined,
      headers: [],
      url: false,
    });
    expect(form.original?.hadCredentials).toBe(true);
    expect(form.original?.monitor).toEqual(await store.monitors.find(id));
    const text = JSON.stringify(form);
    for (const sealed of ["كلمة-سر", "key-1", "X-Api-Key", '"ops"']) {
      expect(text.includes(sealed)).toBe(false);
    }
  });

  test("reading a duplicate writes nothing: no monitor, no change counter", async () => {
    const store = await storage();
    const id = await createdId(store, secured);
    const before = await store.changeCounter();
    await readMonitorForm(store, key, undefined, undefined, id);
    expect(await store.changeCounter()).toBe(before);
    expect((await store.monitors.list()).length).toBe(1);
  });

  test("a duplicate of a monitor without credentials says it had none", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    const form = await readMonitorForm(store, key, undefined, undefined, id);
    expect(form.ok && form.original?.monitor.id).toBe(id);
    expect(form.ok && form.original?.hadCredentials).toBe(false);
  });

  test("credentials this install's key cannot open still count as credentials the operator types again", async () => {
    const store = await storage();
    const result = await createMonitor(
      store,
      await scratchInstallKey(),
      secured
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const form = await readMonitorForm(
      store,
      key,
      undefined,
      undefined,
      result.monitor.id
    );
    expect(form.ok && form.original?.hadCredentials).toBe(true);
  });

  test("a duplicate of a monitor that no longer exists is a blank new form", async () => {
    const store = await storage();
    const form = await readMonitorForm(
      store,
      key,
      undefined,
      undefined,
      "missing"
    );
    expect(form.ok).toBe(true);
    expect(form.ok && form.original).toBe(undefined);
  });

  test("an original this version cannot read is corrupt, and no database is unavailable", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "UPDATE monitors SET config = ? WHERE id = ?",
      ['{"type":"ping"}', id]
    );
    expect(await readMonitorForm(store, key, undefined, undefined, id)).toEqual(
      { id, ok: false, reason: "corrupt" }
    );
    expect(
      await readMonitorForm(broken(store), key, undefined, undefined, id)
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  test("an edit reads the monitor it edits, never a duplicate", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    const other = await createdId(store, { ...site, name: "أخرى" });
    const form = await readMonitorForm(store, key, id, undefined, other);
    expect(form.ok && form.monitor?.id).toBe(id);
    expect(form.ok && form.original).toBe(undefined);
  });

  test("a duplicate of a heartbeat monitor shows no URL, and saving it gives a token of its own", async () => {
    const store = await storage();
    const id = await createdId(store, backup);
    const form = await readMonitorForm(store, key, undefined, undefined, id);
    expect(form.ok && form.heartbeat).toBe(undefined);
    const original = form.ok ? form.original?.monitor : undefined;
    if (!original) {
      throw new Error("no original");
    }
    const copy = await createdId(store, {
      ...monitorFieldsSchema.parse(original),
      name: "نسخة",
    });
    expect(await tokenOf(store, copy)).not.toBe(await tokenOf(store, id));
  });
});

describe("the selection bar's changes", () => {
  const webhook = {
    appliesToNew: false,
    config: {},
    locale: undefined,
    type: "webhook" as const,
  };

  /** Three monitors, a heartbeat one among them, the first with the channel, the group and the tag the others lack. */
  async function mixed(store: Storage) {
    const ops = await store.channels.create({ ...webhook, name: "ops" });
    const ids = [
      await createdId(store, {
        ...site,
        channels: [ops.id],
        group: "الإنتاج",
        tags: ["عام"],
      }),
      await createdId(store, { ...site, name: "الثاني" }),
      await createdId(store, backup),
    ];
    return { ids, ops };
  }

  async function listed(store: Storage) {
    const result = await listMonitors(store, Date.now());
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.monitors;
  }

  test("adding a channel reaches the monitors that lack it, a heartbeat monitor among them, and moves the change counter once", async () => {
    const store = await storage();
    const { ids, ops } = await mixed(store);
    const before = await store.changeCounter();
    expect(
      await changeMonitors(store, ids, { channel: ops.id, kind: "add_channel" })
    ).toEqual({ count: 2, ok: true });
    expect(await store.changeCounter()).toBe(before + 1);
    expect((await listed(store)).map((monitor) => monitor.channels)).toEqual([
      [ops.id],
      [ops.id],
      [ops.id],
    ]);
  });

  test("removing a channel reaches the monitors that select it, and moves the change counter once", async () => {
    const store = await storage();
    const { ids, ops } = await mixed(store);
    const before = await store.changeCounter();
    expect(
      await changeMonitors(store, ids, {
        channel: ops.id,
        kind: "remove_channel",
      })
    ).toEqual({ count: 1, ok: true });
    expect(await store.changeCounter()).toBe(before + 1);
    expect((await listed(store)).map((monitor) => monitor.channels)).toEqual([
      [],
      [],
      [],
    ]);
  });

  test("setting the group reaches the monitors outside it, and no group takes every one out, each moving the change counter once", async () => {
    const store = await storage();
    const { ids } = await mixed(store);
    const before = await store.changeCounter();
    expect(
      await changeMonitors(store, ids, { group: "الإنتاج", kind: "set_group" })
    ).toEqual({ count: 2, ok: true });
    expect(await store.changeCounter()).toBe(before + 1);
    expect((await listed(store)).map((monitor) => monitor.group)).toEqual([
      "الإنتاج",
      "الإنتاج",
      "الإنتاج",
    ]);
    expect(
      await changeMonitors(store, ids, { group: undefined, kind: "set_group" })
    ).toEqual({ count: 3, ok: true });
    expect(await store.changeCounter()).toBe(before + 2);
    expect((await listed(store)).map((monitor) => monitor.group)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("adding a tag reaches the monitors that lack it, and removing it those that carry it, each moving the change counter once", async () => {
    const store = await storage();
    const { ids } = await mixed(store);
    const before = await store.changeCounter();
    expect(
      await changeMonitors(store, ids, { kind: "add_tag", tag: "عام" })
    ).toEqual({ count: 2, ok: true });
    expect(await store.changeCounter()).toBe(before + 1);
    expect((await listed(store)).map((monitor) => monitor.tags)).toEqual([
      ["عام"],
      ["عام"],
      ["عام"],
    ]);
    expect(
      await changeMonitors(store, ids.slice(1), {
        kind: "remove_tag",
        tag: "عام",
      })
    ).toEqual({ count: 2, ok: true });
    expect(await store.changeCounter()).toBe(before + 2);
    expect((await listed(store)).map((monitor) => monitor.tags)).toEqual([
      ["عام"],
      [],
      [],
    ]);
  });

  test("a change that changes no monitor answers ok with none reached and leaves the change counter where it was, so the public memo stays", async () => {
    const store = await storage();
    const { ids, ops } = await mixed(store);
    const [first = "", second = ""] = ids;
    const before = await store.changeCounter();
    const unchanged = [
      [[first], { channel: ops.id, kind: "add_channel" }],
      [[second], { channel: ops.id, kind: "remove_channel" }],
      [[first], { group: "الإنتاج", kind: "set_group" }],
      [[second], { group: undefined, kind: "set_group" }],
      [[first], { kind: "add_tag", tag: "عام" }],
      [[second], { kind: "remove_tag", tag: "عام" }],
    ] as const;
    for (const [some, change] of unchanged) {
      // biome-ignore lint/performance/noAwaitInLoops: one change at a time, each answered before the next
      expect(await changeMonitors(store, some, change)).toEqual({
        count: 0,
        ok: true,
      });
    }
    expect(await store.changeCounter()).toBe(before);
    // Bulk pause keeps its rule: every call moves the counter, even one that pauses none.
    await pauseMonitors(store, [first]);
    await pauseMonitors(store, [first]);
    expect(await store.changeCounter()).toBe(before + 2);
  });

  test("a channel that does not exist is refused as not found: nothing is written and the change counter stays", async () => {
    const store = await storage();
    const { ids } = await mixed(store);
    const before = await store.changeCounter();
    expect(
      await changeMonitors(store, ids, {
        channel: "missing",
        kind: "add_channel",
      })
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await store.changeCounter()).toBe(before);
  });

  test("a tag one of the monitors has no room for is refused as tags full: nothing is written and the change counter stays", async () => {
    const store = await storage();
    const roomy = await createdId(store, site);
    const full = await createdId(store, {
      ...site,
      tags: Array.from({ length: tagsMax }, (_, index) => `t${index}`),
    });
    const before = await store.changeCounter();
    expect(
      await changeMonitors(store, [roomy, full], {
        kind: "add_tag",
        tag: "حرج",
      })
    ).toEqual({ ok: false, reason: "tags_full" });
    expect(await store.changeCounter()).toBe(before);
    expect((await listed(store))[0]?.tags).toEqual([]);
  });

  test("a database that fails mid-change answers unavailable and never throws", async () => {
    const store = await storage();
    const failing = broken(store);
    const changes = [
      { channel: "c", kind: "add_channel" },
      { channel: "c", kind: "remove_channel" },
      { group: "g", kind: "set_group" },
      { kind: "add_tag", tag: "t" },
      { kind: "remove_tag", tag: "t" },
    ] as const;
    for (const change of changes) {
      // biome-ignore lint/performance/noAwaitInLoops: one change at a time, each answered before the next
      expect(await changeMonitors(failing, ["a"], change)).toEqual({
        ok: false,
        reason: "unavailable",
      });
    }
  });

  test("the list offers every channel in creation order, for the selection bar", async () => {
    const store = await storage();
    const ops = await store.channels.create({
      ...webhook,
      appliesToNew: true,
      name: "ops",
    });
    const night = await store.channels.create({ ...webhook, name: "night" });
    const result = await listMonitors(store, Date.now());
    expect(result.ok && result.channels).toEqual([
      { appliesToNew: true, id: ops.id, name: "ops", type: "webhook" },
      { appliesToNew: false, id: night.id, name: "night", type: "webhook" },
    ]);
  });
});

describe("the selection bar's changes, hardened", () => {
  test("a channel this version cannot read leaves the monitor list whole, offering no channel", async () => {
    const store = await storage();
    await createdId(store, site);
    const failing: Storage = {
      ...store,
      channels: {
        ...store.channels,
        list: () => Promise.reject(new ChannelShapeError("c-unreadable")),
      },
    };
    const listed = await listMonitors(failing, Date.now());
    expect(listed.ok && listed.monitors.length).toBe(1);
    expect(listed.ok && listed.channels).toEqual([]);
  });

  test("a channel list the database cannot answer leaves the list unavailable, never a list without its channels", async () => {
    const store = await storage();
    const failing: Storage = {
      ...store,
      channels: {
        ...store.channels,
        list: () => Promise.reject(new Error("database gone")),
      },
    };
    expect(await listMonitors(failing, Date.now())).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("a change to monitors that no longer exist reaches none, leaves no group or tag behind and moves no counter", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    expect(
      await changeMonitors(store, ["gone"], {
        group: "الليل",
        kind: "set_group",
      })
    ).toEqual({ count: 0, ok: true });
    expect(
      await changeMonitors(store, ["gone"], { kind: "add_tag", tag: "حرج" })
    ).toEqual({ count: 0, ok: true });
    expect(await store.monitors.organization()).toEqual({
      groups: [],
      tags: [],
    });
    expect(await store.changeCounter()).toBe(before);
  });
});

describe("a database monitor through the module", () => {
  const url = "postgres://watcher:s3cret@db.example.test:6543/app";
  const database: MonitorInput = {
    ...site,
    config: { query: "SELECT 'ok'", type: "postgres" },
    credentials: { headers: [], url },
    name: "قاعدة الطلبات",
  };
  /** Live I/O whose database answers the value, recording what it was asked. */
  const answering = (value: unknown) => {
    const asked: DatabaseQuery[] = [];
    const io = {
      ...liveIo(),
      queryDatabase: (query: DatabaseQuery) => {
        asked.push(query);
        return Promise.resolve(value);
      },
    };
    return { asked, io };
  };

  test("create seals the connection URL and keeps only its host and port in the clear, as the target", async () => {
    const store = await storage();
    const id = await createdId(store, database);
    expect(await storedCredentials(store, id)).toEqual({ headers: [], url });
    const sealed = (await store.monitors.credentialsOf(id)) ?? "";
    expect(sealed).not.toContain("s3cret");
    const monitor = await store.monitors.find(id);
    expect(monitor?.target).toBe("db.example.test:6543");
    expect(monitor?.config).toEqual({
      address: "db.example.test:6543",
      query: "SELECT 'ok'",
      type: "postgres",
    });
    const listed = await listMonitors(store, Date.now());
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    expect(JSON.stringify(listed)).not.toContain("watcher");
  });

  test("a new database monitor without a connection URL is refused, and nothing is written", async () => {
    const store = await storage();
    const { credentials: _, ...bare } = database;
    expect(await createMonitor(store, key, bare)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect((await store.monitors.list()).length).toBe(0);
  });

  test("an address the form posts is never trusted: the server writes the URL's own", async () => {
    const store = await storage();
    const id = await createdId(store, {
      ...database,
      config: { address: "elsewhere.example:1", type: "postgres" },
    });
    expect((await store.monitors.find(id))?.target).toBe(
      "db.example.test:6543"
    );
  });

  test("an edit that leaves the URL out keeps it; one that types a URL replaces it and its address", async () => {
    const store = await storage();
    const id = await createdId(store, database);
    const { credentials: _, ...kept } = database;
    expect((await editMonitor(store, key, id, { ...kept, name: "x" })).ok).toBe(
      true
    );
    expect(await storedCredentials(store, id)).toEqual({ headers: [], url });
    const moved = "postgresql://watcher:new@db2.example.test/app";
    await editMonitor(store, key, id, {
      ...database,
      credentials: { headers: [], url: moved },
    });
    expect(await storedCredentials(store, id)).toEqual({
      headers: [],
      url: moved,
    });
    expect((await store.monitors.find(id))?.target).toBe(
      "db2.example.test:5432"
    );
  });

  test("an edit to another check type that leaves the URL out is refused, since the stored URL is not that type's", async () => {
    const store = await storage();
    const id = await createdId(store, database);
    const { credentials: _, ...kept } = database;
    expect(
      await editMonitor(store, key, id, {
        ...kept,
        config: { type: "mysql" },
      })
    ).toEqual({ ok: false, reason: "invalid" });
    expect((await store.monitors.find(id))?.config.type).toBe("postgres");
  });

  test("an HTTP monitor turned into a database one drops its HTTP credentials, and back again drops the URL", async () => {
    const store = await storage();
    const id = await createdId(store, secured);
    await editMonitor(store, key, id, database);
    expect(await storedCredentials(store, id)).toEqual({ headers: [], url });
    await editMonitor(store, key, id, site);
    expect(await store.monitors.credentialsOf(id)).toBe(undefined);
  });

  test("the edit form says a URL is stored and never holds it", async () => {
    const store = await storage();
    const id = await createdId(store, database);
    const form = await readMonitorForm(store, key, id, undefined);
    expect(form.ok && form.credentials).toEqual({
      auth: undefined,
      headers: [],
      url: true,
    });
    expect(JSON.stringify(form)).not.toContain("s3cret");
    expect(JSON.stringify(form)).not.toContain("watcher");
  });

  test("test now runs the query with the posted URL and answers the value it got, recording nothing", async () => {
    const store = await storage();
    const { asked, io } = answering("ok");
    const result = await testMonitor(store, key, io, database, undefined);
    expect(result).toMatchObject({
      ok: true,
      test: { answer: "ok", reason: "ok", result: "up" },
    });
    expect(asked).toEqual([
      { query: "SELECT 'ok'", timeoutMs: 10_000, type: "postgres", url },
    ]);
    expect((await store.checks.latest()).length).toBe(0);
  });

  test("test now reads a left-out URL from the monitor it edits, and refuses one with nothing stored", async () => {
    const store = await storage();
    const id = await createdId(store, database);
    const { credentials: _, ...kept } = database;
    const { asked, io } = answering(1);
    expect((await testMonitor(store, key, io, kept, id)).ok).toBe(true);
    expect(asked[0]?.url).toBe(url);
    expect(await testMonitor(store, key, io, kept, undefined)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("test now masks the URL's password where the answer repeats it", async () => {
    const store = await storage();
    const { io } = answering("pass s3cret");
    const result = await testMonitor(store, key, io, database, undefined);
    expect(result).toMatchObject({
      ok: true,
      test: { answer: `pass ${credentialMask}` },
    });
  });

  test("test now shows a mismatch with the value the query answered", async () => {
    const store = await storage();
    const { io } = answering("degraded");
    const result = await testMonitor(
      store,
      key,
      io,
      {
        ...database,
        config: { expected: "ok", query: "SELECT 'ok'", type: "postgres" },
      },
      undefined
    );
    expect(result).toMatchObject({
      ok: true,
      test: {
        answer: "degraded",
        reason: "assertion_failed",
        result: "down",
      },
    });
  });
});

describe("the getting-started checklist above the list", () => {
  const channel = {
    appliesToNew: false,
    config: {},
    locale: undefined,
    name: "ops",
    type: "webhook" as const,
  };
  const component = (monitorIds: string[]) => ({
    description: undefined,
    monitorIds,
    name: { ar: "الموقع" },
    status: "operational" as const,
  });
  const page = (published: boolean, slug: string) => ({
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    locale: "ar" as const,
    published,
    slug,
    title: { ar: "حالة الخدمات" },
  });

  async function checklist(store: Storage) {
    const listed = await listMonitors(store, Date.now());
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    return listed.gettingStarted;
  }

  test("a fresh install's checklist has every line open", async () => {
    const store = await storage();
    expect(await checklist(store)).toEqual({
      channel: false,
      link: false,
      monitor: false,
      published: false,
    });
  });

  test("each line ticks once its thing exists; a paused monitor counts, a component linked to no monitor and an unpublished page tick nothing", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    expect(await pauseMonitors(store, [id])).toEqual({ count: 1, ok: true });
    await store.components.create(component([]));
    await store.pages.create(page(false, "draft"));
    expect(await checklist(store)).toEqual({
      channel: false,
      link: false,
      monitor: true,
      published: false,
    });
    await store.components.create(component([id]));
    expect(await checklist(store)).toEqual({
      channel: false,
      link: true,
      monitor: true,
      published: false,
    });
    await store.channels.create(channel);
    expect(await checklist(store)).toEqual({
      channel: true,
      link: true,
      monitor: true,
      published: false,
    });
  });

  test("the list carries the checklist until its last line is done, then none", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    await store.components.create(component([id]));
    await store.channels.create(channel);
    expect(await checklist(store)).toMatchObject({ published: false });
    await store.pages.create(page(true, "status"));
    expect(await checklist(store)).toBeUndefined();
  });

  test("once the list finds every step done it closes the checklist for good, and undoing a step never brings it back", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    await store.components.create(component([id]));
    const ops = await store.channels.create(channel);
    await store.pages.create(page(true, "status"));
    expect(await store.settings.get(gettingStartedClosed)).toBeUndefined();
    expect(await checklist(store)).toBeUndefined();
    expect(await store.settings.get(gettingStartedClosed)).toBe(true);
    await store.channels.remove(ops.id);
    await deleteMonitors(store, [id]);
    expect(await checklist(store)).toBeUndefined();
  });

  test("a failed store of done leaves the list whole, and the next read stores it", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    await store.components.create(component([id]));
    await store.channels.create(channel);
    await store.pages.create(page(true, "status"));
    const failing: Storage = {
      ...store,
      settings: {
        ...store.settings,
        set: () => Promise.reject(new Error("database gone")),
      },
    };
    const listed = await listMonitors(failing, Date.now());
    expect(listed.ok && listed.gettingStarted).toBeUndefined();
    expect(listed.ok && listed.monitors.length).toBe(1);
    expect(await store.settings.get(gettingStartedClosed)).toBeUndefined();
    expect(await checklist(store)).toBeUndefined();
    expect(await store.settings.get(gettingStartedClosed)).toBe(true);
  });

  test("the list carries no checklist once the operator dismissed it, and then asks nothing about pages", async () => {
    const store = await storage();
    expect(await dismissGettingStarted(store)).toEqual({ ok: true });
    let asked = 0;
    const counting: Storage = {
      ...store,
      pages: {
        ...store.pages,
        anyPublished: () => {
          asked += 1;
          return store.pages.anyPublished();
        },
      },
    };
    expect(await checklist(counting)).toBeUndefined();
    expect(asked).toBe(0);
  });

  test("a line unticks when its thing goes: deleting the one linked monitor leaves no component linked", async () => {
    const store = await storage();
    const id = await createdId(store, site);
    await store.components.create(component([id]));
    expect(await checklist(store)).toMatchObject({ link: true, monitor: true });
    await deleteMonitors(store, [id]);
    expect(await checklist(store)).toMatchObject({
      link: false,
      monitor: false,
    });
  });

  test("a pages read that fails leaves the list whole, with the published line open", async () => {
    const store = await storage();
    const failing: Storage = {
      ...store,
      pages: {
        ...store.pages,
        anyPublished: () => Promise.reject(new Error("database gone")),
      },
    };
    const listed = await listMonitors(failing, Date.now());
    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.gettingStarted).toMatchObject({
      published: false,
    });
  });

  test("a stored dismissal this version cannot read leaves the checklist showing and the list whole", async () => {
    const store = await storage();
    await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      ["getting_started_closed", '"yes"', 1]
    );
    expect(await checklist(store)).toEqual({
      channel: false,
      link: false,
      monitor: false,
      published: false,
    });
  });
});

describe("a Docker monitor through the module", () => {
  const docker: MonitorInput = {
    ...site,
    config: {
      container: "orders-api",
      endpoint: "/var/run/docker.sock",
      type: "docker",
    },
    name: "واجهة الطلبات",
  };

  test("create stores the endpoint and the container in the clear, no credentials, the container as the target", async () => {
    const store = await storage();
    const id = await createdId(store, docker);
    expect(await store.monitors.credentialsOf(id)).toBe(undefined);
    const monitor = await store.monitors.find(id);
    expect(monitor?.config).toEqual(docker.config);
    expect(monitor?.target).toBe("orders-api");
  });

  test("test now asks the daemon for the container and answers what the check saw, recording nothing", async () => {
    const store = await storage();
    const asked: DockerRequest[] = [];
    const io = {
      ...liveIo(),
      requestDocker: (request: DockerRequest) => {
        asked.push(request);
        return Promise.resolve({
          body: {
            Name: "/orders-api",
            State: { ExitCode: 0, Status: "paused" },
          },
          status: 200,
        });
      },
    };
    const result = await testMonitor(store, key, io, docker, undefined);
    expect(asked).toEqual([
      {
        endpoint: "/var/run/docker.sock",
        path: "/containers/orders-api/json",
        timeoutMs: docker.timeoutMs,
      },
    ]);
    expect(result.ok && result.test.reason).toBe("container_paused");
    expect(await store.checks.latest()).toEqual([]);
  });
});

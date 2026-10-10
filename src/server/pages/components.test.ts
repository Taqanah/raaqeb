import { afterEach, describe, expect, test } from "bun:test";
import { installLanguage } from "@/server/settings/language.ts";
import { runSql } from "@/server/storage/fixture.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  createComponent,
  deleteComponent,
  editComponent,
  listComponents,
  readComponentDays,
  readComponentForm,
} from "./components.ts";
import {
  checksEveryMinute,
  d0,
  day,
  hour,
  minute,
  type PagesScratch,
  scratchPages,
  site,
} from "./fixture.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

async function opened(): Promise<PagesScratch> {
  scratch = await scratchPages();
  return scratch;
}

const input = {
  monitorIds: [] as string[],
  name: { ar: "الموقع" },
  status: "operational" as const,
};

describe("the component list", () => {
  test("an install with no component lists none", async () => {
    const { storage } = await opened();
    expect(await listComponents(storage, d0)).toEqual({
      components: [],
      ok: true,
    });
  });

  test("each component shows its status now, how many pages show it and its uptime over 90 days", async () => {
    const { at, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 10 * hour, "up");
    await checksEveryMinute(
      storage,
      monitor,
      d0 + 10 * hour,
      d0 + 12 * hour,
      "down"
    );
    await storage.outages.open(monitor.id, d0 + 10 * hour, reasons.timeout);
    at(d0 + 1);
    const linked = await createComponent(storage, {
      ...input,
      monitorIds: [monitor.id],
    });
    at(d0 + 2);
    const unlinked = await createComponent(storage, {
      ...input,
      name: { ar: "الدعم" },
      status: "degraded_performance",
    });
    if (!(linked.ok && unlinked.ok)) {
      throw new Error("not created");
    }
    const page = await storage.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "status",
      title: { ar: "حالة" },
    });
    await storage.pages.save(page.id, page, [
      { componentId: linked.component.id, kind: "component" },
    ]);

    const listed = await listComponents(storage, d0 + 12 * hour);
    expect(listed).toEqual({
      components: [
        {
          component: linked.component,
          // The days themselves are the next test's.
          days: expect.any(Array),
          pages: 1,
          status: "major_outage",
          // Two hours down in twelve observed, rounded down.
          uptime: { decimals: 2, percent: 83.33 },
        },
        {
          component: unlinked.component,
          days: expect.any(Array),
          pages: 0,
          status: "degraded_performance",
          // A hand-set status keeps no history, so it is never downtime.
          uptime: { decimals: 0, percent: 100 },
        },
      ],
      ok: true,
    });
  });

  test("each component carries its last 30 days for its bar, oldest first, today last, beside its uptime over the 90 days", async () => {
    const { at, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    // Yesterday's last twelve hours up, then today's ten up and two down.
    await checksEveryMinute(storage, monitor, d0 - 12 * hour, d0, "up");
    await checksEveryMinute(storage, monitor, d0, d0 + 10 * hour, "up");
    await checksEveryMinute(
      storage,
      monitor,
      d0 + 10 * hour,
      d0 + 12 * hour,
      "down"
    );
    await storage.outages.open(monitor.id, d0 + 10 * hour, reasons.timeout);
    at(d0 + 1);
    await createComponent(storage, { ...input, monitorIds: [monitor.id] });
    const listed = await listComponents(storage, d0 + 12 * hour);
    // Two hours down in the two days' 24 observed, which neither day alone gives.
    expect(listed.ok && listed.components[0]?.uptime).toEqual({
      decimals: 2,
      percent: 91.66,
    });
    const days = (listed.ok && listed.components[0]?.days) || [];
    // A 30-day bar beside the 90-day uptime.
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({
      date: "2026-08-03",
      downtimeMs: 0,
      incidents: [],
      maintenance: [],
      observedMs: 0,
      responseMs: null,
      uptime: null,
    });
    expect(days.at(-1)).toEqual({
      date: "2026-09-01",
      downtimeMs: 2 * hour,
      incidents: [],
      maintenance: [],
      // The last check covers up to now: two hours down in twelve observed.
      observedMs: 12 * hour,
      responseMs: 120,
      uptime: { decimals: 2, percent: 83.33 },
    });
  });

  test("the uptime beside the 30-day bar still counts 90 days, so a day the bar no longer shows still weighs", async () => {
    const { at, storage } = await opened();
    // Forty days ago: an hour up, then an hour down; today: an hour up.
    const old = d0 - 40 * day;
    at(old - day);
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, old, old + hour, "up");
    await checksEveryMinute(
      storage,
      monitor,
      old + hour,
      old + 2 * hour,
      "down"
    );
    await storage.outages.open(monitor.id, old + hour, reasons.timeout);
    await storage.outages.close(monitor.id, old + 2 * hour);
    await checksEveryMinute(storage, monitor, d0, d0 + hour, "up");
    await createComponent(storage, { ...input, monitorIds: [monitor.id] });
    const listed = await listComponents(storage, d0 + hour);
    const item = listed.ok ? listed.components[0] : undefined;
    expect(item?.days.every((each) => each.downtimeMs === 0)).toBe(true);
    // One hour down in 2 h 59 min observed: the old span's last check covers nothing after it.
    expect(item?.uptime).toEqual({ decimals: 2, percent: 66.48 });
  });

  test("a component shown by two pages counts both", async () => {
    const { storage } = await opened();
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    for (const slug of ["one", "two"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two pages, one after the other
      const page = await storage.pages.create({
        customDomain: undefined,
        customization: defaultCustomization,
        isDefault: false,
        published: true,
        locale: "ar",
        slug,
        title: { ar: slug },
      });
      await storage.pages.save(page.id, page, [
        { componentId: created.component.id, kind: "component" },
      ]);
    }
    const listed = await listComponents(storage, d0);
    expect(listed.ok && listed.components[0]?.pages).toBe(2);
  });

  test("the days span exactly the days asked for, today last, oldest first", async () => {
    const { storage } = await opened();
    await createComponent(storage, input);
    const now = d0 + 100 * day + 5 * hour;
    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 90, now }
    );
    const cells = [...days.values()][0] ?? [];
    expect(cells).toHaveLength(90);
    expect(cells[0]?.day).toBe(d0 + 11 * day);
    expect(cells.at(-1)?.day).toBe(d0 + 100 * day);
  });

  test("a sealed day of a linked monitor reads the observed time on its daily rollup", async () => {
    const { at, location, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 6 * hour, "up");
    await storage.checks.seal(monitor.id, d0, 2 * minute, []);
    // A rollup's observed time is the sealed day's truth, even where the checks would say otherwise.
    await runSql(
      location,
      "UPDATE daily_rollups SET observed_ms = ? WHERE monitor_id = ?",
      [1234, monitor.id]
    );
    at(d0 + 1);
    await createComponent(storage, { ...input, monitorIds: [monitor.id] });
    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 2, now: d0 + day + hour }
    );
    expect([...days.values()][0]?.[0]).toEqual({
      day: d0,
      downtimeMs: 0,
      incidents: [],
      maintenance: [],
      observedMs: 1234,
      responseMs: 120,
    });
  });

  test("a component whose monitors were paused while down keeps its outage after their checks are purged", async () => {
    const { at, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + hour, "down");
    await storage.outages.open(monitor.id, d0, reasons.timeout);
    at(d0 + hour);
    await storage.monitors.pause([monitor.id]);
    await createComponent(storage, { ...input, monitorIds: [monitor.id] });
    // Retention takes the checks; the outage the pause closed stays.
    await storage.checks.purge(monitor.id, {
      daily: d0 + day,
      hourly: d0 + day,
      raw: d0 + day,
    });
    expect(await storage.checks.latest()).toEqual([]);
    const listed = await listComponents(storage, d0 + 40 * day);
    expect(listed.ok && listed.components[0]?.status).toBe("major_outage");
  });

  test("a closed day no pass could seal reads from its checks, even with a later day sealed", async () => {
    const { at, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 6 * hour, "up");
    await checksEveryMinute(
      storage,
      monitor,
      d0 + day,
      d0 + day + 6 * hour,
      "up"
    );
    // The first day stays in the head, as when its seal keeps failing; the next one seals.
    await storage.checks.seal(monitor.id, d0 + day, 2 * minute, []);
    at(d0 + 1);
    await createComponent(storage, { ...input, monitorIds: [monitor.id] });
    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 3, now: d0 + 2 * day + hour }
    );
    const cells = [...days.values()][0] ?? [];
    expect(cells[0]).toEqual({
      day: d0,
      downtimeMs: 0,
      incidents: [],
      maintenance: [],
      observedMs: 6 * hour - minute,
      responseMs: 120,
    });
  });

  test("a component whose monitors have never been checked has no uptime", async () => {
    const { storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await createComponent(storage, { ...input, monitorIds: [monitor.id] });
    const listed = await listComponents(storage, d0 + day);
    expect(listed.ok && listed.components.map((each) => each.uptime)).toEqual([
      undefined,
    ]);
  });

  test("the component whose monitors were paused last keeps their status, not an older pause's", async () => {
    const { at, storage } = await opened();
    const a = await storage.monitors.create({ ...site, name: "A" });
    const b = await storage.monitors.create({ ...site, name: "B" });
    await checksEveryMinute(storage, a, d0, d0 + hour, "down");
    await checksEveryMinute(storage, b, d0, d0 + 2 * hour, "up");
    at(d0 + hour);
    await storage.monitors.pause([a.id]);
    at(d0 + 2 * hour);
    await storage.monitors.pause([b.id]);
    await createComponent(storage, { ...input, monitorIds: [a.id, b.id] });
    const listed = await listComponents(storage, d0 + 3 * hour);
    expect(listed.ok && listed.components[0]?.status).toBe("operational");
  });

  test("a stored component this version cannot read is named", async () => {
    const { location, storage } = await opened();
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    await runSql(location, "UPDATE components SET status = ? WHERE id = ?", [
      "on_fire",
      created.component.id,
    ]);
    expect(await listComponents(storage, d0)).toEqual({
      id: created.component.id,
      ok: false,
      reason: "corrupt",
    });
  });

  test("a monitor this version cannot read is named, so the operator can act on it", async () => {
    const { location, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await createComponent(storage, { ...input, monitorIds: [monitor.id] });
    await runSql(location, "UPDATE monitors SET config = ? WHERE id = ?", [
      "{}",
      monitor.id,
    ]);
    expect(await listComponents(storage, d0)).toEqual({
      id: monitor.id,
      ok: false,
      reason: "corrupt",
    });
  });

  test("a heartbeat monitor's day reads with its own gap limit, the expected period and grace, not the interval", async () => {
    const { at, storage } = await opened();
    const beat = await storage.monitors.create({
      ...site,
      config: { schedule: { everyMs: hour, kind: "every" }, type: "heartbeat" },
    });
    // One heartbeat check an hour: with the 60 s interval as the limit, nothing would be observed.
    for (let time = d0; time < d0 + 6 * hour; time += hour) {
      // biome-ignore lint/performance/noAwaitInLoops: the head table's rows go in one at a time
      await storage.checks.record({
        capture: undefined,
        check: {
          attempts: 1,
          bytes: 0,
          monitorId: beat.id,
          reason: reasons.ok,
          responseMs: undefined,
          result: "up",
          startedAt: time,
          statusCode: undefined,
        },
        detail: undefined,
      });
    }
    at(d0 + 1);
    await createComponent(storage, { ...input, monitorIds: [beat.id] });
    const listed = await listComponents(storage, d0 + 6 * hour);
    expect(listed.ok && listed.components[0]?.uptime).toEqual({
      decimals: 0,
      percent: 100,
    });
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const { cleanup, storage } = await opened();
    await cleanup();
    scratch = undefined;
    expect(await listComponents(storage, d0)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("a component's status and bar under incidents", () => {
  const author = "owner@example.com";

  test("an open incident's status shows on the component, and a resolved one's no longer does", async () => {
    const { storage } = await opened();
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const { id } = created.component;
    const incident = await storage.incidents.create(
      { impact: "major", title: { ar: "بطء" } },
      {
        author,
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: id, status: "partial_outage" }],
      }
    );
    const listed = await listComponents(storage, d0 + hour);
    expect(listed.ok && listed.components[0]?.status).toBe("partial_outage");
    await storage.incidents.post(
      incident.id,
      {
        author,
        message: { ar: "حُلّت." },
        stage: "resolved",
        statuses: [{ componentId: id, status: "partial_outage" }],
      },
      [],
      incident.updates.at(-1)?.id ?? ""
    );
    const after = await listComponents(storage, d0 + hour);
    expect(after.ok && after.components[0]?.status).toBe("operational");
  });

  test("the time an incident held a component at major outage is downtime on its bar, and degraded performance is not", async () => {
    const { at, storage } = await opened();
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const { id } = created.component;
    at(d0 + hour);
    const incident = await storage.incidents.create(
      { impact: "major", title: { ar: "بطء" } },
      {
        author,
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: id, status: "major_outage" }],
      }
    );
    at(d0 + 3 * hour);
    await storage.incidents.post(
      incident.id,
      {
        author,
        message: { ar: "نتابع." },
        stage: "monitoring",
        statuses: [{ componentId: id, status: "degraded_performance" }],
      },
      [],
      incident.updates.at(-1)?.id ?? ""
    );
    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 1, now: d0 + 6 * hour }
    );
    expect(days.get(id)).toEqual([
      {
        day: d0,
        downtimeMs: 2 * hour,
        incidents: [{ id: incident.id, title: { ar: "بطء" } }],
        maintenance: [],
        observedMs: 6 * hour,
        responseMs: undefined,
      },
    ]);
  });

  test("a stored component's form names the open incidents that set its status", async () => {
    const { at, storage } = await opened();
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const { id } = created.component;
    const statuses = [{ componentId: id, status: "major_outage" as const }];
    const first = await storage.incidents.create(
      { impact: "major", title: { ar: "الأولى" } },
      { author, message: { ar: "نحقق." }, stage: "investigating", statuses }
    );
    at(d0 + 1);
    const done = await storage.incidents.create(
      { impact: "minor", title: { ar: "محلولة" } },
      { author, message: { ar: "نحقق." }, stage: "investigating", statuses }
    );
    await storage.incidents.post(
      done.id,
      { author, message: { ar: "حُلّت." }, stage: "resolved", statuses },
      [],
      done.updates.at(-1)?.id ?? ""
    );
    at(d0 + 2);
    // An open incident on another component is not this one's.
    const other = await createComponent(storage, {
      ...input,
      name: { ar: "API" },
    });
    if (!other.ok) {
      throw new Error(other.reason);
    }
    await storage.incidents.create(
      { impact: "minor", title: { ar: "أخرى" } },
      {
        author,
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: other.component.id, status: "major_outage" }],
      }
    );
    const form = await readComponentForm(storage, id);
    expect(form.ok && form.form.incidents).toEqual([
      { id: first.id, title: { ar: "الأولى" } },
    ]);
    expect(form.ok && form.form.status).toBe("major_outage");
  });
});

describe("the component form", () => {
  test("the new form lists every monitor to link, with its state and whether it is paused", async () => {
    const { storage } = await opened();
    const a = await storage.monitors.create({ ...site, name: "A" });
    const b = await storage.monitors.create({
      ...site,
      config: { host: "db.example.test", port: 5432, type: "tcp" },
      name: "B",
    });
    await storage.monitors.pause([b.id]);
    await checksEveryMinute(storage, a, d0, d0 + 2 * 60_000, "degraded");
    expect(await readComponentForm(storage, undefined)).toEqual({
      form: {
        component: undefined,
        incidents: [],
        maintenance: [],
        monitors: [
          {
            id: a.id,
            name: "A",
            paused: false,
            state: "degraded",
            target: "https://example.test/",
          },
          {
            id: b.id,
            name: "B",
            paused: true,
            state: undefined,
            target: "db.example.test:5432",
          },
        ],
        pages: [],
        status: undefined,
      },
      ok: true,
    });
  });

  test("a stored component's form carries it, its status now and the pages that show it", async () => {
    const { storage } = await opened();
    const created = await createComponent(storage, {
      ...input,
      status: "partial_outage",
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const page = await storage.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "status",
      title: { ar: "حالة الخدمات" },
    });
    await storage.pages.save(page.id, page, [
      {
        componentIds: [created.component.id],
        kind: "group",
        name: { ar: "G" },
      },
    ]);
    // A page that does not show it is not listed.
    await storage.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "other",
      title: { ar: "أخرى" },
    });
    const form = await readComponentForm(storage, created.component.id);
    expect(form.ok && form.form.component).toEqual(created.component);
    expect(form.ok && form.form.status).toBe("partial_outage");
    expect(form.ok && form.form.pages).toEqual([
      { id: page.id, title: { ar: "حالة الخدمات" } },
    ]);
  });

  test("an unknown component's form is not found", async () => {
    const { storage } = await opened();
    expect(await readComponentForm(storage, "nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("creating, editing and deleting a component", () => {
  test("a new component is stored with its links, and moves the change counter", async () => {
    const { storage } = await opened();
    const monitor = await storage.monitors.create(site);
    const before = await storage.changeCounter();
    const created = await createComponent(storage, {
      description: { ar: "المتجر" },
      monitorIds: [monitor.id],
      name: { ar: "الموقع" },
      status: "operational",
    });
    expect(created.ok && created.component).toMatchObject({
      description: { ar: "المتجر" },
      monitorIds: [monitor.id],
      name: { ar: "الموقع" },
      status: "operational",
    });
    expect(await storage.changeCounter()).toBe(before + 1);
  });

  test("an edit replaces the fields and the links, and moves the change counter", async () => {
    const { storage } = await opened();
    const monitor = await storage.monitors.create(site);
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const before = await storage.changeCounter();
    const edited = await editComponent(storage, created.component.id, {
      monitorIds: [monitor.id],
      name: { ar: "API" },
      status: "major_outage",
    });
    expect(edited.ok && edited.component).toMatchObject({
      id: created.component.id,
      monitorIds: [monitor.id],
      name: { ar: "API" },
      status: "major_outage",
    });
    expect(await storage.changeCounter()).toBe(before + 1);
  });

  test("an edit of an unknown component is not found and moves nothing", async () => {
    const { storage } = await opened();
    const before = await storage.changeCounter();
    expect(await editComponent(storage, "nope", input)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await storage.changeCounter()).toBe(before);
  });

  test("a delete takes the component off every page and moves the change counter", async () => {
    const { storage } = await opened();
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const page = await storage.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "status",
      title: { ar: "حالة" },
    });
    await storage.pages.save(page.id, page, [
      { componentId: created.component.id, kind: "component" },
    ]);
    const before = await storage.changeCounter();
    expect(await deleteComponent(storage, created.component.id)).toEqual({
      ok: true,
    });
    expect(await storage.pages.layout(page.id)).toEqual([]);
    expect(await storage.changeCounter()).toBe(before + 1);
    expect(await deleteComponent(storage, created.component.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("a write the database refuses is unavailable, never a throw", async () => {
    const { cleanup, storage } = await opened();
    await cleanup();
    scratch = undefined;
    expect(await createComponent(storage, input)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("a component's status and bar under maintenance", () => {
  test("a component a window in progress affects lists as under maintenance, over its monitors' outage", async () => {
    const { storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + hour, "down");
    await storage.outages.open(monitor.id, d0, reasons.timeout);
    const created = await createComponent(storage, {
      ...input,
      monitorIds: [monitor.id],
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    await storage.maintenance.create({
      componentIds: [created.component.id],
      endsAt: d0 + 2 * hour,
      message: { ar: "نص" },
      startsAt: d0 + 30 * minute,
      title: { ar: "صيانة" },
    });
    const before = await listComponents(storage, d0 + hour);
    expect(before.ok && before.components[0]?.status).toBe("major_outage");
    await storage.maintenance.advance(d0 + hour);
    const during = await listComponents(storage, d0 + hour);
    expect(during.ok && during.components[0]?.status).toBe("under_maintenance");
  });

  test("a window's time is neither observed time nor downtime on the bar of its component, nor of another component its covered monitor drives", async () => {
    const { storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 2 * hour, "up");
    await checksEveryMinute(
      storage,
      monitor,
      d0 + 2 * hour,
      d0 + 4 * hour,
      "down"
    );
    await checksEveryMinute(
      storage,
      monitor,
      d0 + 4 * hour,
      d0 + 6 * hour,
      "up"
    );
    await storage.outages.open(monitor.id, d0 + 2 * hour, reasons.timeout);
    await storage.outages.close(monitor.id, d0 + 4 * hour);
    const inWindow = await createComponent(storage, {
      ...input,
      monitorIds: [monitor.id],
    });
    const beside = await createComponent(storage, {
      ...input,
      monitorIds: [monitor.id],
      name: { ar: "API" },
    });
    if (!(inWindow.ok && beside.ok)) {
      throw new Error("the components were not created");
    }
    const window = await storage.maintenance.create({
      componentIds: [inWindow.component.id],
      endsAt: d0 + 5 * hour,
      message: { ar: "نص" },
      startsAt: d0 + hour,
      title: { ar: "صيانة" },
    });
    await storage.maintenance.advance(d0 + hour);
    await storage.maintenance.advance(d0 + 5 * hour);
    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 1, now: d0 + 6 * hour }
    );
    const uptime = {
      day: d0,
      downtimeMs: 0,
      incidents: [],
      observedMs: 2 * hour,
      responseMs: 120,
    };
    expect(days.get(inWindow.component.id)).toEqual([
      { ...uptime, maintenance: [{ id: window.id, title: { ar: "صيانة" } }] },
    ]);
    expect(days.get(beside.component.id)).toEqual([
      { ...uptime, maintenance: [] },
    ]);
  });
});

describe("an unlinked component's bar under maintenance", () => {
  test("the time a window held a component set by hand is not observed time", async () => {
    const { storage } = await opened();
    const created = await createComponent(storage, input);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const window = await storage.maintenance.create({
      componentIds: [created.component.id],
      endsAt: d0 + 3 * hour,
      message: { ar: "نص" },
      startsAt: d0 + hour,
      title: { ar: "صيانة" },
    });
    await storage.maintenance.advance(d0 + hour);
    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 1, now: d0 + 6 * hour }
    );
    expect(days.get(created.component.id)).toEqual([
      {
        day: d0,
        downtimeMs: 0,
        incidents: [],
        maintenance: [{ id: window.id, title: { ar: "صيانة" } }],
        observedMs: 4 * hour,
        responseMs: undefined,
      },
    ]);
  });
});

describe("a component's content in each locale", () => {
  test("its name and description are kept in each locale they are written in", async () => {
    const { storage } = await opened();
    const created = await createComponent(storage, {
      ...input,
      description: { ar: "المتجر", en: "The shop" },
      name: { ar: "الموقع", en: "Website" },
    });
    expect(created.ok && created.component.name).toEqual({
      ar: "الموقع",
      en: "Website",
    });
    const id = created.ok ? created.component.id : "";
    expect((await storage.components.find(id))?.description).toEqual({
      ar: "المتجر",
      en: "The shop",
    });
  });

  test("a name or a description without the install language's text is refused, on create and on edit", async () => {
    const { storage } = await opened();
    await storage.settings.set(installLanguage, "en");
    const before = await storage.changeCounter();
    expect(await createComponent(storage, input)).toEqual({
      ok: false,
      reason: "invalid",
    });
    const created = await createComponent(storage, {
      ...input,
      name: { ar: "الموقع", en: "Website" },
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    expect(
      await editComponent(storage, created.component.id, {
        ...input,
        description: { ar: "المتجر" },
        name: { en: "Website" },
      })
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await storage.changeCounter()).toBe(before + 1);
    expect((await storage.components.find(created.component.id))?.name).toEqual(
      { ar: "الموقع", en: "Website" }
    );
  });

  test("a description in the other locale alone is refused even when the name holds the install language's text", async () => {
    const { storage } = await opened();
    expect(
      await createComponent(storage, {
        ...input,
        description: { en: "The shop" },
      })
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("with no install language stored, Arabic is the one required", async () => {
    const { storage } = await opened();
    expect(
      await createComponent(storage, { ...input, name: { en: "Website" } })
    ).toEqual({ ok: false, reason: "invalid" });
    expect((await createComponent(storage, input)).ok).toBe(true);
  });
});

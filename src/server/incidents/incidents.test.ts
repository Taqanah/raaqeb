import { afterEach, describe, expect, test } from "bun:test";
import type { Announce, SubscriberEvent } from "@/server/notify/subscribers.ts";
import { deleteComponent } from "@/server/pages/components.ts";
import {
  checksEveryMinute,
  d0,
  hour,
  minute,
  type PagesScratch,
  scratchPages,
  site,
} from "@/server/pages/fixture.ts";
import { installLanguage } from "@/server/settings/language.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type {
  IncidentCreateInput,
  IncidentSaveResult,
} from "@/shared/schemas/incident.ts";
import type { HandSetLevel } from "@/shared/schemas/status.ts";
import {
  createIncident,
  deleteIncident,
  editIncident,
  fixUpdate,
  listIncidents,
  postUpdate,
  readIncident,
  readNewIncident,
} from "./incidents.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

async function opened(): Promise<PagesScratch> {
  scratch = await scratchPages();
  return scratch;
}

const author = "owner@example.com";

async function component(
  storage: Storage,
  name: string,
  monitorIds: readonly string[] = [],
  status: HandSetLevel = "operational"
): Promise<string> {
  const created = await storage.components.create({
    description: undefined,
    monitorIds,
    name: { ar: name },
    status,
  });
  return created.id;
}

function opening(
  statuses: IncidentCreateInput["statuses"],
  overrides: Partial<IncidentCreateInput> = {}
): IncidentCreateInput {
  return {
    impact: "major",
    message: { ar: "نحقق في بطء صفحات الدفع." },
    stage: "investigating",
    statuses,
    title: { ar: "بطء في الدفع" },
    ...overrides,
  };
}

/** The incident a result carries; fails the test on a refusal. */
function saved(result: IncidentSaveResult) {
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.incident;
}

describe("opening an incident", () => {
  test("it is stored with its first update, signed by the operator, and moves the change counter", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const before = await storage.changeCounter();
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    expect(incident).toMatchObject({
      impact: "major",
      resolvedAt: undefined,
      title: { ar: "بطء في الدفع" },
      updates: [
        {
          author,
          message: { ar: "نحقق في بطء صفحات الدفع." },
          stage: "investigating",
          statuses: [{ componentId: web, status: "major_outage" }],
        },
      ],
    });
    expect(await storage.changeCounter()).toBe(before + 1);
  });

  test("an incident that names no component that exists is refused as invalid and nothing is stored", async () => {
    const { storage } = await opened();
    const before = await storage.changeCounter();
    expect(
      await createIncident(
        storage,
        opening([{ componentId: "gone", status: "major_outage" }]),
        author
      )
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await storage.incidents.list()).toEqual([]);
    expect(await storage.changeCounter()).toBe(before);
  });
});

describe("a component deleted while the incident is written", () => {
  test("an incident whose component was deleted after the module read it is refused as invalid and nothing is stored", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const listed = await storage.components.list();
    await storage.components.remove(web);
    // The module read the components before the other tab's delete landed.
    const stale: Storage = {
      ...storage,
      components: {
        ...storage.components,
        list: () => Promise.resolve(listed),
      },
    };
    expect(
      await createIncident(
        stale,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await storage.incidents.list()).toEqual([]);
  });
});

describe("deleting a component an incident affects", () => {
  test("an open incident left with no component goes with it, off the list and its page as off every status page", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    expect(await deleteComponent(storage, web)).toEqual({ ok: true });
    expect(await listIncidents(storage, d0)).toEqual({
      list: { anyComponent: false, incidents: [], now: d0 },
      ok: true,
    });
    expect(await readIncident(storage, incident.id, d0)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("a resolved incident left with no component goes too, as it leaves the status page's history", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    at(d0 + hour);
    saved(
      await postUpdate(
        storage,
        incident.id,
        { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
        author
      )
    );
    await deleteComponent(storage, web);
    expect(await readIncident(storage, incident.id, d0 + hour)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("an incident that still affects another component stays, naming only that one, and one that never named it stays whole", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const both = saved(
      await createIncident(
        storage,
        opening([
          { componentId: web, status: "major_outage" },
          { componentId: api, status: "partial_outage" },
        ]),
        author
      )
    );
    at(d0 + minute);
    const other = saved(
      await createIncident(
        storage,
        opening([{ componentId: api, status: "degraded_performance" }]),
        author
      )
    );
    await deleteComponent(storage, web);
    const listed = await listIncidents(storage, d0);
    expect(
      listed.ok &&
        listed.list.incidents.map((each) => [each.id, each.components])
    ).toEqual([
      [other.id, [{ id: api, name: { ar: "API" } }]],
      [both.id, [{ id: api, name: { ar: "API" } }]],
    ]);
  });
});

describe("the incidents list", () => {
  test("open incidents come first, then resolved ones, each newest first, with their stage and affected components' names", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const old = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }], {
          title: { ar: "قديمة" },
        }),
        author
      )
    );
    at(d0 + hour);
    const open = saved(
      await createIncident(
        storage,
        opening(
          [
            { componentId: api, status: "partial_outage" },
            { componentId: web, status: "degraded_performance" },
          ],
          { stage: "identified", title: { ar: "مفتوحة" } }
        ),
        author
      )
    );
    at(d0 + 2 * hour);
    const resolved = saved(
      await createIncident(
        storage,
        opening([{ componentId: api, status: "major_outage" }], {
          title: { ar: "محلولة" },
        }),
        author
      )
    );
    at(d0 + 3 * hour);
    await postUpdate(
      storage,
      resolved.id,
      { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
      author
    );
    const listed = await listIncidents(storage, d0 + 4 * hour);
    expect(listed).toEqual({
      list: {
        anyComponent: true,
        incidents: [
          {
            components: [
              { id: web, name: { ar: "الموقع" } },
              { id: api, name: { ar: "API" } },
            ],
            createdAt: d0 + hour,
            id: open.id,
            impact: "major",
            resolvedAt: undefined,
            stage: "identified",
            title: { ar: "مفتوحة" },
          },
          {
            components: [{ id: web, name: { ar: "الموقع" } }],
            createdAt: d0,
            id: old.id,
            impact: "major",
            resolvedAt: undefined,
            stage: "investigating",
            title: { ar: "قديمة" },
          },
          {
            components: [{ id: api, name: { ar: "API" } }],
            createdAt: d0 + 2 * hour,
            id: resolved.id,
            impact: "major",
            resolvedAt: d0 + 3 * hour,
            stage: "resolved",
            title: { ar: "محلولة" },
          },
        ],
        now: d0 + 4 * hour,
      },
      ok: true,
    });
  });

  test("a stored incident this version cannot read is named as corrupt", async () => {
    const { location, storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    await runSql(location, "UPDATE incidents SET impact = 'catastrophic'");
    expect(await listIncidents(storage, d0)).toEqual({
      id: incident.id,
      ok: false,
      reason: "corrupt",
    });
  });
});

describe("the incident list before any component exists", () => {
  test("it says no component exists, so none can publish, until one does", async () => {
    const { storage } = await opened();
    const before = await listIncidents(storage, d0);
    expect(before).toMatchObject({ list: { anyComponent: false }, ok: true });
    await component(storage, "الموقع");
    const after = await listIncidents(storage, d0);
    expect(after).toMatchObject({ list: { anyComponent: true }, ok: true });
  });
});

describe("the new-incident page", () => {
  test("it offers every component with its status now and whether monitors drive it, with nothing prefilled", async () => {
    const { storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 2 * minute, "down");
    const web = await component(storage, "الموقع", [monitor.id]);
    const api = await component(storage, "API");
    expect(await readNewIncident(storage, undefined)).toEqual({
      form: {
        components: [
          {
            id: web,
            linked: true,
            name: { ar: "الموقع" },
            status: "major_outage",
          },
          {
            id: api,
            linked: false,
            name: { ar: "API" },
            status: "operational",
          },
        ],
        prefill: undefined,
      },
      ok: true,
    });
  });

  test("from a monitor's open-incident link, its name is the title and the components linked to it are chosen at their status now", async () => {
    const { storage } = await opened();
    const down = await storage.monitors.create({
      ...site,
      name: "بوابة الدفع",
    });
    const up = await storage.monitors.create({ ...site, name: "Other" });
    await checksEveryMinute(storage, down, d0, d0 + 2 * minute, "down");
    await checksEveryMinute(storage, up, d0, d0 + 2 * minute, "up");
    const payments = await component(storage, "المدفوعات", [down.id, up.id]);
    await component(storage, "الموقع", [up.id]);
    const checkout = await component(storage, "الدفع", [down.id]);
    const result = await readNewIncident(storage, down.id);
    expect(result.ok && result.form.prefill).toEqual({
      statuses: [
        { componentId: payments, status: "partial_outage" },
        { componentId: checkout, status: "major_outage" },
      ],
      title: "بوابة الدفع",
    });
  });

  test("a monitor that no longer exists prefills nothing", async () => {
    const { storage } = await opened();
    const result = await readNewIncident(storage, "gone");
    expect(result.ok && result.form.prefill).toBeUndefined();
  });
});

describe("an incident's page", () => {
  test("it reads the incident with its updates and every component with its status now", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    expect(await readIncident(storage, incident.id, d0 + hour)).toEqual({
      ok: true,
      page: {
        components: [
          {
            id: web,
            linked: false,
            name: { ar: "الموقع" },
            status: "major_outage",
          },
        ],
        incident,
        now: d0 + hour,
      },
    });
  });

  test("an unknown incident is not found", async () => {
    const { storage } = await opened();
    expect(await readIncident(storage, "nope", d0)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("an update of an open incident", () => {
  test("it moves the stage and sets each affected component's status, and may add a component", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    at(d0 + minute);
    const updated = saved(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "عرفنا السبب." },
          stage: "identified",
          statuses: [
            { componentId: web, status: "partial_outage" },
            { componentId: api, status: "degraded_performance" },
          ],
        },
        "second@example.com"
      )
    );
    expect(updated.updates.at(-1)).toMatchObject({
      author: "second@example.com",
      createdAt: d0 + minute,
      stage: "identified",
      statuses: [
        { componentId: web, status: "partial_outage" },
        { componentId: api, status: "degraded_performance" },
      ],
    });
  });

  test("one that leaves out a component the incident affects is refused as invalid and writes nothing", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const incident = saved(
      await createIncident(
        storage,
        opening([
          { componentId: web, status: "major_outage" },
          { componentId: api, status: "major_outage" },
        ]),
        author
      )
    );
    expect(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "عرفنا السبب." },
          stage: "identified",
          statuses: [{ componentId: web, status: "operational" }],
        },
        author
      )
    ).toEqual({ ok: false, reason: "invalid" });
    expect((await storage.incidents.find(incident.id))?.updates).toHaveLength(
      1
    );
  });

  test("an update of a resolved incident is refused as resolved, whatever components it names", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    await postUpdate(
      storage,
      incident.id,
      { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
      author
    );
    expect(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "عادت." },
          stage: "investigating",
          statuses: [{ componentId: api, status: "major_outage" }],
        },
        author
      )
    ).toEqual({ ok: false, reason: "resolved" });
  });

  test("an update of an unknown incident is not found", async () => {
    const { storage } = await opened();
    expect(
      await postUpdate(
        storage,
        "nope",
        { keep: true, message: { ar: "حُلّت." }, stage: "resolved" },
        author
      )
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("an update's edges", () => {
  test("a component the update names that does not exist is skipped, beside the affected ones", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    const updated = saved(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "نتابع." },
          stage: "monitoring",
          statuses: [
            { componentId: web, status: "operational" },
            { componentId: "gone", status: "major_outage" },
          ],
        },
        author
      )
    );
    expect(updated.updates.at(-1)?.statuses).toEqual([
      { componentId: web, status: "operational" },
    ]);
  });

  test("once every affected component is deleted, the incident is gone and an update to it is not found", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    await storage.components.remove(web);
    expect(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "نتابع." },
          stage: "monitoring",
          statuses: [{ componentId: "gone", status: "major_outage" }],
        },
        author
      )
    ).toEqual({ ok: false, reason: "not_found" });
  });

  test("resolving one of two open incidents on a component set by hand leaves it at the other's status", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع");
    const first = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    at(d0 + minute);
    saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "degraded_performance" }]),
        author
      )
    );
    await postUpdate(
      storage,
      first.id,
      { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
      author
    );
    const page = await readIncident(storage, first.id, d0 + hour);
    expect(page.ok && page.page.components[0]?.status).toBe(
      "degraded_performance"
    );
    expect((await storage.components.find(web))?.status).toBe("operational");
  });

  test("an update refused after the incident was read answers resolved, not found once the incident is gone, or changed while it stays open", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    const input = {
      message: { ar: "نتابع." },
      stage: "monitoring" as const,
      statuses: [{ componentId: web, status: "operational" as const }],
    };
    const racing = (
      found: readonly (typeof incident | undefined)[]
    ): Storage => {
      const reads = [...found];
      return {
        ...storage,
        incidents: {
          ...storage.incidents,
          find: () => Promise.resolve(reads.shift()),
          post: () => Promise.resolve(undefined),
        },
      };
    };
    expect(
      await postUpdate(
        racing([incident, { ...incident, resolvedAt: d0 + hour }]),
        incident.id,
        input,
        author
      )
    ).toEqual({ ok: false, reason: "resolved" });
    expect(
      await postUpdate(
        racing([incident, undefined]),
        incident.id,
        input,
        author
      )
    ).toEqual({ ok: false, reason: "not_found" });
    // Still open: another update landed since the read.
    expect(
      await postUpdate(racing([incident, incident]), incident.id, input, author)
    ).toEqual({ ok: false, reason: "changed" });
  });
});

describe("two updates at once", () => {
  test("an update written from a read that another update overtook is refused as changed and writes nothing", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    at(d0 + minute);
    // Another tab adds a component.
    saved(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "والبريد أيضا." },
          stage: "identified",
          statuses: [
            { componentId: web, status: "major_outage" },
            { componentId: api, status: "major_outage" },
          ],
        },
        author
      )
    );
    // This tab read the incident before that update landed.
    const reads: (typeof incident | undefined)[] = [incident];
    const stale: Storage = {
      ...storage,
      incidents: {
        ...storage.incidents,
        find: (id) => {
          const read = reads.shift();
          return read ? Promise.resolve(read) : storage.incidents.find(id);
        },
      },
    };
    at(d0 + 2 * minute);
    expect(
      await postUpdate(
        stale,
        incident.id,
        {
          message: { ar: "نتابع." },
          stage: "monitoring",
          statuses: [{ componentId: web, status: "degraded_performance" }],
        },
        author
      )
    ).toEqual({ ok: false, reason: "changed" });
    expect((await storage.incidents.find(incident.id))?.updates).toHaveLength(
      2
    );
  });
});

describe("resolving an incident", () => {
  async function resolving(keep: boolean) {
    const { at, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 2 * minute, "up");
    const byHand = await component(
      storage,
      "الموقع",
      [],
      "degraded_performance"
    );
    const linked = await component(storage, "API", [monitor.id]);
    const incident = saved(
      await createIncident(
        storage,
        opening([
          { componentId: byHand, status: "partial_outage" },
          { componentId: linked, status: "major_outage" },
        ]),
        author
      )
    );
    at(d0 + hour);
    const resolved = saved(
      await postUpdate(
        storage,
        incident.id,
        { keep, message: { ar: "حُلّت المشكلة." }, stage: "resolved" },
        author
      )
    );
    return { byHand, linked, resolved, storage };
  }

  test("by default a component set by hand returns to the status it had before the incident, and the resolving update records it", async () => {
    const { byHand, linked, resolved, storage } = await resolving(false);
    expect(resolved.resolvedAt).toBe(d0 + hour);
    // A linked component follows its monitors, so the resolving update records nothing for it.
    expect(resolved.updates.at(-1)).toMatchObject({
      stage: "resolved",
      statuses: [{ componentId: byHand, status: "degraded_performance" }],
    });
    expect(linked).not.toBe(byHand);
    expect((await storage.components.find(byHand))?.status).toBe(
      "degraded_performance"
    );
  });

  test("with keep, a component set by hand keeps the status the incident set, as its hand-set status", async () => {
    const { byHand, resolved, storage } = await resolving(true);
    // Keep never reaches the linked component, so the resolving update records only this one.
    expect(resolved.updates.at(-1)?.statuses).toEqual([
      { componentId: byHand, status: "partial_outage" },
    ]);
    expect((await storage.components.find(byHand))?.status).toBe(
      "partial_outage"
    );
  });

  test.each([false, true])(
    "a linked component's hand-set status is never written, keep or not: it follows its monitors again (keep: %p)",
    async (keep) => {
      const { linked, storage } = await resolving(keep);
      expect(await storage.components.find(linked)).toMatchObject({
        status: "operational",
        updatedAt: d0,
      });
    }
  );
});

describe("the status a component had before the incident", () => {
  test("opening an incident keeps each component's status as the page showed it just before: set by hand, derived from its monitors, under maintenance", async () => {
    const { at, storage } = await opened();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 2 * minute, "down");
    const byHand = await component(
      storage,
      "البريد الإلكتروني",
      [],
      "degraded_performance"
    );
    const linked = await component(storage, "API", [monitor.id]);
    const serviced = await component(storage, "البحث");
    await storage.maintenance.create({
      componentIds: [serviced],
      endsAt: d0 + hour,
      message: { ar: "صيانة" },
      startsAt: d0,
      title: { ar: "صيانة البحث" },
    });
    await storage.maintenance.advance(d0);
    at(d0 + 2 * minute);
    const incident = saved(
      await createIncident(
        storage,
        opening([
          { componentId: byHand, status: "major_outage" },
          { componentId: linked, status: "major_outage" },
          { componentId: serviced, status: "partial_outage" },
        ]),
        author
      )
    );
    expect(incident.updates[0]?.statuses).toEqual([
      {
        before: "degraded_performance",
        componentId: byHand,
        status: "major_outage",
      },
      { before: "major_outage", componentId: linked, status: "major_outage" },
      {
        before: "under_maintenance",
        componentId: serviced,
        status: "partial_outage",
      },
    ]);
  });

  test("a later update keeps it for a component it adds and for no component already named; the resolving update keeps none", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API", [], "partial_outage");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    at(d0 + minute);
    const updated = saved(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "يمتد إلى الواجهة." },
          stage: "identified",
          statuses: [
            { componentId: web, status: "major_outage" },
            { componentId: api, status: "major_outage" },
          ],
        },
        author
      )
    );
    expect(updated.updates.at(-1)?.statuses).toEqual([
      { componentId: web, status: "major_outage" },
      { before: "partial_outage", componentId: api, status: "major_outage" },
    ]);
    at(d0 + hour);
    const resolved = saved(
      await postUpdate(
        storage,
        incident.id,
        { keep: true, message: { ar: "حُلّت." }, stage: "resolved" },
        author
      )
    );
    expect(
      resolved.updates.at(-1)?.statuses.every((each) => !("before" in each))
    ).toBe(true);
  });
});

describe("edges of the status before an incident", () => {
  test("a second incident on a component set by hand keeps the first's status as its status before, yet resolving both returns the component to its own hand-set status", async () => {
    const { at, storage } = await opened();
    const web = await component(storage, "الموقع", [], "degraded_performance");
    const first = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    at(d0 + minute);
    const second = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "partial_outage" }]),
        author
      )
    );
    expect(second.updates[0]?.statuses[0]?.before).toBe("major_outage");
    for (const id of [first.id, second.id]) {
      // biome-ignore lint/performance/noAwaitInLoops: the incidents resolve one after the other
      await postUpdate(
        storage,
        id,
        { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
        author
      );
    }
    expect((await storage.components.find(web))?.status).toBe(
      "degraded_performance"
    );
  });

  test("an incident written before Raaqeb kept the status before still returns a component set by hand to its own status", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع", [], "partial_outage");
    const old = await storage.incidents.create(
      { impact: "minor", title: { ar: "قديمة" } },
      {
        author,
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: web, status: "major_outage" }],
      }
    );
    const resolved = saved(
      await postUpdate(
        storage,
        old.id,
        { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
        author
      )
    );
    expect(resolved.updates.at(-1)?.statuses).toEqual([
      { componentId: web, status: "partial_outage" },
    ]);
  });
});

describe("fixing an update's text", () => {
  test("only the text changes, on a resolved incident too", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    await postUpdate(
      storage,
      incident.id,
      { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
      author
    );
    const [update] = incident.updates;
    if (!update) {
      throw new Error("no first update");
    }
    const fixed = saved(
      await fixUpdate(storage, incident.id, update.id, { ar: "نحقق في البطء." })
    );
    expect(fixed.updates[0]).toEqual({
      ...update,
      message: { ar: "نحقق في البطء." },
    });
  });

  test("an unknown update is not found", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    expect(await fixUpdate(storage, incident.id, "nope", { ar: "نص" })).toEqual(
      {
        ok: false,
        reason: "not_found",
      }
    );
  });
});

describe("editing and deleting an incident", () => {
  test("an edit replaces the title and the impact level", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    const edited = saved(
      await editIncident(storage, incident.id, {
        impact: "critical",
        title: { ar: "توقف الدفع" },
      })
    );
    expect(edited).toMatchObject({
      impact: "critical",
      title: { ar: "توقف الدفع" },
    });
  });

  test("an edit or a delete of an unknown incident is not found", async () => {
    const { storage } = await opened();
    expect(
      await editIncident(storage, "nope", {
        impact: "none",
        title: { ar: "x" },
      })
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await deleteIncident(storage, "nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("a delete takes the incident and its updates away", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    expect(await deleteIncident(storage, incident.id)).toEqual({ ok: true });
    expect(await storage.incidents.find(incident.id)).toBeUndefined();
  });
});

describe("every incident write moves the change counter", () => {
  test("open, edit, update, resolve, fix and delete each move it once", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const moved: number[] = [];
    let last = await storage.changeCounter();
    const step = async () => {
      const now = await storage.changeCounter();
      moved.push(now - last);
      last = now;
    };
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    await step();
    await editIncident(storage, incident.id, {
      impact: "minor",
      title: { ar: "بطء" },
    });
    await step();
    await postUpdate(
      storage,
      incident.id,
      {
        message: { ar: "نتابع." },
        stage: "monitoring",
        statuses: [{ componentId: web, status: "degraded_performance" }],
      },
      author
    );
    await step();
    await postUpdate(
      storage,
      incident.id,
      { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
      author
    );
    await step();
    await fixUpdate(storage, incident.id, incident.updates[0]?.id ?? "", {
      ar: "نص",
    });
    await step();
    await deleteIncident(storage, incident.id);
    await step();
    expect(moved).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test("a refused write moves nothing", async () => {
    const { storage } = await opened();
    const before = await storage.changeCounter();
    await editIncident(storage, "nope", {
      impact: "minor",
      title: { ar: "بطء" },
    });
    await fixUpdate(storage, "nope", "nope", { ar: "نص" });
    await deleteIncident(storage, "nope");
    expect(await storage.changeCounter()).toBe(before);
  });
});

describe("a storage that cannot answer", () => {
  test("every read and write answers unavailable, never throws", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const failing = () => Promise.reject(new Error("the database is gone"));
    const broken: Storage = {
      ...storage,
      incidents: {
        activeSince: failing,
        create: failing,
        edit: failing,
        find: failing,
        fix: failing,
        list: failing,
        open: failing,
        post: failing,
        remove: failing,
      },
    };
    const unavailable = { ok: false, reason: "unavailable" } as const;
    expect(await listIncidents(broken, d0)).toEqual(unavailable);
    expect(await readNewIncident(broken, undefined)).toEqual(unavailable);
    expect(await readIncident(broken, "i", d0)).toEqual(unavailable);
    expect(
      await createIncident(
        broken,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    ).toEqual(unavailable);
    expect(
      await editIncident(broken, "i", { impact: "none", title: { ar: "x" } })
    ).toEqual(unavailable);
    expect(
      await postUpdate(
        broken,
        "i",
        { keep: false, message: { ar: "x" }, stage: "resolved" },
        author
      )
    ).toEqual(unavailable);
    expect(await fixUpdate(broken, "i", "u", { ar: "x" })).toEqual(unavailable);
    expect(await deleteIncident(broken, "i")).toEqual(unavailable);
  });
});

describe("an incident's subscriber events", () => {
  /** An announce that records what it is handed, and when, against the change counter. */
  function recorder(storage: Storage) {
    const events: { counter: number; event: SubscriberEvent }[] = [];
    const announce: Announce = async (event) => {
      events.push({ counter: await storage.changeCounter(), event });
    };
    return { announce, events };
  }

  test("opening one announces incident published, after the write and its counter move", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const { announce, events } = recorder(storage);
    const before = await storage.changeCounter();
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author,
        announce
      )
    );
    expect(events).toEqual([
      {
        counter: before + 1,
        event: { incidentId: incident.id, type: "incident.published" },
      },
    ]);
  });

  test("every update announces incident updated, the resolving one too", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const { announce, events } = recorder(storage);
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    saved(
      await postUpdate(
        storage,
        incident.id,
        {
          message: { ar: "عرفنا السبب." },
          stage: "identified",
          statuses: [{ componentId: web, status: "partial_outage" }],
        },
        author,
        announce
      )
    );
    saved(
      await postUpdate(
        storage,
        incident.id,
        { keep: false, message: { ar: "حُلّت." }, stage: "resolved" },
        author,
        announce
      )
    );
    expect(events.map(({ event }) => event)).toEqual([
      { incidentId: incident.id, type: "incident.updated" },
      { incidentId: incident.id, type: "incident.updated" },
    ]);
  });

  test("a refused write announces nothing, and neither do an edit, a fix of an update's text or a delete", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const { announce, events } = recorder(storage);
    await createIncident(storage, opening([]), author, announce);
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    await postUpdate(
      storage,
      incident.id,
      { message: { ar: "بلا مكوّن" }, stage: "identified", statuses: [] },
      author,
      announce
    );
    await postUpdate(
      storage,
      "unknown",
      {
        message: { ar: "لا حادثة" },
        stage: "identified",
        statuses: [{ componentId: web, status: "partial_outage" }],
      },
      author,
      announce
    );
    await editIncident(storage, incident.id, {
      impact: "minor",
      title: { ar: "عنوان آخر" },
    });
    await fixUpdate(storage, incident.id, incident.updates[0]?.id ?? "", {
      ar: "نص مصحح",
    });
    await deleteIncident(storage, incident.id);
    expect(events).toEqual([]);
  });
});

describe("an incident's content in each locale", () => {
  test("its title and each update's text are kept in each locale they are written in", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }], {
          message: { ar: "نحقق.", en: "Looking into it." },
          title: { ar: "بطء", en: "Slow" },
        }),
        author
      )
    );
    expect((await storage.incidents.find(incident.id))?.title).toEqual({
      ar: "بطء",
      en: "Slow",
    });
    expect(incident.updates[0]?.message).toEqual({
      ar: "نحقق.",
      en: "Looking into it.",
    });
  });

  test("a title or a text without the install language's is refused when opening, updating, editing or fixing, and nothing is written", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const incident = saved(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }]),
        author
      )
    );
    const before = await storage.changeCounter();
    const english = { en: "English only" };
    const invalid = { ok: false, reason: "invalid" } as const;
    expect(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }], {
          title: english,
        }),
        author
      )
    ).toEqual(invalid);
    expect(
      await createIncident(
        storage,
        opening([{ componentId: web, status: "major_outage" }], {
          message: english,
        }),
        author
      )
    ).toEqual(invalid);
    expect(
      await postUpdate(
        storage,
        incident.id,
        {
          message: english,
          stage: "identified",
          statuses: [{ componentId: web, status: "major_outage" }],
        },
        author
      )
    ).toEqual(invalid);
    expect(
      await editIncident(storage, incident.id, {
        impact: "minor",
        title: english,
      })
    ).toEqual(invalid);
    expect(
      await fixUpdate(
        storage,
        incident.id,
        incident.updates[0]?.id ?? "",
        english
      )
    ).toEqual(invalid);
    expect(await storage.changeCounter()).toBe(before);
    expect(await storage.incidents.find(incident.id)).toEqual(incident);
  });

  test("an English install takes English text alone", async () => {
    const { storage } = await opened();
    await storage.settings.set(installLanguage, "en");
    const web = await component(storage, "Website");
    const result = await createIncident(
      storage,
      opening([{ componentId: web, status: "major_outage" }], {
        message: { en: "Looking into it." },
        title: { en: "Slow" },
      }),
      author
    );
    expect(result.ok).toBe(true);
  });
});

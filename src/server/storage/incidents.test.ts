import { afterEach, describe, expect, test } from "bun:test";
import type { ComponentFields } from "@/shared/schemas/component.ts";
import type { Incident, IncidentFields } from "@/shared/schemas/incident.ts";
import {
  type ComponentsRepository,
  componentsRepository,
} from "./components.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import {
  IncidentShapeError,
  type IncidentsRepository,
  incidentsRepository,
  NoAffectedComponentError,
  type UpdateFields,
} from "./incidents.ts";
import { migrateDatabase } from "./migrate.ts";
import type { DatabaseLocation } from "./storage.ts";

let open: { cleanup: () => Promise<void>; connection: Connection } | undefined;

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const t0 = 1_700_000_000_000;

async function repositories(): Promise<{
  components: ComponentsRepository;
  incidents: IncidentsRepository;
  location: DatabaseLocation;
  tick: (ms: number) => void;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  await migrateDatabase(connection);
  const run = executor(connection);
  let time = t0;
  const now = () => time;
  return {
    components: componentsRepository(run, now),
    incidents: incidentsRepository(run, now),
    location: scratch.location,
    tick: (ms) => {
      time += ms;
    },
  };
}

function component(name: string): ComponentFields {
  return {
    description: undefined,
    monitorIds: [],
    name: { ar: name },
    status: "operational",
  };
}

const fields: IncidentFields = {
  impact: "major",
  title: { ar: "بطء في الدفع" },
};

/** A first update that sets a status on the component, since a stored incident always affects one. */
function on(componentId: string): Partial<UpdateFields> {
  return { statuses: [{ componentId, status: "major_outage" }] };
}

/** The latest update's id: what a caller read before posting the next one. */
function latest(incident: Incident | undefined): string {
  return incident?.updates.at(-1)?.id ?? "";
}

function first(overrides: Partial<UpdateFields> = {}): UpdateFields {
  return {
    author: "owner@example.com",
    message: { ar: "نحقق في بطء صفحات الدفع." },
    stage: "investigating",
    statuses: [],
    ...overrides,
  };
}

describe("the incidents repository", () => {
  test("an incident is stored with its first update and the statuses it set, and read back whole", async () => {
    const { components, incidents } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(
      fields,
      first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
    );
    const [update] = created.updates;
    expect(created).toEqual({
      createdAt: t0,
      id: created.id,
      impact: "major",
      resolvedAt: undefined,
      title: { ar: "بطء في الدفع" },
      updatedAt: t0,
      updates: [
        {
          author: "owner@example.com",
          createdAt: t0,
          id: update?.id ?? "",
          message: { ar: "نحقق في بطء صفحات الدفع." },
          stage: "investigating",
          statuses: [{ componentId: web.id, status: "major_outage" }],
        },
      ],
    });
    expect(update?.id).not.toBe(created.id);
    expect(await incidents.find(created.id)).toEqual(created);
  });

  test("a status for a component that does not exist is skipped", async () => {
    const { components, incidents } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(
      fields,
      first({
        statuses: [
          { componentId: "no-such-component", status: "major_outage" },
          { componentId: web.id, status: "partial_outage" },
        ],
      })
    );
    expect(created.updates[0]?.statuses).toEqual([
      { componentId: web.id, status: "partial_outage" },
    ]);
  });

  test("an incident none of whose components exists by the time it is written is not stored", async () => {
    const { incidents, location } = await repositories();
    const error = await incidents
      .create(
        fields,
        first({ statuses: [{ componentId: "gone", status: "major_outage" }] })
      )
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(NoAffectedComponentError);
    for (const table of ["incidents", "incident_updates"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two counts, one after the other
      const [row] = await runSql(
        location,
        `SELECT COUNT(*) AS n FROM ${table}`
      );
      expect(Number(row?.n)).toBe(0);
    }
  });

  test("an update's statuses come back in the components' creation order, whatever order they were given in", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    tick(1);
    const api = await components.create(component("API"));
    const created = await incidents.create(
      fields,
      first({
        statuses: [
          { componentId: api.id, status: "major_outage" },
          { componentId: web.id, status: "degraded_performance" },
        ],
      })
    );
    expect(
      created.updates[0]?.statuses.map((each) => each.componentId)
    ).toEqual([web.id, api.id]);
  });

  test("an update is added after the others with its own time, stage, text and statuses, and moves the incident's update time", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const created = await incidents.create(
      fields,
      first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
    );
    tick(60_000);
    const updated = await incidents.post(
      created.id,
      {
        author: "second@example.com",
        message: { ar: "عُرف السبب: قاعدة البيانات." },
        stage: "identified",
        statuses: [
          { componentId: web.id, status: "partial_outage" },
          { componentId: api.id, status: "degraded_performance" },
        ],
      },
      [],
      latest(created)
    );
    expect(updated?.updatedAt).toBe(t0 + 60_000);
    expect(updated?.resolvedAt).toBeUndefined();
    expect(updated?.updates.map((each) => each.stage)).toEqual([
      "investigating",
      "identified",
    ]);
    expect(updated?.updates[1]).toMatchObject({
      author: "second@example.com",
      createdAt: t0 + 60_000,
      message: { ar: "عُرف السبب: قاعدة البيانات." },
      statuses: [
        { componentId: web.id, status: "partial_outage" },
        { componentId: api.id, status: "degraded_performance" },
      ],
    });
  });

  test("a resolving update resolves the incident at its time and writes the given hand-set statuses", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create({
      ...component("API"),
      status: "degraded_performance",
    });
    const created = await incidents.create(
      fields,
      first({
        statuses: [
          { componentId: web.id, status: "major_outage" },
          { componentId: api.id, status: "major_outage" },
        ],
      })
    );
    tick(3_600_000);
    const resolved = await incidents.post(
      created.id,
      first({
        message: { ar: "حُلّت المشكلة." },
        stage: "resolved",
        statuses: [
          { componentId: web.id, status: "operational" },
          { componentId: api.id, status: "major_outage" },
        ],
      }),
      [{ componentId: web.id, status: "major_outage" }],
      latest(created)
    );
    expect(resolved?.resolvedAt).toBe(t0 + 3_600_000);
    expect(await components.find(web.id)).toMatchObject({
      status: "major_outage",
      updatedAt: t0 + 3_600_000,
    });
    // A component not handed over keeps its own hand-set status.
    expect((await components.find(api.id))?.status).toBe(
      "degraded_performance"
    );
  });

  test("an update of a resolved incident is refused and writes nothing, hand-set statuses included", async () => {
    const { components, incidents, location } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(
      fields,
      first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
    );
    const resolved = await incidents.post(
      created.id,
      first({ stage: "resolved", statuses: [] }),
      [],
      latest(created)
    );
    expect(
      await incidents.post(
        created.id,
        first({ stage: "resolved", statuses: [] }),
        [{ componentId: web.id, status: "major_outage" }],
        latest(resolved)
      )
    ).toBeUndefined();
    expect((await incidents.find(created.id))?.updates).toHaveLength(2);
    expect((await components.find(web.id))?.status).toBe("operational");
    const [row] = await runSql(
      location,
      "SELECT COUNT(*) AS n FROM incident_updates"
    );
    expect(Number(row?.n)).toBe(2);
  });

  test("an update of an unknown incident answers nothing and writes nothing", async () => {
    const { components, incidents, location } = await repositories();
    const web = await components.create(component("الموقع"));
    expect(
      await incidents.post(
        "nope",
        first({
          stage: "resolved",
          statuses: [{ componentId: web.id, status: "major_outage" }],
        }),
        [{ componentId: web.id, status: "major_outage" }],
        ""
      )
    ).toBeUndefined();
    expect((await components.find(web.id))?.status).toBe("operational");
    const [row] = await runSql(
      location,
      "SELECT COUNT(*) AS n FROM incident_updates"
    );
    expect(Number(row?.n)).toBe(0);
  });

  test("an update is refused and writes nothing when another landed since the caller read the incident", async () => {
    const { components, incidents, location } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const created = await incidents.create(
      fields,
      first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
    );
    await incidents.post(
      created.id,
      first({
        stage: "identified",
        statuses: [
          { componentId: web.id, status: "major_outage" },
          { componentId: api.id, status: "major_outage" },
        ],
      }),
      [],
      latest(created)
    );
    // Read before the update above landed: it would drop the component that update added.
    expect(
      await incidents.post(
        created.id,
        first({
          stage: "resolved",
          statuses: [{ componentId: web.id, status: "operational" }],
        }),
        [{ componentId: web.id, status: "operational" }],
        latest(created)
      )
    ).toBeUndefined();
    const stored = await incidents.find(created.id);
    expect(stored?.resolvedAt).toBeUndefined();
    expect(stored?.updates).toHaveLength(2);
    const [row] = await runSql(
      location,
      "SELECT COUNT(*) AS n FROM incident_updates"
    );
    expect(Number(row?.n)).toBe(2);
  });

  test("an update is never stamped before the one it follows, even when the clock steps back", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(
      fields,
      first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
    );
    tick(-5000);
    const resolved = await incidents.post(
      created.id,
      first({
        stage: "resolved",
        statuses: [{ componentId: web.id, status: "operational" }],
      }),
      [],
      latest(created)
    );
    expect(resolved?.resolvedAt).toBe(t0 + 1);
    expect(
      resolved?.updates.map((each) => [each.stage, each.createdAt])
    ).toEqual([
      ["investigating", t0],
      ["resolved", t0 + 1],
    ]);
  });

  test("the list holds every incident in creation order; open leaves out the resolved; active since a time keeps those resolved after it", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const a = await incidents.create(
      { ...fields, title: { ar: "A" } },
      first(on(web.id))
    );
    tick(1000);
    const b = await incidents.create(
      { ...fields, title: { ar: "B" } },
      first(on(web.id))
    );
    tick(1000);
    const c = await incidents.create(
      { ...fields, title: { ar: "C" } },
      first(on(web.id))
    );
    await incidents.post(a.id, first({ stage: "resolved" }), [], latest(a));
    tick(1000);
    await incidents.post(c.id, first({ stage: "resolved" }), [], latest(c));
    const ids = (list: readonly { id: string }[]) =>
      list.map((each) => each.id);
    expect(ids(await incidents.list())).toEqual([a.id, b.id, c.id]);
    expect(ids(await incidents.open())).toEqual([b.id]);
    // a resolved at t0 + 2000, c at t0 + 3000.
    expect(ids(await incidents.activeSince(t0 + 2000))).toEqual([b.id, c.id]);
    expect(ids(await incidents.activeSince(t0))).toEqual([a.id, b.id, c.id]);
  });

  test("an incident resolved exactly at a time is not active since it", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(fields, first(on(web.id)));
    tick(1000);
    await incidents.post(
      created.id,
      first({ stage: "resolved" }),
      [],
      latest(created)
    );
    expect(await incidents.activeSince(t0 + 1000)).toEqual([]);
    expect(await incidents.activeSince(t0 + 999)).toHaveLength(1);
  });

  test("an edit replaces the title and the impact level and moves the update time, open or resolved", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(fields, first(on(web.id)));
    tick(1);
    await incidents.post(
      created.id,
      first({ stage: "resolved" }),
      [],
      latest(created)
    );
    tick(5000);
    const edited = await incidents.edit(created.id, {
      impact: "minor",
      title: { ar: "بطء متقطع في الدفع" },
    });
    expect(edited).toMatchObject({
      createdAt: t0,
      impact: "minor",
      resolvedAt: t0 + 1,
      title: { ar: "بطء متقطع في الدفع" },
      updatedAt: t0 + 5001,
    });
    expect(edited?.updates).toHaveLength(2);
  });

  test("an edit of an unknown incident answers nothing and changes no other", async () => {
    const { components, incidents } = await repositories();
    const web = await components.create(component("الموقع"));
    const stored = await incidents.create(fields, first(on(web.id)));
    expect(
      await incidents.edit("nope", { impact: "minor", title: { ar: "آخر" } })
    ).toBeUndefined();
    expect(await incidents.find(stored.id)).toEqual(stored);
  });

  test("a fix replaces one update's text alone", async () => {
    const { components, incidents, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(
      fields,
      first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
    );
    tick(5000);
    const [update] = created.updates;
    if (!update) {
      throw new Error("no first update");
    }
    const fixed = await incidents.fix(created.id, update.id, {
      ar: "نحقق في بطء صفحة الدفع.",
    });
    expect(fixed?.updates).toEqual([
      { ...update, message: { ar: "نحقق في بطء صفحة الدفع." } },
    ]);
    expect(fixed?.updatedAt).toBe(t0 + 5000);
  });

  test("a fix of an unknown update, or of another incident's update, answers nothing and changes nothing", async () => {
    const { components, incidents } = await repositories();
    const web = await components.create(component("الموقع"));
    const a = await incidents.create(fields, first(on(web.id)));
    const b = await incidents.create(fields, first(on(web.id)));
    const aUpdate = a.updates[0]?.id ?? "";
    expect(
      await incidents.fix(b.id, aUpdate, { ar: "مكتوب فوقه" })
    ).toBeUndefined();
    expect(
      await incidents.fix(a.id, "nope", { ar: "مكتوب فوقه" })
    ).toBeUndefined();
    expect(
      await incidents.fix("nope", aUpdate, { ar: "مكتوب فوقه" })
    ).toBeUndefined();
    expect(await incidents.find(a.id)).toEqual(a);
  });

  test("deleting an incident deletes its updates and their statuses, and says whether it existed", async () => {
    const { components, incidents, location } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await incidents.create(
      fields,
      first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
    );
    expect(await incidents.remove(created.id)).toBe(true);
    expect(await incidents.remove(created.id)).toBe(false);
    expect(await incidents.find(created.id)).toBeUndefined();
    for (const table of ["incident_updates", "incident_statuses"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two counts, one after the other
      const [row] = await runSql(
        location,
        `SELECT COUNT(*) AS n FROM ${table}`
      );
      expect(Number(row?.n)).toBe(0);
    }
    expect(await components.find(web.id)).toBeDefined();
  });

  test("deleting a component drops its statuses from every update and leaves the incident", async () => {
    const { components, incidents } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const created = await incidents.create(
      fields,
      first({
        statuses: [
          { componentId: web.id, status: "major_outage" },
          { componentId: api.id, status: "major_outage" },
        ],
      })
    );
    await components.remove(web.id);
    expect((await incidents.find(created.id))?.updates[0]?.statuses).toEqual([
      { componentId: api.id, status: "major_outage" },
    ]);
  });

  test("the status before is kept beside the status of a component an update names for the first time, and read back as its before; one without reads without it", async () => {
    const { components, incidents } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const created = await incidents.create(
      fields,
      first({
        before: new Map([[web.id, "degraded_performance"]]),
        statuses: [{ componentId: web.id, status: "major_outage" }],
      })
    );
    expect(created.updates[0]?.statuses).toEqual([
      {
        before: "degraded_performance",
        componentId: web.id,
        status: "major_outage",
      },
    ]);
    const updated = await incidents.post(
      created.id,
      first({
        before: new Map([[api.id, "under_maintenance"]]),
        stage: "identified",
        statuses: [
          // Its own before is never written: the update's map says what each component showed.
          {
            before: "partial_outage",
            componentId: web.id,
            status: "major_outage",
          },
          { componentId: api.id, status: "partial_outage" },
        ],
      }),
      [],
      latest(created)
    );
    expect(updated?.updates[1]?.statuses).toEqual([
      { componentId: web.id, status: "major_outage" },
      {
        before: "under_maintenance",
        componentId: api.id,
        status: "partial_outage",
      },
    ]);
    expect(await incidents.find(created.id)).toEqual(updated);
  });

  test("an unknown id reads as nothing", async () => {
    const { components, incidents } = await repositories();
    // A stored incident, so a lookup that ignored the id would find it.
    const web = await components.create(component("الموقع"));
    await incidents.create(fields, first(on(web.id)));
    expect(await incidents.find("nope")).toBeUndefined();
  });

  test.each([
    "UPDATE incidents SET impact = 'catastrophic'",
    "UPDATE incident_updates SET stage = 'postmortem'",
    "UPDATE incident_statuses SET status = 'under_maintenance'",
    "UPDATE incident_statuses SET status_before = 'collapsed'",
    // Content, one text per locale: a text from before it, and a locale Raaqeb does not ship.
    "UPDATE incidents SET title = 'بطء'",
    'UPDATE incident_updates SET message = \'{"fr":"x"}\'',
  ])(
    "a stored impact level, stage, status or status before this version does not know, or a title or text that is not content, is a shape error naming the incident (%s)",
    async (statement) => {
      const { components, incidents, location } = await repositories();
      const web = await components.create(component("الموقع"));
      const created = await incidents.create(
        fields,
        first({ statuses: [{ componentId: web.id, status: "major_outage" }] })
      );
      await runSql(location, statement);
      const error = await incidents.find(created.id).catch((caught) => caught);
      expect(error).toBeInstanceOf(IncidentShapeError);
      expect(error).toMatchObject({ incidentId: created.id });
    }
  );
});

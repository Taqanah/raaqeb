import { afterEach, describe, expect, test } from "bun:test";
import type { ComponentFields } from "@/shared/schemas/component.ts";
import type { Recurrence } from "@/shared/schemas/maintenance.ts";
import {
  type ComponentsRepository,
  componentsRepository,
} from "./components.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import {
  type MaintenanceRepository,
  MaintenanceShapeError,
  maintenanceRepository,
  NoWindowComponentError,
  type SeriesFields,
  type WindowFields,
} from "./maintenance.ts";
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
const hour = 3_600_000;

async function repositories(): Promise<{
  components: ComponentsRepository;
  location: DatabaseLocation;
  maintenance: MaintenanceRepository;
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
    location: scratch.location,
    maintenance: maintenanceRepository(run, now),
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

function fields(
  componentIds: readonly string[],
  overrides: Partial<WindowFields> = {}
): WindowFields {
  return {
    componentIds,
    endsAt: t0 + 3 * hour,
    message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث." },
    startsAt: t0 + hour,
    title: { ar: "ترقية قاعدة البيانات" },
    ...overrides,
  };
}

describe("the maintenance windows repository", () => {
  test("a window is stored scheduled with its components, in their creation order, and read back whole", async () => {
    const { components, maintenance, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    tick(1);
    const api = await components.create(component("API"));
    const created = await maintenance.create(fields([api.id, web.id]));
    expect(created).toEqual({
      componentIds: [web.id, api.id],
      createdAt: t0 + 1,
      endsAt: t0 + 3 * hour,
      id: created.id,
      message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث." },
      stage: "scheduled",
      startsAt: t0 + hour,
      title: { ar: "ترقية قاعدة البيانات" },
      updatedAt: t0 + 1,
    });
    expect(await maintenance.find(created.id)).toEqual(created);
    expect(await maintenance.list()).toEqual([created]);
  });

  test("a component that does not exist is skipped", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(
      fields(["no-such-component", web.id])
    );
    expect(created.componentIds).toEqual([web.id]);
  });

  test("a window none of whose components exists is not stored", async () => {
    const { maintenance } = await repositories();
    const error = await maintenance
      .create(fields(["no-such-component"]))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoWindowComponentError);
    expect(await maintenance.list()).toEqual([]);
  });

  test("a deleted component leaves every window it was on", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const created = await maintenance.create(fields([web.id, api.id]));
    await components.remove(api.id);
    expect((await maintenance.find(created.id))?.componentIds).toEqual([
      web.id,
    ]);
  });

  test("an unknown id finds nothing", async () => {
    const { components, maintenance } = await repositories();
    // A stored window, so a lookup that ignored the id would find it.
    const web = await components.create(component("الموقع"));
    await maintenance.create(fields([web.id]));
    expect(await maintenance.find("no-such-window")).toBeUndefined();
  });
});

describe("the scheduler's moves of a window's stage", () => {
  test("a scheduled window goes in progress once its start has passed, and completes once its end has", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(fields([web.id]));
    expect(await maintenance.advance(t0 + hour - 1)).toEqual([]);
    const started = await maintenance.advance(t0 + hour);
    expect(started.map((each) => [each.id, each.stage])).toEqual([
      [created.id, "in_progress"],
    ]);
    expect((await maintenance.find(created.id))?.stage).toBe("in_progress");
    expect(await maintenance.advance(t0 + 3 * hour - 1)).toEqual([]);
    const completed = await maintenance.advance(t0 + 3 * hour);
    expect(completed.map((each) => [each.id, each.stage])).toEqual([
      [created.id, "completed"],
    ]);
    expect(completed[0]?.componentIds).toEqual([web.id]);
  });

  test("each move happens once: a second advance at the same time moves nothing", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    await maintenance.create(fields([web.id]));
    expect(await maintenance.advance(t0 + hour)).toHaveLength(1);
    expect(await maintenance.advance(t0 + hour)).toEqual([]);
    expect(await maintenance.advance(t0 + 3 * hour)).toHaveLength(1);
    expect(await maintenance.advance(t0 + 4 * hour)).toEqual([]);
  });

  test("a window whose start and end both passed goes straight to completed", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(fields([web.id]));
    const moved = await maintenance.advance(t0 + 5 * hour);
    expect(moved.map((each) => [each.id, each.stage])).toEqual([
      [created.id, "completed"],
    ]);
  });

  test("the windows moved come back in creation order", async () => {
    const { components, maintenance, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const first = await maintenance.create(fields([web.id]));
    tick(1);
    const second = await maintenance.create(fields([web.id], { startsAt: t0 }));
    const moved = await maintenance.advance(t0 + hour);
    expect(moved.map((each) => each.id)).toEqual([first.id, second.id]);
  });
});

describe("the reads of a window's reach", () => {
  test("the unfinished windows are the scheduled and the in-progress ones", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const done = await maintenance.create(
      fields([web.id], { endsAt: t0 + hour, startsAt: t0 })
    );
    const running = await maintenance.create(
      fields([web.id], { endsAt: t0 + 4 * hour, startsAt: t0 })
    );
    const later = await maintenance.create(
      fields([web.id], { endsAt: t0 + 9 * hour, startsAt: t0 + 8 * hour })
    );
    await maintenance.advance(t0 + 2 * hour);
    expect((await maintenance.unfinished()).map((each) => each.id)).toEqual([
      running.id,
      later.id,
    ]);
    expect((await maintenance.find(done.id))?.stage).toBe("completed");
  });

  test("the windows since a time are the started ones that end after it", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const old = await maintenance.create(
      fields([web.id], { endsAt: t0 + hour, startsAt: t0 })
    );
    const recent = await maintenance.create(
      fields([web.id], { endsAt: t0 + 3 * hour, startsAt: t0 + 2 * hour })
    );
    const running = await maintenance.create(
      fields([web.id], { endsAt: t0 + 9 * hour, startsAt: t0 + 4 * hour })
    );
    await maintenance.create(
      fields([web.id], { endsAt: t0 + 12 * hour, startsAt: t0 + 10 * hour })
    );
    await maintenance.advance(t0 + 5 * hour);
    expect(
      (await maintenance.since(t0 + 2 * hour)).map((each) => each.id)
    ).toEqual([recent.id, running.id]);
    expect((await maintenance.since(0)).map((each) => each.id)).toEqual([
      old.id,
      recent.id,
      running.id,
    ]);
  });
});

describe("an operator's edit of a window", () => {
  test("an edit replaces what it names while the window is at the stage the caller read", async () => {
    const { components, maintenance, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const created = await maintenance.create(fields([web.id]));
    tick(5);
    const edited = await maintenance.edit(created.id, "scheduled", {
      componentIds: [api.id],
      endsAt: t0 + 6 * hour,
      message: { ar: "نص أوضح" },
      startsAt: t0 + 2 * hour,
      title: { ar: "عنوان أوضح" },
    });
    expect(edited).toEqual({
      ...created,
      componentIds: [api.id],
      endsAt: t0 + 6 * hour,
      message: { ar: "نص أوضح" },
      startsAt: t0 + 2 * hour,
      title: { ar: "عنوان أوضح" },
      updatedAt: t0 + 5,
    });
  });

  test("an edit that names only the text leaves the times and the components", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(fields([web.id]));
    const edited = await maintenance.edit(created.id, "scheduled", {
      message: { ar: "نص أوضح" },
      title: { ar: "عنوان أوضح" },
    });
    expect(edited).toMatchObject({
      componentIds: [web.id],
      endsAt: created.endsAt,
      startsAt: created.startsAt,
      title: { ar: "عنوان أوضح" },
    });
  });

  test("an edit for a stage the window has moved past changes nothing", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(fields([web.id]));
    await maintenance.advance(t0 + hour);
    expect(
      await maintenance.edit(created.id, "scheduled", {
        message: { ar: "نص" },
        startsAt: t0 + 2 * hour,
        title: { ar: "عنوان" },
      })
    ).toBeUndefined();
    expect(await maintenance.find(created.id)).toMatchObject({
      stage: "in_progress",
      startsAt: t0 + hour,
      title: { ar: "ترقية قاعدة البيانات" },
    });
  });

  test("an edit naming only components that do not exist changes nothing", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(fields([web.id]));
    const error = await maintenance
      .edit(created.id, "scheduled", {
        componentIds: ["no-such-component"],
        message: { ar: "نص" },
        title: { ar: "عنوان" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoWindowComponentError);
    expect(await maintenance.find(created.id)).toEqual(created);
  });

  test("an unknown id edits nothing, and no other window", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const stored = await maintenance.create(fields([web.id]));
    expect(
      await maintenance.edit("no-such-window", "scheduled", {
        message: { ar: "نص" },
        title: { ar: "عنوان" },
      })
    ).toBeUndefined();
    expect(await maintenance.find(stored.id)).toEqual(stored);
  });

  test("a scheduled window is deleted with its components' rows; a started one is not", async () => {
    const { components, location, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const scheduled = await maintenance.create(
      fields([web.id], { endsAt: t0 + 9 * hour, startsAt: t0 + 8 * hour })
    );
    const started = await maintenance.create(fields([web.id]));
    await maintenance.advance(t0 + hour);
    expect(await maintenance.remove(scheduled.id)).toBe(true);
    expect(await maintenance.remove(started.id)).toBe(false);
    expect(await maintenance.remove("no-such-window")).toBe(false);
    expect((await maintenance.list()).map((each) => each.id)).toEqual([
      started.id,
    ]);
    const rows = await runSql(
      location,
      "SELECT window_id FROM maintenance_components"
    );
    expect(rows).toEqual([{ window_id: started.id }]);
  });

  test("a stored stage this version does not know is refused by name", async () => {
    const { components, location, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(fields([web.id]));
    await runSql(
      location,
      `UPDATE maintenance_windows SET stage = 'verifying' WHERE id = '${created.id}'`
    );
    const error = await maintenance
      .find(created.id)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MaintenanceShapeError);
    expect(error).toMatchObject({ windowId: created.id });
  });

  test("a stored title or description that is not content, a text from before content held one text per locale among them, is refused by name", async () => {
    const { components, location, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.create(fields([web.id]));
    for (const [column, value] of [
      ["title", "ترقية"],
      ["message", '{"fr":"x"}'],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one broken column at a time
      await runSql(
        location,
        `UPDATE maintenance_windows SET ${column} = ? WHERE id = ?`,
        [value, created.id]
      );
      const error = await maintenance
        .find(created.id)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ windowId: created.id });
      await runSql(
        location,
        `UPDATE maintenance_windows SET ${column} = ? WHERE id = ?`,
        ['{"ar":"نص"}', created.id]
      );
    }
  });
});

const weekly: Recurrence = {
  days: { repeat: "weekly", weekdays: [2] },
  minutes: 120,
  time: "02:00",
  timeZone: "UTC",
};

function seriesFields(
  componentIds: readonly string[],
  overrides: Partial<SeriesFields> = {}
): SeriesFields {
  return {
    componentIds,
    message: { ar: "نحدّث الخوادم كل أسبوع." },
    recurrence: weekly,
    title: { ar: "صيانة أسبوعية" },
    ...overrides,
  };
}

const at = (start: number, length = 2 * hour) => ({
  endsAt: start + length,
  startsAt: start,
});

describe("a maintenance series and its occurrences", () => {
  test("a series is stored with its components and schedules an ordinary window at each time given", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const write = await maintenance.createSeries(
      seriesFields([web.id]),
      [at(t0 + hour), at(t0 + 8 * hour)],
      t0 + 10 * hour
    );
    expect(write.series).toEqual({
      componentIds: [web.id],
      createdAt: t0,
      id: write.series.id,
      message: { ar: "نحدّث الخوادم كل أسبوع." },
      recurrence: weekly,
      scheduledUntil: t0 + 10 * hour,
      title: { ar: "صيانة أسبوعية" },
      updatedAt: t0,
    });
    expect(write.scheduled).toEqual([
      {
        componentIds: [web.id],
        createdAt: t0,
        endsAt: t0 + 3 * hour,
        id: write.scheduled[0]?.id ?? "",
        message: { ar: "نحدّث الخوادم كل أسبوع." },
        seriesId: write.series.id,
        stage: "scheduled",
        startsAt: t0 + hour,
        title: { ar: "صيانة أسبوعية" },
        updatedAt: t0,
      },
      expect.objectContaining({
        seriesId: write.series.id,
        startsAt: t0 + 8 * hour,
      }),
    ]);
    expect(await maintenance.findSeries(write.series.id)).toEqual(write.series);
    expect(await maintenance.listSeries()).toEqual([write.series]);
    expect((await maintenance.list()).map((each) => each.id)).toEqual(
      write.scheduled.map((each) => each.id)
    );
  });

  test("a series none of whose components exists is not stored, nor any occurrence", async () => {
    const { maintenance } = await repositories();
    const error = await maintenance
      .createSeries(seriesFields(["no-such-component"]), [at(t0 + hour)], t0)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoWindowComponentError);
    expect(await maintenance.listSeries()).toEqual([]);
    expect(await maintenance.list()).toEqual([]);
  });

  test("extending schedules the occurrences while the series is scheduled until the time read, and only then", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const { series } = await maintenance.createSeries(
      seriesFields([web.id]),
      [],
      t0
    );
    const added = await maintenance.extendSeries(
      series.id,
      t0,
      [at(t0 + 5 * hour)],
      t0 + 6 * hour
    );
    expect(added?.map((each) => [each.seriesId, each.startsAt])).toEqual([
      [series.id, t0 + 5 * hour],
    ]);
    expect((await maintenance.findSeries(series.id))?.scheduledUntil).toBe(
      t0 + 6 * hour
    );
    // A second pass that read the series before the first moved it schedules nothing more.
    expect(
      await maintenance.extendSeries(
        series.id,
        t0,
        [at(t0 + 5 * hour)],
        t0 + 6 * hour
      )
    ).toBeUndefined();
    expect(
      await maintenance.extendSeries("no-such-series", t0, [], t0)
    ).toBeUndefined();
    expect(await maintenance.list()).toHaveLength(1);
  });

  test("an edit keeps a scheduled occurrence at a start it names with the new end and text, cancels the others and schedules the new starts", async () => {
    const { components, maintenance, tick } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      [at(t0 + 2 * hour), at(t0 + 4 * hour)],
      t0 + 5 * hour
    );
    const [kept, dropped] = created.scheduled;
    if (!(kept && dropped)) {
      throw new Error("the series scheduled fewer than two occurrences");
    }
    tick(hour);
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([api.id], { title: { ar: "صيانة جديدة" } }),
      [at(t0 + 2 * hour, hour), at(t0 + 6 * hour)],
      t0 + hour,
      t0 + 8 * hour
    );
    expect(edited?.series).toMatchObject({
      componentIds: [api.id],
      scheduledUntil: t0 + 8 * hour,
      title: { ar: "صيانة جديدة" },
      updatedAt: t0 + hour,
    });
    expect(edited?.rescheduled).toEqual([
      {
        ...kept,
        componentIds: [api.id],
        endsAt: t0 + 3 * hour,
        title: { ar: "صيانة جديدة" },
        updatedAt: t0 + hour,
      },
    ]);
    expect(edited?.cancelled).toEqual([dropped]);
    expect(edited?.scheduled.map((each) => each.startsAt)).toEqual([
      t0 + 6 * hour,
    ]);
    expect(await maintenance.find(dropped.id)).toBeUndefined();
  });

  test("an edit leaves the occurrences in progress and completed, and a kept one whose end did not move is not rescheduled", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      [at(t0 + hour), at(t0 + 3 * hour), at(t0 + 8 * hour)],
      t0 + 9 * hour
    );
    await maintenance.advance(t0 + 4 * hour);
    const [done, running, later] = created.scheduled;
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id], { title: { ar: "عنوان آخر" } }),
      [at(t0 + 8 * hour)],
      t0 + 4 * hour,
      t0 + 9 * hour
    );
    expect(edited).toMatchObject({
      cancelled: [],
      rescheduled: [],
      scheduled: [],
    });
    expect((await maintenance.find(done?.id ?? ""))?.title).toEqual({
      ar: "صيانة أسبوعية",
    });
    expect((await maintenance.find(running?.id ?? ""))?.stage).toBe(
      "in_progress"
    );
    expect((await maintenance.find(later?.id ?? ""))?.title).toEqual({
      ar: "عنوان آخر",
    });
    expect(
      await maintenance.editSeries(
        "no-such-series",
        seriesFields([web.id]),
        [],
        t0,
        t0
      )
    ).toBeUndefined();
  });

  test("an occurrence moved on its own is kept by the start its series gave it: an edit puts it back at the series' times, rescheduled once", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const plan = [at(t0 + 2 * hour), at(t0 + 4 * hour)];
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      plan,
      t0 + 5 * hour
    );
    const [moved] = created.scheduled;
    await maintenance.edit(moved?.id ?? "", "scheduled", {
      endsAt: t0 + 3 * hour + 30 * 60_000,
      message: { ar: "نقلناه نصف ساعة." },
      startsAt: t0 + 3 * hour,
      title: { ar: "صيانة أسبوعية" },
    });
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id]),
      plan,
      t0,
      t0 + 5 * hour
    );
    expect(edited?.cancelled).toEqual([]);
    expect(edited?.scheduled).toEqual([]);
    expect(
      edited?.rescheduled.map((each) => [each.id, each.startsAt, each.endsAt])
    ).toEqual([[moved?.id ?? "", t0 + 2 * hour, t0 + 4 * hour]]);
  });

  test("an occurrence moved and then cancelled on its own stays cancelled through an edit", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const plan = [at(t0 + 2 * hour), at(t0 + 4 * hour)];
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      plan,
      t0 + 5 * hour
    );
    const [moved] = created.scheduled;
    await maintenance.edit(moved?.id ?? "", "scheduled", {
      endsAt: t0 + 3 * hour + 30 * 60_000,
      message: { ar: "نقلناه نصف ساعة." },
      startsAt: t0 + 3 * hour,
      title: { ar: "صيانة أسبوعية" },
    });
    expect(await maintenance.remove(moved?.id ?? "")).toBe(true);
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id]),
      plan,
      t0,
      t0 + 5 * hour
    );
    expect(edited?.scheduled).toEqual([]);
    expect((await maintenance.list()).map((each) => each.startsAt)).toEqual([
      t0 + 4 * hour,
    ]);
  });

  test("two occurrences moved onto one start are each kept by their own on an edit", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const plan = [at(t0 + 2 * hour), at(t0 + 4 * hour)];
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      plan,
      t0 + 5 * hour
    );
    const [moved, stayed] = created.scheduled;
    await maintenance.edit(moved?.id ?? "", "scheduled", {
      endsAt: t0 + 6 * hour,
      message: { ar: "نص" },
      startsAt: t0 + 4 * hour,
      title: { ar: "صيانة أسبوعية" },
    });
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id]),
      plan,
      t0,
      t0 + 5 * hour
    );
    expect(edited?.cancelled).toEqual([]);
    expect(edited?.scheduled).toEqual([]);
    expect(
      (await maintenance.list()).map((each) => [each.id, each.startsAt])
    ).toEqual([
      [moved?.id ?? "", t0 + 2 * hour],
      [stayed?.id ?? "", t0 + 4 * hour],
    ]);
  });

  test("on an edit, an occurrence whose start has come is left to the tick, never cancelled", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      [at(t0 + 2 * hour)],
      t0 + 3 * hour
    );
    // A second past its start, before the tick moved it in progress; the new plan starts after it.
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id], { title: { ar: "عنوان آخر" } }),
      [],
      t0 + 2 * hour + 1000,
      t0 + 3 * hour
    );
    expect(edited?.cancelled).toEqual([]);
    expect(
      (await maintenance.list()).map((each) => [each.startsAt, each.title])
    ).toEqual([[t0 + 2 * hour, { ar: "صيانة أسبوعية" }]]);
  });

  test("on an edit at the very start of an occurrence, that occurrence is left to the tick too", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      [at(t0 + 2 * hour)],
      t0 + 3 * hour
    );
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id], { title: { ar: "عنوان آخر" } }),
      [],
      t0 + 2 * hour,
      t0 + 3 * hour
    );
    expect(edited?.cancelled).toEqual([]);
    expect((await maintenance.list()).map((each) => each.startsAt)).toEqual([
      t0 + 2 * hour,
    ]);
  });

  test("an occurrence moved on its own is still kept by the start its series gave it when the edit is made at that very start", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const plan = [at(t0 + 2 * hour), at(t0 + 4 * hour)];
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      plan,
      t0 + 5 * hour
    );
    const [moved, stayed] = created.scheduled;
    await maintenance.edit(moved?.id ?? "", "scheduled", {
      endsAt: t0 + 3 * hour + 30 * 60_000,
      message: { ar: "نقلناه نصف ساعة." },
      startsAt: t0 + 3 * hour,
      title: { ar: "صيانة أسبوعية" },
    });
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id]),
      plan,
      t0 + 2 * hour,
      t0 + 5 * hour
    );
    expect(edited?.scheduled).toEqual([]);
    expect(
      (await maintenance.list()).map((each) => [each.id, each.startsAt])
    ).toEqual([
      [moved?.id ?? "", t0 + 2 * hour],
      [stayed?.id ?? "", t0 + 4 * hour],
    ]);
  });

  test("occurrences cancelled at once each stay cancelled through an edit", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const plan = [at(t0 + 2 * hour), at(t0 + 4 * hour), at(t0 + 6 * hour)];
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      plan,
      t0 + 7 * hour
    );
    const [first, second] = created.scheduled;
    await Promise.all([
      maintenance.remove(first?.id ?? ""),
      maintenance.remove(second?.id ?? ""),
    ]);
    const edited = await maintenance.editSeries(
      created.series.id,
      seriesFields([web.id]),
      plan,
      t0,
      t0 + 7 * hour
    );
    expect(edited?.scheduled).toEqual([]);
    expect((await maintenance.list()).map((each) => each.startsAt)).toEqual([
      t0 + 6 * hour,
    ]);
  });

  test("ending a series cancels its scheduled occurrences and leaves the others as windows of no series", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const created = await maintenance.createSeries(
      seriesFields([web.id]),
      [at(t0 + hour), at(t0 + 8 * hour)],
      t0 + 9 * hour
    );
    await maintenance.advance(t0 + hour);
    const [running, later] = created.scheduled;
    expect(await maintenance.endSeries(created.series.id)).toEqual(
      later ? [later] : []
    );
    expect(await maintenance.findSeries(created.series.id)).toBeUndefined();
    const left = await maintenance.list();
    expect(left.map((each) => each.id)).toEqual([running?.id ?? ""]);
    expect(left[0]?.seriesId).toBeUndefined();
    expect(await maintenance.endSeries(created.series.id)).toBeUndefined();
  });

  test("deleting the last of a series' components deletes the series; one with another component keeps it", async () => {
    const { components, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const api = await components.create(component("API"));
    const alone = await maintenance.createSeries(
      seriesFields([web.id]),
      [],
      t0
    );
    const both = await maintenance.createSeries(
      seriesFields([web.id, api.id]),
      [],
      t0
    );
    await components.remove(web.id);
    expect(await maintenance.findSeries(alone.series.id)).toBeUndefined();
    expect(
      (await maintenance.findSeries(both.series.id))?.componentIds
    ).toEqual([api.id]);
  });

  test("a stored recurrence this version cannot read is refused by name", async () => {
    const { components, location, maintenance } = await repositories();
    const web = await components.create(component("الموقع"));
    const { series } = await maintenance.createSeries(
      seriesFields([web.id]),
      [],
      t0
    );
    await runSql(
      location,
      "UPDATE maintenance_series SET recurrence = ? WHERE id = ?",
      ['{"days":{"repeat":"yearly"}}', series.id]
    );
    const error = await maintenance
      .findSeries(series.id)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MaintenanceShapeError);
    expect(error).toMatchObject({ windowId: series.id });
  });
});

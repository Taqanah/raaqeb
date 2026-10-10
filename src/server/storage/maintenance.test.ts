import { afterEach, describe, expect, test } from "bun:test";
import type { ComponentFields } from "@/shared/schemas/component.ts";
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

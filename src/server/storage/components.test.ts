import { afterEach, describe, expect, test } from "bun:test";
import type { ComponentFields } from "@/shared/schemas/component.ts";
import {
  type MonitorInput,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import {
  ComponentShapeError,
  type ComponentsRepository,
  componentsRepository,
} from "./components.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import { type PagesRepository, pagesRepository } from "./pages.ts";
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

const site: MonitorInput = {
  channels: [],
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  events: [...monitorEventKinds],
  intervalMs: 60_000,
  name: "Site",
  retries: 2,
  tags: [],
  timeoutMs: 10_000,
};

async function repositories(): Promise<{
  components: ComponentsRepository;
  location: DatabaseLocation;
  monitors: MonitorsRepository;
  pages: PagesRepository;
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
    monitors: monitorsRepository(run, now),
    pages: pagesRepository(run, now),
    tick: (ms) => {
      time += ms;
    },
  };
}

function fields(overrides: Partial<ComponentFields> = {}): ComponentFields {
  return {
    description: undefined,
    monitorIds: [],
    name: { ar: "الموقع" },
    status: "operational",
    ...overrides,
  };
}

describe("the components repository", () => {
  test("a component is stored with its hand-set status, its description and its links, and read back whole", async () => {
    const { components, monitors } = await repositories();
    const a = await monitors.create({ ...site, name: "A" });
    const created = await components.create(
      fields({
        description: { ar: "المتجر وصفحات المنتجات" },
        monitorIds: [a.id],
        status: "partial_outage",
      })
    );
    expect(created).toEqual({
      createdAt: t0,
      description: { ar: "المتجر وصفحات المنتجات" },
      id: created.id,
      monitorIds: [a.id],
      name: { ar: "الموقع" },
      status: "partial_outage",
      updatedAt: t0,
    });
    expect(await components.find(created.id)).toEqual(created);
  });

  test("the links come back in the monitors' creation order, whatever order they were given in", async () => {
    const { components, monitors, tick } = await repositories();
    const a = await monitors.create({ ...site, name: "A" });
    tick(1);
    const b = await monitors.create({ ...site, name: "B" });
    const created = await components.create(
      fields({ monitorIds: [b.id, a.id] })
    );
    expect(created.monitorIds).toEqual([a.id, b.id]);
  });

  test("a link to a monitor that does not exist is skipped", async () => {
    const { components, monitors } = await repositories();
    const a = await monitors.create(site);
    const created = await components.create(
      fields({ monitorIds: [a.id, "no-such-monitor"] })
    );
    expect(created.monitorIds).toEqual([a.id]);
  });

  test("the list holds every component with its links, in creation order", async () => {
    const { components, monitors, tick } = await repositories();
    const a = await monitors.create(site);
    const first = await components.create(fields({ name: { ar: "First" } }));
    tick(1);
    const second = await components.create(
      fields({ monitorIds: [a.id], name: { ar: "Second" } })
    );
    expect(await components.list()).toEqual([first, second]);
  });

  test("an edit replaces the name, the description, the hand-set status and the links, keeping the id and the creation time", async () => {
    const { components, monitors, tick } = await repositories();
    const a = await monitors.create({ ...site, name: "A" });
    const b = await monitors.create({ ...site, name: "B" });
    const created = await components.create(
      fields({ description: { ar: "old" }, monitorIds: [a.id] })
    );
    tick(5000);
    const edited = await components.update(created.id, {
      description: undefined,
      monitorIds: [b.id],
      name: { ar: "API" },
      status: "major_outage",
    });
    expect(edited).toEqual({
      createdAt: t0,
      description: undefined,
      id: created.id,
      monitorIds: [b.id],
      name: { ar: "API" },
      status: "major_outage",
      updatedAt: t0 + 5000,
    });
  });

  test("an edit of an unknown component changes nothing and answers nothing, links included", async () => {
    const { components, location, monitors } = await repositories();
    const monitor = await monitors.create(site);
    expect(
      await components.update("nope", fields({ monitorIds: [monitor.id] }))
    ).toBeUndefined();
    expect(await components.list()).toEqual([]);
    const [row] = await runSql(
      location,
      "SELECT COUNT(*) AS n FROM component_monitors"
    );
    expect(Number(row?.n)).toBe(0);
  });

  test("an unknown id reads as nothing", async () => {
    const { components } = await repositories();
    // A stored component, so a lookup that ignored the id would find it.
    await components.create(fields());
    expect(await components.find("nope")).toBeUndefined();
  });

  test("deleting a monitor drops its links and leaves the component", async () => {
    const { components, monitors } = await repositories();
    const a = await monitors.create({ ...site, name: "A" });
    const b = await monitors.create({ ...site, name: "B" });
    const created = await components.create(
      fields({ monitorIds: [a.id, b.id] })
    );
    await monitors.remove([a.id]);
    expect((await components.find(created.id))?.monitorIds).toEqual([b.id]);
  });

  test("deleting a component drops its links and takes it off every page, and says whether it existed", async () => {
    const { components, monitors, pages } = await repositories();
    const a = await monitors.create(site);
    const created = await components.create(fields({ monitorIds: [a.id] }));
    const page = await pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "status",
      title: { ar: "حالة" },
    });
    await pages.save(page.id, page, [
      { componentId: created.id, kind: "component" },
    ]);
    expect(await components.remove(created.id)).toBe(true);
    expect(await components.remove(created.id)).toBe(false);
    expect(await pages.layout(page.id)).toEqual([]);
    expect(await monitors.find(a.id)).toBeDefined();
  });

  test("a stored hand-set status this version does not know is a shape error naming the component", async () => {
    const { components, location } = await repositories();
    const created = await components.create(fields());
    await runSql(location, "UPDATE components SET status = ? WHERE id = ?", [
      "on_fire",
      created.id,
    ]);
    const read = await components.find(created.id).catch((error) => error);
    expect(read).toBeInstanceOf(ComponentShapeError);
    expect(read.componentId).toBe(created.id);
    expect(await components.list().catch((error) => error)).toBeInstanceOf(
      ComponentShapeError
    );
  });

  test("a stored name or description that is not content is a shape error naming the component", async () => {
    const { components, location } = await repositories();
    const created = await components.create(
      fields({ description: { ar: "المتجر", en: "The shop" } })
    );
    expect((await components.find(created.id))?.description).toEqual({
      ar: "المتجر",
      en: "The shop",
    });
    for (const [column, value] of [
      ["name", "الموقع"],
      ["description", "[]"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one broken column at a time
      await runSql(
        location,
        `UPDATE components SET ${column} = ? WHERE id = ?`,
        [value, created.id]
      );
      const read = await components.find(created.id).catch((error) => error);
      expect(read).toBeInstanceOf(ComponentShapeError);
      await runSql(
        location,
        `UPDATE components SET ${column} = ? WHERE id = ?`,
        ['{"ar":"نص"}', created.id]
      );
    }
  });
});

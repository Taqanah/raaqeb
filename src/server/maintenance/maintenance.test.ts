import { afterEach, describe, expect, test } from "bun:test";
import type { Announce, SubscriberEvent } from "@/server/notify/subscribers.ts";
import {
  deleteComponent,
  readComponentForm,
} from "@/server/pages/components.ts";
import {
  d0,
  hour,
  minute,
  type PagesScratch,
  scratchPages,
  site,
} from "@/server/pages/fixture.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type {
  MaintenanceInput,
  MaintenanceSaveResult,
} from "@/shared/schemas/maintenance.ts";
import {
  createWindow,
  deleteWindow,
  editWindow,
  endWindow,
  listWindows,
  readNewWindow,
  readWindow,
} from "./maintenance.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** Noon, half a minute in: the operator's now in these tests. */
const noon = d0 + 12 * hour + 30_000;

async function opened(): Promise<PagesScratch> {
  scratch = await scratchPages();
  scratch.at(noon);
  return scratch;
}

async function component(
  storage: Storage,
  name: string,
  monitorIds: readonly string[] = []
): Promise<string> {
  const created = await storage.components.create({
    description: undefined,
    monitorIds,
    name: { ar: name },
    status: "operational",
  });
  return created.id;
}

/** A window from 14:00 to 16:00 of the first day on the components. */
function planned(
  componentIds: readonly string[],
  overrides: Partial<MaintenanceInput> = {}
): MaintenanceInput {
  return {
    componentIds: [...componentIds],
    endsAt: d0 + 16 * hour,
    message: { ar: "ننقل قاعدة البيانات إلى خادم أحدث." },
    startsAt: d0 + 14 * hour,
    title: { ar: "ترقية قاعدة البيانات" },
    ...overrides,
  };
}

/** The window a result carries; fails the test on a refusal. */
function saved(result: MaintenanceSaveResult) {
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.window;
}

const invalid = { ok: false, reason: "invalid" } as const;
const changed = { ok: false, reason: "changed" } as const;
const notFound = { ok: false, reason: "not_found" } as const;

describe("scheduling a maintenance window", () => {
  test("it is stored scheduled with its components, and moves the change counter", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const before = await storage.changeCounter();
    const window = saved(await createWindow(storage, planned([web]), noon));
    expect(window).toMatchObject({
      componentIds: [web],
      endsAt: d0 + 16 * hour,
      stage: "scheduled",
      startsAt: d0 + 14 * hour,
      title: { ar: "ترقية قاعدة البيانات" },
    });
    expect(await storage.maintenance.find(window.id)).toEqual(window);
    expect(await storage.changeCounter()).toBe(before + 1);
  });

  test("a start in the current minute starts it now, for the scheduler's next tick", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], { startsAt: d0 + 12 * hour }),
        noon
      )
    );
    expect(window.startsAt).toBe(noon);
    expect(window.stage).toBe("scheduled");
  });

  test("a start in the past, an end not after the start, or no component that exists is refused, and nothing is stored or counted", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const before = await storage.changeCounter();
    expect(
      await createWindow(
        storage,
        planned([web], { startsAt: d0 + 11 * hour }),
        noon
      )
    ).toEqual(invalid);
    expect(
      await createWindow(
        storage,
        planned([web], { endsAt: d0 + 14 * hour }),
        noon
      )
    ).toEqual(invalid);
    expect(
      await createWindow(storage, planned(["no-such-component"]), noon)
    ).toEqual(invalid);
    expect(await storage.maintenance.list()).toEqual([]);
    expect(await storage.changeCounter()).toBe(before);
  });
});

describe("the maintenance list before any component exists", () => {
  test("it says no component exists, so none can be scheduled, until one does", async () => {
    const { storage } = await opened();
    const before = await listWindows(storage, noon);
    expect(before).toMatchObject({ list: { anyComponent: false }, ok: true });
    await component(storage, "الموقع");
    const after = await listWindows(storage, noon);
    expect(after).toMatchObject({ list: { anyComponent: true }, ok: true });
  });
});

describe("the maintenance list and pages", () => {
  test("in progress first, then scheduled soonest first, then completed newest first, each naming its components", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const done = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    const doneLater = saved(
      await createWindow(
        storage,
        planned([api], { endsAt: noon + 2 * hour, startsAt: noon }),
        noon
      )
    );
    const running = saved(
      await createWindow(
        storage,
        planned([web, api], { endsAt: noon + 9 * hour, startsAt: noon }),
        noon
      )
    );
    const far = saved(
      await createWindow(
        storage,
        planned([api], {
          endsAt: noon + 30 * hour,
          startsAt: noon + 29 * hour,
        }),
        noon
      )
    );
    const soon = saved(
      await createWindow(
        storage,
        planned([web], {
          endsAt: noon + 6 * hour,
          startsAt: noon + 5 * hour,
        }),
        noon
      )
    );
    await storage.maintenance.advance(noon + 3 * hour);
    const listed = await listWindows(storage, noon + 3 * hour);
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    expect(listed.list.now).toBe(noon + 3 * hour);
    expect(listed.list.windows.map((each) => [each.id, each.stage])).toEqual([
      [running.id, "in_progress"],
      [soon.id, "scheduled"],
      [far.id, "scheduled"],
      [doneLater.id, "completed"],
      [done.id, "completed"],
    ]);
    expect(listed.list.windows[0]?.components).toEqual([
      { id: web, name: { ar: "الموقع" } },
      { id: api, name: { ar: "API" } },
    ]);
  });

  test("the new-window page offers every component with its status now, under maintenance while a window runs on it", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    await createWindow(
      storage,
      planned([web], { endsAt: noon + hour, startsAt: noon }),
      noon
    );
    await storage.maintenance.advance(noon);
    const read = await readNewWindow(storage, noon);
    expect(read).toEqual({
      form: {
        components: [
          { id: web, name: { ar: "الموقع" }, status: "under_maintenance" },
          { id: api, name: { ar: "API" }, status: "operational" },
        ],
        now: noon,
      },
      ok: true,
    });
  });

  test("a window's page reads the window with every component; an unknown id is not found", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(await createWindow(storage, planned([web]), noon));
    expect(await readWindow(storage, window.id, noon)).toEqual({
      ok: true,
      page: {
        components: [
          { id: web, name: { ar: "الموقع" }, status: "operational" },
        ],
        now: noon,
        window,
      },
    });
    expect(await readWindow(storage, "no-such-window", noon)).toEqual(notFound);
  });

  test("a stored window this version cannot read is named by the list and its page", async () => {
    const { location, storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(await createWindow(storage, planned([web]), noon));
    await runSql(
      location,
      `UPDATE maintenance_windows SET stage = 'verifying' WHERE id = '${window.id}'`
    );
    const corrupt = { id: window.id, ok: false, reason: "corrupt" } as const;
    expect(await listWindows(storage, noon)).toEqual(corrupt);
    expect(await readWindow(storage, window.id, noon)).toEqual(corrupt);
  });
});

describe("deleting a component a window affects", () => {
  test("a scheduled, an in-progress and a completed window left with no component go with it, off the list and their pages as off every status page", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const done = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    const running = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + 9 * hour, startsAt: noon }),
        noon
      )
    );
    const later = saved(
      await createWindow(
        storage,
        planned([web], {
          endsAt: noon + 30 * hour,
          startsAt: noon + 29 * hour,
        }),
        noon
      )
    );
    await storage.maintenance.advance(noon + 3 * hour);
    expect(await deleteComponent(storage, web)).toEqual({ ok: true });
    expect(await listWindows(storage, noon + 3 * hour)).toEqual({
      list: { anyComponent: false, now: noon + 3 * hour, windows: [] },
      ok: true,
    });
    for (const window of [done, running, later]) {
      // biome-ignore lint/performance/noAwaitInLoops: one at a time is plenty for a test
      expect(await readWindow(storage, window.id, noon + 3 * hour)).toEqual(
        notFound
      );
    }
  });

  test("a window that still affects another component stays, naming only that one, and one that never named it stays whole", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const both = saved(await createWindow(storage, planned([web, api]), noon));
    const other = saved(
      await createWindow(
        storage,
        planned([api], {
          endsAt: noon + 30 * hour,
          startsAt: noon + 29 * hour,
        }),
        noon
      )
    );
    await deleteComponent(storage, web);
    const listed = await listWindows(storage, noon);
    expect(
      listed.ok && listed.list.windows.map((each) => [each.id, each.components])
    ).toEqual([
      [both.id, [{ id: api, name: { ar: "API" } }]],
      [other.id, [{ id: api, name: { ar: "API" } }]],
    ]);
  });
});

describe("editing a window by its stage", () => {
  test("a scheduled window takes every field, judged against now, and moves the counter", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const window = saved(await createWindow(storage, planned([web]), noon));
    const before = await storage.changeCounter();
    const edited = saved(
      await editWindow(
        storage,
        window.id,
        planned([api], {
          endsAt: d0 + 20 * hour,
          startsAt: d0 + 18 * hour,
          title: { ar: "عنوان أوضح" },
        }),
        noon
      )
    );
    expect(edited).toMatchObject({
      componentIds: [api],
      endsAt: d0 + 20 * hour,
      startsAt: d0 + 18 * hour,
      title: { ar: "عنوان أوضح" },
    });
    expect(await storage.changeCounter()).toBe(before + 1);
    expect(
      await editWindow(
        storage,
        window.id,
        planned([api], { startsAt: d0 + 11 * hour }),
        noon
      )
    ).toEqual(invalid);
  });

  test("a window in progress takes its text and its end; an end in the current minute ends it now", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    const later = saved(
      await editWindow(
        storage,
        window.id,
        {
          endsAt: noon + 3 * hour,
          message: { ar: "نمدد الصيانة" },
          title: { ar: "ممددة" },
        },
        noon
      )
    );
    expect(later).toMatchObject({
      endsAt: noon + 3 * hour,
      message: { ar: "نمدد الصيانة" },
      stage: "in_progress",
      startsAt: noon,
      title: { ar: "ممددة" },
    });
    const now = saved(
      await editWindow(
        storage,
        window.id,
        {
          endsAt: d0 + 12 * hour,
          message: { ar: "انتهينا" },
          title: { ar: "ممددة" },
        },
        noon
      )
    );
    expect(now.endsAt).toBe(noon);
  });

  test("a window in progress refuses an end in the past, and an edit of its start or components as changed", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    expect(
      await editWindow(
        storage,
        window.id,
        {
          endsAt: d0 + 11 * hour,
          message: { ar: "نص" },
          title: { ar: "عنوان" },
        },
        noon
      )
    ).toEqual(invalid);
    expect(
      await editWindow(
        storage,
        window.id,
        planned([web], { endsAt: noon + 2 * hour, startsAt: noon + hour }),
        noon
      )
    ).toEqual(changed);
    expect((await storage.maintenance.find(window.id))?.endsAt).toBe(
      noon + hour
    );
  });

  test("a completed window takes its text alone, and refuses an end as changed", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon + hour);
    const later = noon + 2 * hour;
    expect(
      saved(
        await editWindow(
          storage,
          window.id,
          { message: { ar: "تمت الترقية" }, title: { ar: "ترقية منتهية" } },
          later
        )
      )
    ).toMatchObject({
      endsAt: noon + hour,
      message: { ar: "تمت الترقية" },
      stage: "completed",
      title: { ar: "ترقية منتهية" },
    });
    expect(
      await editWindow(
        storage,
        window.id,
        { endsAt: later + hour, message: { ar: "نص" }, title: { ar: "عنوان" } },
        later
      )
    ).toEqual(changed);
  });

  test("an edit of an unknown window is not found and moves no counter", async () => {
    const { storage } = await opened();
    const before = await storage.changeCounter();
    expect(
      await editWindow(
        storage,
        "no-such-window",
        { message: { ar: "نص" }, title: { ar: "عنوان" } },
        noon
      )
    ).toEqual(notFound);
    expect(await storage.changeCounter()).toBe(before);
  });
});

describe("ending a window now and cancelling one", () => {
  test("ending a window in progress sets its end to now and leaves its stage to the scheduler", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    const before = await storage.changeCounter();
    const ended = saved(await endWindow(storage, window.id, noon + minute));
    expect(ended).toMatchObject({
      endsAt: noon + minute,
      stage: "in_progress",
    });
    expect(await storage.changeCounter()).toBe(before + 1);
  });

  test("only a window in progress ends now: a scheduled or completed one is changed, an unknown one not found", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const scheduled = saved(await createWindow(storage, planned([web]), noon));
    const done = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon + hour);
    expect(await endWindow(storage, scheduled.id, noon + hour)).toEqual(
      changed
    );
    expect(await endWindow(storage, done.id, noon + hour)).toEqual(changed);
    expect(await endWindow(storage, "no-such-window", noon)).toEqual(notFound);
  });

  test("a scheduled window is cancelled, which deletes it and moves the counter", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(await createWindow(storage, planned([web]), noon));
    const before = await storage.changeCounter();
    expect(await deleteWindow(storage, window.id, noon)).toEqual({ ok: true });
    expect(await storage.maintenance.find(window.id)).toBeUndefined();
    expect(await storage.changeCounter()).toBe(before + 1);
  });

  test("a window that started cannot be cancelled, and an unknown one is not found", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    const before = await storage.changeCounter();
    expect(await deleteWindow(storage, window.id, noon)).toEqual(changed);
    expect(await deleteWindow(storage, "no-such-window", noon)).toEqual(
      notFound
    );
    expect(await storage.maintenance.find(window.id)).toBeDefined();
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
      maintenance: {
        advance: failing,
        create: failing,
        edit: failing,
        find: failing,
        list: failing,
        remove: failing,
        since: failing,
        unfinished: failing,
      },
    };
    const unavailable = { ok: false, reason: "unavailable" } as const;
    expect(await listWindows(broken, noon)).toEqual(unavailable);
    expect(await readNewWindow(broken, noon)).toEqual(unavailable);
    expect(await readWindow(broken, "w", noon)).toEqual(unavailable);
    expect(await createWindow(broken, planned([web]), noon)).toEqual(
      unavailable
    );
    expect(
      await editWindow(
        broken,
        "w",
        { message: { ar: "x" }, title: { ar: "x" } },
        noon
      )
    ).toEqual(unavailable);
    expect(await endWindow(broken, "w", noon)).toEqual(unavailable);
    expect(await deleteWindow(broken, "w", noon)).toEqual(unavailable);
  });
});

describe("a window's reach on the component screens", () => {
  test("the component page names the windows in progress that put it under maintenance", async () => {
    const { storage } = await opened();
    const monitor = await storage.monitors.create(site);
    const web = await component(storage, "الموقع", [monitor.id]);
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await createWindow(storage, planned([web]), noon);
    await storage.maintenance.advance(noon);
    const form = await readComponentForm(storage, web);
    if (!form.ok) {
      throw new Error(form.reason);
    }
    expect(form.form.maintenance).toEqual([
      { id: window.id, title: { ar: "ترقية قاعدة البيانات" } },
    ]);
    expect(form.form.status).toBe("under_maintenance");
  });
});

describe("edges of the maintenance module", () => {
  test("two windows in progress list the one ending soonest first", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const later = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + 5 * hour, startsAt: noon }),
        noon
      )
    );
    const sooner = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + 2 * hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    const listed = await listWindows(storage, noon);
    expect(listed.ok && listed.list.windows.map((each) => each.id)).toEqual([
      sooner.id,
      later.id,
    ]);
  });

  test("a scheduled window takes its text alone and keeps its times and components; a text and end with no start is invalid", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(await createWindow(storage, planned([web]), noon));
    expect(
      saved(
        await editWindow(
          storage,
          window.id,
          { message: { ar: "نص أوضح" }, title: { ar: "عنوان أوضح" } },
          noon
        )
      )
    ).toMatchObject({
      componentIds: [web],
      endsAt: window.endsAt,
      startsAt: window.startsAt,
      title: { ar: "عنوان أوضح" },
    });
    expect(
      await editWindow(
        storage,
        window.id,
        {
          endsAt: d0 + 20 * hour,
          message: { ar: "نص" },
          title: { ar: "عنوان" },
        },
        noon
      )
    ).toEqual(invalid);
  });

  test("ending a window whose end has already passed keeps its end", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    const ended = saved(await endWindow(storage, window.id, noon + 2 * hour));
    expect(ended.endsAt).toBe(noon + hour);
  });

  test("a scheduled window moved to components of which none exists is invalid, and keeps its own", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(await createWindow(storage, planned([web]), noon));
    expect(
      await editWindow(storage, window.id, planned(["no-such-component"]), noon)
    ).toEqual(invalid);
    expect((await storage.maintenance.find(window.id))?.componentIds).toEqual([
      web,
    ]);
  });
});

describe("an edit the scheduler or a cancel overtook between its read and its write", () => {
  test("a window that started meanwhile is changed; one cancelled meanwhile is not found", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const started = saved(await createWindow(storage, planned([web]), noon));
    const racing = (overtake: () => Promise<unknown>): Storage => ({
      ...storage,
      maintenance: {
        ...storage.maintenance,
        edit: async (id, stage, fields) => {
          await overtake();
          return storage.maintenance.edit(id, stage, fields);
        },
      },
    });
    expect(
      await editWindow(
        racing(() => storage.maintenance.advance(d0 + 14 * hour)),
        started.id,
        { message: { ar: "نص" }, title: { ar: "عنوان" } },
        noon
      )
    ).toEqual(changed);
    const cancelled = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: d0 + 20 * hour, startsAt: d0 + 18 * hour }),
        noon
      )
    );
    expect(
      await editWindow(
        racing(() => storage.maintenance.remove(cancelled.id)),
        cancelled.id,
        { message: { ar: "نص" }, title: { ar: "عنوان" } },
        noon
      )
    ).toEqual(notFound);
  });
});

describe("a window's subscriber events", () => {
  test("scheduling one announces maintenance scheduled after the write; a refused one and an edit that keeps its times announce nothing", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const api = await component(storage, "API");
    const events: SubscriberEvent[] = [];
    const announce: Announce = (event) => {
      events.push(event);
      return Promise.resolve();
    };
    const window = saved(
      await createWindow(storage, planned([web]), noon, announce)
    );
    expect(events).toEqual([
      { type: "maintenance.scheduled", windowId: window.id },
    ]);
    await createWindow(
      storage,
      planned([web], { startsAt: noon - hour }),
      noon,
      announce
    );
    await editWindow(
      storage,
      window.id,
      { ...planned([web, api]), title: { ar: "عنوان آخر" } },
      noon,
      announce
    );
    await editWindow(
      storage,
      window.id,
      { message: { ar: "نص آخر" }, title: { ar: "عنوان ثالث" } },
      noon,
      announce
    );
    expect(events).toHaveLength(1);
  });

  test("an edit that moves a scheduled window's start or end announces it rescheduled after the write", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const events: SubscriberEvent[] = [];
    const announce: Announce = (event) => {
      events.push(event);
      return Promise.resolve();
    };
    const window = saved(await createWindow(storage, planned([web]), noon));
    saved(
      await editWindow(
        storage,
        window.id,
        planned([web], { endsAt: d0 + 17 * hour }),
        noon,
        announce
      )
    );
    expect(events).toEqual([
      { type: "maintenance.rescheduled", windowId: window.id },
    ]);
    expect((await storage.maintenance.find(window.id))?.endsAt).toBe(
      d0 + 17 * hour
    );
    saved(
      await editWindow(
        storage,
        window.id,
        planned([web], { endsAt: d0 + 17 * hour, startsAt: d0 + 13 * hour }),
        noon,
        announce
      )
    );
    expect(events).toHaveLength(2);
    expect(
      await editWindow(
        storage,
        window.id,
        planned([web], { startsAt: noon - hour }),
        noon,
        announce
      )
    ).toEqual(invalid);
    expect(events).toHaveLength(2);
  });

  test("a window in progress whose end moves later is announced rescheduled; an end moved to the current minute is not, since the maintenance pass announces it completed", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const events: SubscriberEvent[] = [];
    const announce: Announce = (event) => {
      events.push(event);
      return Promise.resolve();
    };
    const window = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    saved(
      await editWindow(
        storage,
        window.id,
        {
          endsAt: noon + 2 * hour,
          message: { ar: "نمدد" },
          title: { ar: "ممددة" },
        },
        noon + minute,
        announce
      )
    );
    expect(events).toEqual([
      { type: "maintenance.rescheduled", windowId: window.id },
    ]);
    saved(
      await editWindow(
        storage,
        window.id,
        {
          endsAt: d0 + 12 * hour + minute,
          message: { ar: "انتهينا" },
          title: { ar: "ممددة" },
        },
        noon + minute,
        announce
      )
    );
    expect(events).toHaveLength(1);
  });

  test("a scheduled window moved to start in the current minute is not announced rescheduled, since the maintenance pass announces it started", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const events: SubscriberEvent[] = [];
    const announce: Announce = (event) => {
      events.push(event);
      return Promise.resolve();
    };
    const window = saved(await createWindow(storage, planned([web]), noon));
    const moved = saved(
      await editWindow(
        storage,
        window.id,
        planned([web], { startsAt: d0 + 12 * hour }),
        noon,
        announce
      )
    );
    expect(moved.startsAt).toBe(noon);
    expect(events).toEqual([]);
  });

  test("cancelling a scheduled window announces it cancelled with the window as it was before the delete and the cancel's time; a started or unknown one announces nothing", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const events: SubscriberEvent[] = [];
    const announce: Announce = (event) => {
      events.push(event);
      return Promise.resolve();
    };
    const window = saved(await createWindow(storage, planned([web]), noon));
    expect(
      await deleteWindow(storage, window.id, noon + minute, announce)
    ).toEqual({ ok: true });
    expect(await storage.maintenance.find(window.id)).toBeUndefined();
    expect(events).toEqual([
      { at: noon + minute, type: "maintenance.cancelled", window },
    ]);
    const started = saved(
      await createWindow(
        storage,
        planned([web], { endsAt: noon + hour, startsAt: noon }),
        noon
      )
    );
    await storage.maintenance.advance(noon);
    expect(await deleteWindow(storage, started.id, noon, announce)).toEqual(
      changed
    );
    expect(
      await deleteWindow(storage, "no-such-window", noon, announce)
    ).toEqual(notFound);
    expect(events).toHaveLength(1);
  });

  test("a window starting in the current minute is not announced as scheduled, since the maintenance pass announces it started; one starting the next minute is", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const events: SubscriberEvent[] = [];
    const announce: Announce = (event) => {
      events.push(event);
      return Promise.resolve();
    };
    const now = saved(
      await createWindow(
        storage,
        planned([web], { startsAt: d0 + 12 * hour }),
        noon,
        announce
      )
    );
    expect(now.stage).toBe("scheduled");
    expect(events).toEqual([]);
    const next = saved(
      await createWindow(
        storage,
        planned([web], { startsAt: d0 + 12 * hour + minute }),
        noon,
        announce
      )
    );
    expect(events).toEqual([
      { type: "maintenance.scheduled", windowId: next.id },
    ]);
  });
});

describe("a window's content in each locale", () => {
  test("its title and description are kept in each locale they are written in", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(
      await createWindow(
        storage,
        planned([web], {
          message: { ar: "ننقل القاعدة.", en: "We move the database." },
          title: { ar: "ترقية", en: "Upgrade" },
        }),
        noon
      )
    );
    expect(await storage.maintenance.find(window.id)).toMatchObject({
      message: { ar: "ننقل القاعدة.", en: "We move the database." },
      title: { ar: "ترقية", en: "Upgrade" },
    });
  });

  test("a title or a description without the install language's text is refused on scheduling and on edit, and nothing is written", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const window = saved(await createWindow(storage, planned([web]), noon));
    const before = await storage.changeCounter();
    expect(
      await createWindow(
        storage,
        planned([web], { title: { en: "Upgrade" } }),
        noon
      )
    ).toEqual(invalid);
    expect(
      await editWindow(
        storage,
        window.id,
        planned([web], { message: { en: "We move the database." } }),
        noon
      )
    ).toEqual(invalid);
    expect(await storage.changeCounter()).toBe(before);
    expect(await storage.maintenance.find(window.id)).toEqual(window);
  });
});

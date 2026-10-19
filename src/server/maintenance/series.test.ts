import { afterEach, describe, expect, test } from "bun:test";
import type { Announce, SubscriberEvent } from "@/server/notify/subscribers.ts";
import {
  d0,
  hour,
  type PagesScratch,
  scratchPages,
} from "@/server/pages/fixture.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type {
  MaintenanceSeriesSaveResult,
  Recurrence,
  SeriesInput,
} from "@/shared/schemas/maintenance.ts";
import {
  deleteWindow,
  editWindow,
  listWindows,
  readWindow,
} from "./maintenance.ts";
import { createSeries, editSeries, endSeries, readSeries } from "./series.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const day = 24 * hour;
/** Noon, half a minute in, on Tuesday 1 September 2026: the operator's now in these tests. */
const noon = d0 + 12 * hour + 30_000;
/** The occurrences a Tuesday and Thursday series at 14:00 UTC schedules from noon: this Tuesday's and this Thursday's. */
const tuesday = d0 + 14 * hour;
const thursday = d0 + 2 * day + 14 * hour;

async function opened(): Promise<PagesScratch> {
  scratch = await scratchPages();
  scratch.at(noon);
  return scratch;
}

async function component(storage: Storage, name: string): Promise<string> {
  const created = await storage.components.create({
    description: undefined,
    monitorIds: [],
    name: { ar: name },
    status: "operational",
  });
  return created.id;
}

const twiceWeekly: Recurrence = {
  days: { repeat: "weekly", weekdays: [2, 4] },
  minutes: 120,
  time: "14:00",
  timeZone: "UTC",
};

function planned(
  componentIds: readonly string[],
  overrides: Partial<SeriesInput> = {}
): SeriesInput {
  return {
    componentIds: [...componentIds],
    message: { ar: "نحدّث الخوادم مرتين في الأسبوع." },
    recurrence: twiceWeekly,
    title: { ar: "صيانة الخوادم" },
    ...overrides,
  };
}

function saved(result: MaintenanceSeriesSaveResult) {
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.series;
}

function recorder(): { announce: Announce; events: SubscriberEvent[] } {
  const events: SubscriberEvent[] = [];
  return {
    announce: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    events,
  };
}

/** The series' windows as the list reads them: start and stage. */
async function occurrencesOf(storage: Storage, seriesId: string) {
  return (await storage.maintenance.list())
    .filter((each) => each.seriesId === seriesId)
    .map((each) => ({ stage: each.stage, startsAt: each.startsAt }));
}

describe("creating a maintenance series", () => {
  test("it schedules the occurrences of the coming week as ordinary windows, announces each as scheduled and moves the change counter", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const before = await storage.changeCounter();
    const { announce, events } = recorder();
    const series = saved(
      await createSeries(storage, planned([web]), noon, announce)
    );
    expect(series).toMatchObject({
      componentIds: [web],
      recurrence: twiceWeekly,
      title: { ar: "صيانة الخوادم" },
    });
    const windows = (await storage.maintenance.list()).filter(
      (each) => each.seriesId === series.id
    );
    expect(windows).toMatchObject([
      {
        componentIds: [web],
        endsAt: tuesday + 2 * hour,
        message: { ar: "نحدّث الخوادم مرتين في الأسبوع." },
        stage: "scheduled",
        startsAt: tuesday,
        title: { ar: "صيانة الخوادم" },
      },
      { endsAt: thursday + 2 * hour, startsAt: thursday },
    ]);
    expect(events).toEqual(
      windows.map((each) => ({
        type: "maintenance.scheduled" as const,
        windowId: each.id,
      }))
    );
    expect(await storage.changeCounter()).toBeGreaterThan(before);
  });

  test("a series with no component that exists, or without the install language's text, is refused as invalid and nothing is written", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const invalid = { ok: false, reason: "invalid" } as const;
    expect(
      await createSeries(storage, planned(["no-such-component"]), noon)
    ).toEqual(invalid);
    expect(
      await createSeries(
        storage,
        planned([web], { title: { en: "Server upkeep" } }),
        noon
      )
    ).toEqual(invalid);
    expect(await storage.maintenance.listSeries()).toEqual([]);
    expect(await storage.maintenance.list()).toEqual([]);
  });
});

describe("a series on the list and its page", () => {
  test("the list shows each series with its next occurrence, and each occurrence as a window of it", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    const result = await listWindows(storage, noon);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.list.series).toEqual([
      {
        components: [{ id: web, name: { ar: "الموقع" } }],
        id: series.id,
        next: tuesday,
        recurrence: twiceWeekly,
        title: { ar: "صيانة الخوادم" },
      },
    ]);
    expect(
      result.list.windows.map((each) => [each.seriesId, each.startsAt])
    ).toEqual([
      [series.id, tuesday],
      [series.id, thursday],
    ]);
  });

  test("an occurrence in progress is not the series' next one; the scheduled one after it is", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    saved(await createSeries(storage, planned([web]), noon));
    await storage.maintenance.advance(tuesday);
    const result = await listWindows(storage, tuesday);
    expect(result.ok && result.list.series[0]?.next).toBe(thursday);
  });

  test("a series' page holds its unfinished occurrences soonest first and when the first it has yet to schedule starts", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    await storage.maintenance.advance(tuesday);
    const result = await readSeries(storage, series.id, tuesday);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.page.series).toEqual(series);
    expect(
      result.page.occurrences.map((each) => [each.stage, each.startsAt])
    ).toEqual([
      ["in_progress", tuesday],
      ["scheduled", thursday],
    ]);
    expect(result.page.next).toBe(tuesday + 7 * day);
    expect(result.page.components.map((each) => each.id)).toEqual([web]);
    expect(await readSeries(storage, "no-such-series", noon)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("one occurrence on its own", () => {
  test("its page names the series it is an occurrence of, and once the series ended names none", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    await storage.maintenance.advance(tuesday);
    const [running] = await storage.maintenance.list();
    const page = await readWindow(storage, running?.id ?? "", tuesday);
    expect(page.ok && page.page.series).toEqual({
      id: series.id,
      title: { ar: "صيانة الخوادم" },
    });
    await endSeries(storage, series.id, tuesday);
    const after = await readWindow(storage, running?.id ?? "", tuesday);
    expect(after.ok && after.page.series).toBeUndefined();
  });

  test("cancelling one skips it and leaves the series and its other occurrences; the list's next is the one after", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    const [first] = await storage.maintenance.list();
    expect(await deleteWindow(storage, first?.id ?? "", noon)).toEqual({
      ok: true,
    });
    expect(await storage.maintenance.findSeries(series.id)).toEqual(series);
    expect(await occurrencesOf(storage, series.id)).toEqual([
      { stage: "scheduled", startsAt: thursday },
    ]);
    const result = await listWindows(storage, noon);
    expect(result.ok && result.list.series[0]?.next).toBe(thursday);
  });

  test("changing one leaves the series and its other occurrences as they are", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    const [first, second] = await storage.maintenance.list();
    const edited = await editWindow(
      storage,
      first?.id ?? "",
      {
        componentIds: [web],
        endsAt: tuesday + 3 * hour,
        message: { ar: "تطول هذه المرة ساعة." },
        startsAt: tuesday,
        title: { ar: "صيانة أطول" },
      },
      noon
    );
    expect(edited.ok && edited.window.seriesId).toBe(series.id);
    expect(await storage.maintenance.findSeries(series.id)).toEqual(series);
    expect(await storage.maintenance.find(second?.id ?? "")).toEqual(second);
  });
});

describe("editing a series", () => {
  test("a new start time cancels the scheduled occurrences and schedules the new ones, each announced", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    const before = await storage.maintenance.list();
    const { announce, events } = recorder();
    saved(
      await editSeries(
        storage,
        series.id,
        planned([web], { recurrence: { ...twiceWeekly, time: "15:00" } }),
        noon,
        announce
      )
    );
    const after = (await storage.maintenance.list()).filter(
      (each) => each.seriesId === series.id
    );
    expect(after.map((each) => each.startsAt)).toEqual([
      tuesday + hour,
      thursday + hour,
    ]);
    expect(events).toEqual([
      ...before.map((window) => ({
        at: noon,
        type: "maintenance.cancelled" as const,
        window,
      })),
      ...after.map((each) => ({
        type: "maintenance.scheduled" as const,
        windowId: each.id,
      })),
    ]);
  });

  test("a new length keeps each scheduled occurrence and announces it rescheduled; new text alone announces nothing", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    const before = await storage.maintenance.list();
    const { announce, events } = recorder();
    saved(
      await editSeries(
        storage,
        series.id,
        planned([web], { recurrence: { ...twiceWeekly, minutes: 60 } }),
        noon,
        announce
      )
    );
    expect(events).toEqual(
      before.map((each) => ({
        type: "maintenance.rescheduled" as const,
        windowId: each.id,
      }))
    );
    expect(
      (await storage.maintenance.list()).map((each) => [
        each.id,
        each.endsAt - each.startsAt,
      ])
    ).toEqual(before.map((each) => [each.id, hour]));
    events.length = 0;
    saved(
      await editSeries(
        storage,
        series.id,
        planned([web], {
          recurrence: { ...twiceWeekly, minutes: 60 },
          title: { ar: "صيانة الخوادم الدورية" },
        }),
        noon,
        announce
      )
    );
    expect(events).toEqual([]);
    expect(
      (await storage.maintenance.list()).map((each) => each.title)
    ).toEqual([
      { ar: "صيانة الخوادم الدورية" },
      { ar: "صيانة الخوادم الدورية" },
    ]);
  });

  test("an edit keeps an occurrence skipped on its own skipped, and leaves the one in progress", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    await storage.maintenance.advance(tuesday);
    const thursdays = (await storage.maintenance.list()).filter(
      (each) => each.startsAt === thursday
    );
    await deleteWindow(storage, thursdays[0]?.id ?? "", tuesday);
    saved(
      await editSeries(
        storage,
        series.id,
        planned([web], { title: { ar: "صيانة الخوادم الدورية" } }),
        tuesday + hour
      )
    );
    expect(await occurrencesOf(storage, series.id)).toEqual([
      { stage: "in_progress", startsAt: tuesday },
      // Thursday stays skipped; a week from the edit reaches next Tuesday's start.
      { stage: "scheduled", startsAt: tuesday + 7 * day },
    ]);
    const [running] = await storage.maintenance.list();
    expect(running?.title).toEqual({ ar: "صيانة الخوادم" });
  });

  test("an edit in the second after an occurrence's start, before the tick moves it, leaves it and announces nothing of it", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    const { announce, events } = recorder();
    saved(
      await editSeries(
        storage,
        series.id,
        planned([web], { title: { ar: "صيانة الخوادم الدورية" } }),
        tuesday + 1000,
        announce
      )
    );
    expect(await occurrencesOf(storage, series.id)).toEqual([
      { stage: "scheduled", startsAt: tuesday },
      { stage: "scheduled", startsAt: thursday },
      // A week from the edit reaches next Tuesday's start, the one event.
      { stage: "scheduled", startsAt: tuesday + 7 * day },
    ]);
    const next = (await storage.maintenance.list()).at(-1);
    expect(events).toEqual([
      { type: "maintenance.scheduled" as const, windowId: next?.id ?? "" },
    ]);
  });

  test("an unknown series is not found, and a refused edit changes nothing", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    expect(
      await editSeries(storage, "no-such-series", planned([web]), noon)
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await editSeries(storage, series.id, planned(["no-such-component"]), noon)
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await storage.maintenance.findSeries(series.id)).toEqual(series);
  });
});

describe("ending a series", () => {
  test("cancels its scheduled occurrences, each announced, and the one in progress runs to its end", async () => {
    const { storage } = await opened();
    const web = await component(storage, "الموقع");
    const series = saved(await createSeries(storage, planned([web]), noon));
    await storage.maintenance.advance(tuesday);
    const [running, later] = await storage.maintenance.list();
    if (!(running && later)) {
      throw new Error("the series scheduled fewer than two occurrences");
    }
    const { announce, events } = recorder();
    expect(await endSeries(storage, series.id, tuesday, announce)).toEqual({
      ok: true,
    });
    expect(events).toEqual([
      { at: tuesday, type: "maintenance.cancelled" as const, window: later },
    ]);
    expect(await storage.maintenance.findSeries(series.id)).toBeUndefined();
    const left = await readWindow(storage, running.id, tuesday);
    expect(left.ok && left.page.window).toMatchObject({
      endsAt: tuesday + 2 * hour,
      stage: "in_progress",
    });
    expect(await endSeries(storage, series.id, tuesday)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { calendar, clock, timeZone } from "@/server/settings/clock.ts";
import type { IncidentCreateInput } from "@/shared/schemas/incident.ts";
import { publicPolicy } from "@/shared/schemas/overview.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import {
  historyDocumentSchema,
  incidentDocumentSchema,
  maintenanceDocumentSchema,
} from "@/shared/schemas/views.ts";
import { createComponent } from "./components.ts";
import { d0, day, hour, type PagesScratch, scratchPages } from "./fixture.ts";
import { readOverview } from "./overview.ts";
import { createPage, savePage } from "./pages.ts";
import {
  readHistory,
  readIncidentView,
  readMaintenanceView,
  readViewFrame,
  type ViewStorage,
  viewResponse,
} from "./views.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** Noon of 11 September 2026, UTC. */
const now = d0 + 10 * day + 12 * hour;
const author = "owner@example.com";

async function component(s: PagesScratch, name: string): Promise<string> {
  const created = await createComponent(s.storage, {
    description: undefined,
    monitorIds: [],
    name: { ar: name },
    status: "operational",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.component.id;
}

async function page(
  s: PagesScratch,
  componentIds: string[],
  slug = "main"
): Promise<string> {
  const created = await createPage(s.storage, {
    locale: "ar",
    slug,
    title: "حالة المتجر",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const saved = await savePage(s.storage, created.page.id, {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: created.page.isDefault,
    published: true,
    layout: componentIds.map((componentId) => ({
      componentId,
      kind: "component",
    })),
    locale: "ar",
    slug,
    title: { ar: "حالة المتجر" },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return created.page.id;
}

/** Opens an incident at `start` on the components, and resolves it at `end` when given. */
async function incident(
  s: PagesScratch,
  title: string,
  componentIds: string[],
  start: number,
  end?: number
): Promise<string> {
  s.at(start);
  const input: IncidentCreateInput = {
    impact: "minor",
    message: { ar: `${title}: نحقق.` },
    stage: "investigating",
    statuses: componentIds.map((componentId) => ({
      componentId,
      status: "partial_outage",
    })),
    title: { ar: title },
  };
  const created = await createIncident(s.storage, input, author);
  if (!created.ok) {
    throw new Error(created.reason);
  }
  if (end !== undefined) {
    s.at(end);
    const resolved = await postUpdate(
      s.storage,
      created.incident.id,
      { keep: false, message: { ar: `${title}: حُلّت.` }, stage: "resolved" },
      author
    );
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
  }
  return created.incident.id;
}

/** Schedules a window from `start` to `end`, written an hour before it starts. */
async function window(
  s: PagesScratch,
  title: string,
  componentIds: string[],
  start: number,
  end: number
): Promise<string> {
  const created = await createWindow(
    s.storage,
    {
      componentIds,
      endsAt: end,
      message: { ar: `${title}.` },
      startsAt: start,
      title: { ar: title },
    },
    start - hour
  );
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.window.id;
}

const iso = (ms: number) => new Date(ms).toISOString();
const aug = (dayOfMonth: number, h = 0, m = 0) =>
  Date.UTC(2026, 7, dayOfMonth, h, m);
const sep = (dayOfMonth: number, h = 0, m = 0) =>
  Date.UTC(2026, 8, dayOfMonth, h, m);

/**
 * A page showing the site and payments, and a component it does not show.
 * August: an incident that started on its last evening and ended in
 * September. September: a window on the site, a resolved incident on both,
 * an open incident, a resolved incident on the hidden component alone, and
 * a window still to come. July: a resolved incident on the hidden one.
 */
async function world() {
  scratch = await scratchPages(d0);
  const s = scratch;
  const web = await component(s, "الموقع");
  const pay = await component(s, "الدفع");
  const hidden = await component(s, "خارج الصفحة");
  const pageId = await page(s, [web, pay]);
  const july = await incident(
    s,
    "قديمة",
    [hidden],
    Date.UTC(2026, 6, 10),
    Date.UTC(2026, 6, 11)
  );
  const lateAugust = await incident(
    s,
    "ليلية",
    [pay],
    aug(31, 23, 30),
    sep(1, 1)
  );
  const maintained = await window(s, "ترقية", [web], sep(2, 10), sep(2, 11));
  const both = await incident(s, "بطء", [pay, web], sep(3, 8), sep(3, 9));
  const open = await incident(s, "مفتوحة", [web], sep(5, 8));
  const elsewhere = await incident(s, "لغيرها", [hidden], sep(4, 8), sep(4, 9));
  const coming = await window(s, "قادمة", [pay], now + day, now + day + hour);
  s.at(now);
  await s.storage.maintenance.advance(now);
  return {
    both,
    coming,
    elsewhere,
    hidden,
    july,
    lateAugust,
    maintained,
    open,
    pageId,
    pay,
    s,
    web,
  };
}

describe("a month of a page's history", () => {
  test("lists the page's resolved incidents and completed windows that started in the month, newest first", async () => {
    const w = await world();
    const result = await readHistory(w.s.storage, w.pageId, undefined, now);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const document = historyDocumentSchema.parse(result.document);
    expect(document.month).toBe("2026-09");
    expect(document.previous).toBe("2026-08");
    expect(document.next).toBeUndefined();
    expect(document.entries).toEqual([
      {
        components: [
          { id: w.web, name: { ar: "الموقع" } },
          { id: w.pay, name: { ar: "الدفع" } },
        ],
        id: w.both,
        impact: "minor",
        kind: "incident",
        resolvedAt: iso(sep(3, 9)),
        startedAt: iso(sep(3, 8)),
        title: { ar: "بطء" },
      },
      {
        components: [{ id: w.web, name: { ar: "الموقع" } }],
        endsAt: iso(sep(2, 11)),
        id: w.maintained,
        kind: "maintenance",
        startsAt: iso(sep(2, 10)),
        title: { ar: "ترقية" },
      },
    ]);
  });

  test("an incident belongs to the UTC month it started in, even when it ended in the next", async () => {
    const w = await world();
    const result = await readHistory(w.s.storage, w.pageId, "2026-08", now);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.document.entries.map((entry) => entry.id)).toEqual([
      w.lateAugust,
    ]);
    // The day bar reaches June, before the oldest entry.
    expect(result.document.previous).toBe("2026-07");
    expect(result.document.next).toBe("2026-09");
  });

  test("a completed window on no component the page shows is not in it", async () => {
    const w = await world();
    const elsewhere = await window(
      w.s,
      "لغيرها",
      [w.hidden],
      sep(6, 10),
      sep(6, 11)
    );
    await w.s.storage.maintenance.advance(now);
    const result = await readHistory(w.s.storage, w.pageId, "2026-09", now);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.document.entries.map((entry) => entry.id)).not.toContain(
      elsewhere
    );
  });

  test("an incident whose component left the page leaves its history", async () => {
    const w = await world();
    const saved = await savePage(w.s.storage, w.pageId, {
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: true,
      published: true,
      layout: [{ componentId: w.web, kind: "component" }],
      locale: "ar",
      slug: "main",
      title: { ar: "حالة المتجر" },
    });
    expect(saved.ok).toBe(true);
    // The August incident was on payments alone, so August shows nothing now.
    const result = await readHistory(w.s.storage, w.pageId, "2026-08", now);
    expect(result.ok && result.document.entries).toEqual([]);
  });

  test("a month before both the page's oldest entry and the day bar's first day, or after the current one, is not found, with the page's frame", async () => {
    const w = await world();
    for (const month of ["2026-05", "2026-10"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one month at a time
      const result = await readHistory(w.s.storage, w.pageId, month, now);
      expect(result.ok, month).toBe(false);
      if (!result.ok && result.reason === "not_found") {
        expect(result.frame?.page.title).toEqual({ ar: "حالة المتجر" });
      } else {
        throw new Error(`${month} was not answered not found`);
      }
    }
  });

  test("a page with no entry shows the current month, its history reaching back to the day bar's first day", async () => {
    scratch = await scratchPages(d0);
    const pageId = await page(scratch, [await component(scratch, "الموقع")]);
    const result = await readHistory(scratch.storage, pageId, undefined, now);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.document).toMatchObject({
      entries: [],
      month: "2026-09",
      next: undefined,
      previous: "2026-08",
    });
    const june = await readHistory(scratch.storage, pageId, "2026-06", now);
    expect(june.ok && june.document.previous).toBeUndefined();
  });

  test("an unknown page is not found with no frame", async () => {
    scratch = await scratchPages(d0);
    expect(await readHistory(scratch.storage, "nope", undefined, now)).toEqual({
      frame: undefined,
      ok: false,
      reason: "not_found",
    });
  });
});

describe("one incident as the page shows it", () => {
  test("a resolved incident with its impact, stage, times, the page's components it affects and every update newest first, never its author", async () => {
    const w = await world();
    const result = await readIncidentView(w.s.storage, w.pageId, w.both);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const document = incidentDocumentSchema.parse(result.document);
    expect(document.incident).toEqual({
      components: [
        { id: w.web, name: { ar: "الموقع" } },
        { id: w.pay, name: { ar: "الدفع" } },
      ],
      id: w.both,
      impact: "minor",
      resolvedAt: iso(sep(3, 9)),
      stage: "resolved",
      startedAt: iso(sep(3, 8)),
      title: { ar: "بطء" },
      updates: [
        { at: iso(sep(3, 9)), message: { ar: "بطء: حُلّت." }, stage: "resolved" },
        {
          at: iso(sep(3, 8)),
          message: { ar: "بطء: نحقق." },
          stage: "investigating",
        },
      ],
    });
    expect(JSON.stringify(result.document)).not.toContain(author);
  });

  test("an open incident has its latest stage and no resolve time", async () => {
    const w = await world();
    const result = await readIncidentView(w.s.storage, w.pageId, w.open);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.document.incident.stage).toBe("investigating");
    expect(result.document.incident.resolvedAt).toBeUndefined();
  });

  test("an incident on no component the page shows, and an unknown one, are not found with the page's frame", async () => {
    const w = await world();
    for (const id of [w.elsewhere, "nope"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one incident at a time
      const result = await readIncidentView(w.s.storage, w.pageId, id);
      if (result.ok || result.reason !== "not_found") {
        throw new Error(`${id} was not answered not found`);
      }
      expect(result.frame?.page.id).toBe(w.pageId);
    }
  });
});

describe("one maintenance window as the page shows it", () => {
  test("a completed window with its times, its text and the page's components it affects", async () => {
    const w = await world();
    const result = await readMaintenanceView(
      w.s.storage,
      w.pageId,
      w.maintained
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(maintenanceDocumentSchema.parse(result.document).window).toEqual({
      components: [{ id: w.web, name: { ar: "الموقع" } }],
      endsAt: iso(sep(2, 11)),
      id: w.maintained,
      message: { ar: "ترقية." },
      stage: "completed",
      startsAt: iso(sep(2, 10)),
      title: { ar: "ترقية" },
    });
  });

  test("a window still to come is shown at its stage", async () => {
    const w = await world();
    const result = await readMaintenanceView(w.s.storage, w.pageId, w.coming);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.document.window.stage).toBe("scheduled");
  });

  test("a window on no component the page shows, and an unknown one, are not found with the page's frame", async () => {
    const w = await world();
    const other = await window(
      w.s,
      "لغيرها",
      [w.hidden],
      now + 2 * day,
      now + 3 * day
    );
    for (const id of [other, "nope"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one window at a time
      const result = await readMaintenanceView(w.s.storage, w.pageId, id);
      if (result.ok || result.reason !== "not_found") {
        throw new Error(`${id} was not answered not found`);
      }
      expect(result.frame?.page.id).toBe(w.pageId);
    }
  });
});

describe("the page's frame", () => {
  test("is what the overview shows of the page and the install's clock", async () => {
    const w = await world();
    // None of the defaults, so a frame that ignored the settings would differ.
    await w.s.storage.settings.set(calendar, "hijri");
    await w.s.storage.settings.set(clock, "24h");
    await w.s.storage.settings.set(timeZone, "Asia/Riyadh");
    const frame = await readViewFrame(w.s.storage, w.pageId);
    const overview = await readOverview(w.s.storage, w.pageId, now);
    if (!(frame.ok && overview.ok)) {
      throw new Error("a read failed");
    }
    expect(overview.document).toMatchObject({
      calendar: "hijri",
      clock: "24h",
      timeZone: "Asia/Riyadh",
    });
    expect(frame.document).toEqual({
      calendar: overview.document.calendar,
      clock: overview.document.clock,
      page: overview.document.page,
      timeZone: overview.document.timeZone,
    });
  });

  test("of an unpublished page names none of its images, which a visitor's request would not find, as on a subscription's own page", async () => {
    const w = await world();
    const body = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await w.s.storage.pages.setImage(w.pageId, {
      body,
      contentType: "image/png",
      hash: "a".repeat(64),
      kind: "logo",
    });
    const stored = await w.s.storage.pages.find(w.pageId);
    if (!stored) {
      throw new Error("the page is gone");
    }
    const layout = await w.s.storage.pages.layout(w.pageId);
    await w.s.storage.pages.save(
      w.pageId,
      { ...stored, published: false },
      layout
    );
    const hidden = await readViewFrame(w.s.storage, w.pageId);
    expect(hidden.ok && hidden.document.page.images).toEqual({
      cover: undefined,
      favicon: undefined,
      logo: undefined,
    });
    await w.s.storage.pages.save(
      w.pageId,
      { ...stored, published: true },
      layout
    );
    const shown = await readViewFrame(w.s.storage, w.pageId);
    expect(shown.ok && shown.document.page.images.logo).toBe(
      `/api/pages/${w.pageId}/logo?v=${"a".repeat(64)}`
    );
  });

  test("every view carries it", async () => {
    const w = await world();
    const frame = await readViewFrame(w.s.storage, w.pageId);
    const reads = await Promise.all([
      readHistory(w.s.storage, w.pageId, undefined, now),
      readIncidentView(w.s.storage, w.pageId, w.both),
      readMaintenanceView(w.s.storage, w.pageId, w.maintained),
    ]);
    for (const result of reads) {
      if (!(result.ok && frame.ok)) {
        throw new Error("a read failed");
      }
      expect(result.document).toMatchObject(frame.document);
    }
  });
});

describe("a view document's public answer", () => {
  test("is the JSON with Cache-Control public, so the memo keeps it", async () => {
    const w = await world();
    const response = viewResponse(
      await readIncidentView(w.s.storage, w.pageId, w.both)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(publicPolicy);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8"
    );
    expect(
      incidentDocumentSchema.parse(await response.json()).incident.id
    ).toBe(w.both);
  });

  test("is 404 when nothing is at the address and 503 when the database did not answer or is not open, never kept", () => {
    const missing = viewResponse({
      frame: undefined,
      ok: false,
      reason: "not_found",
    });
    const down = viewResponse({ ok: false, reason: "unavailable" });
    const closed = viewResponse(undefined);
    expect([missing.status, down.status, closed.status]).toEqual([
      404, 503, 503,
    ]);
    for (const response of [missing, down, closed]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const w = await world();
    const broken: ViewStorage = {
      ...w.s.storage,
      pages: {
        ...w.s.storage.pages,
        find: () => Promise.reject(new Error("the database went away")),
      },
    };
    for (const read of [
      readHistory(broken, w.pageId, undefined, now),
      readIncidentView(broken, w.pageId, w.both),
      readMaintenanceView(broken, w.pageId, w.maintained),
      readViewFrame(broken, w.pageId),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one read at a time
      expect(await read).toEqual({ ok: false, reason: "unavailable" });
    }
  });
});

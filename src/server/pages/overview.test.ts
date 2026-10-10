import { afterEach, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { createMonitor } from "@/server/monitors/monitors.ts";
import { calendar, clock, timeZone } from "@/server/settings/clock.ts";
import { overviewDocumentSchema } from "@/shared/schemas/overview.ts";
import {
  defaultCustomization,
  type PageCustomization,
  type PageInput,
} from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { createComponent, deleteComponent } from "./components.ts";
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
import { overviewResponse, readOverview } from "./overview.ts";
import { createPage, savePage } from "./pages.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** Noon of the eleventh day of the scratch install's history. */
const now = d0 + 10 * day + 12 * hour;

async function opened(): Promise<PagesScratch> {
  scratch = await scratchPages(d0);
  return scratch;
}

async function component(
  s: PagesScratch,
  name: string,
  options: {
    monitorIds?: string[];
    status?: "operational" | "degraded_performance";
  } = {}
): Promise<string> {
  const created = await createComponent(s.storage, {
    description: undefined,
    monitorIds: options.monitorIds ?? [],
    name: { ar: name },
    status: options.status ?? "operational",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.component.id;
}

async function page(
  s: PagesScratch,
  layout: PageInput["layout"],
  customization: Partial<PageCustomization> = {},
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
    customization: { ...defaultCustomization, ...customization },
    isDefault: created.page.isDefault,
    published: true,
    layout,
    locale: "ar",
    slug,
    title: { ar: "حالة المتجر" },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return created.page.id;
}

async function overview(s: PagesScratch, pageId: string, at = now) {
  const result = await readOverview(s.storage, pageId, at);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.document;
}

describe("the overview document", () => {
  test("names the page's level and its components in its order, each group with its aggregate status", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const api = await component(s, "الواجهة", {
      status: "degraded_performance",
    });
    const mail = await component(s, "البريد");
    const pageId = await page(s, [
      { componentId: web, kind: "component" },
      { componentIds: [api, mail], kind: "group", name: { ar: "الخلفية" } },
    ]);
    const document = await overview(s, pageId);
    expect(document.level).toBe("degraded_performance");
    expect(
      document.items.map((item) =>
        item.kind === "component"
          ? [item.component.name, item.component.status]
          : [
              item.name,
              item.status,
              item.components.map((each) => [each.name, each.status]),
            ]
      )
    ).toEqual([
      [{ ar: "الموقع" }, "operational"],
      [
        { ar: "الخلفية" },
        "degraded_performance",
        [
          [{ ar: "الواجهة" }, "degraded_performance"],
          [{ ar: "البريد" }, "operational"],
        ],
      ],
    ]);
  });

  test("a page showing no components is operational with no items", async () => {
    const s = await opened();
    const document = await overview(s, await page(s, []));
    expect(document.level).toBe("operational");
    expect(document.items).toEqual([]);
  });

  test("a component linked to a down monitor shows the outage in its status, today's cell and its uptime", async () => {
    const s = await opened();
    const key = await scratchInstallKey();
    const created = await createMonitor(s.storage, key, site);
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const { monitor } = created;
    const web = await component(s, "الموقع", { monitorIds: [monitor.id] });
    const pageId = await page(s, [{ componentId: web, kind: "component" }], {
      barDays: 30,
    });
    const today = d0 + 10 * day;
    await checksEveryMinute(s.storage, monitor, today, today + 11 * hour, "up");
    await checksEveryMinute(s.storage, monitor, today + 11 * hour, now, "down");
    await s.storage.outages.open(
      monitor.id,
      today + 11 * hour,
      reasons.timeout
    );
    const document = await overview(s, pageId);
    const [item] = document.items;
    const shown = item?.kind === "component" ? item.component : undefined;
    expect(shown?.status).toBe("major_outage");
    expect(shown?.days).toHaveLength(30);
    expect(shown?.days?.[0]?.date).toBe("2026-08-13");
    const last = shown?.days?.at(-1);
    expect(last?.date).toBe("2026-09-11");
    expect(last?.downtimeMs).toBe(hour);
    expect(last?.observedMs).toBe(12 * hour);
    expect(last?.responseMs).toBe(120);
    expect(shown?.days?.[0]?.responseMs).toBeNull();
    // An hour down out of twelve observed: 91.66%, rounded down.
    expect(last?.uptime).toEqual({ decimals: 2, percent: 91.66 });
    expect(shown?.days?.[0]?.uptime).toBeNull();
    expect(shown?.uptime).toEqual({ decimals: 2, percent: 91.66 });
    expect(document.level).toBe("major_outage");
  });

  test("an unlinked component counts every moment since it was created, so a quiet day is 100", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const pageId = await page(s, [{ componentId: web, kind: "component" }]);
    const document = await overview(s, pageId);
    const [item] = document.items;
    const days = item?.kind === "component" ? item.component.days : undefined;
    expect(days).toHaveLength(90);
    expect(days?.at(-1)).toEqual({
      date: "2026-09-11",
      downtimeMs: 0,
      incidents: [],
      maintenance: [],
      observedMs: now - Date.UTC(2026, 8, 11),
      responseMs: null,
      uptime: { decimals: 0, percent: 100 },
    });
  });

  test("a page that hides its bar or its percentages leaves them out of the document", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const pageId = await page(s, [{ componentId: web, kind: "component" }], {
      bars: false,
      percentages: false,
    });
    const [item] = (await overview(s, pageId)).items;
    expect(item?.kind === "component" && item.component).toEqual({
      id: web,
      name: { ar: "الموقع" },
      status: "operational",
    });
  });

  test("an open incident touching the page is a card with its impact, stage, latest update and the page's components it affects, never its author", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const pay = await component(s, "الدفع");
    const hidden = await component(s, "خارج الصفحة");
    const pageId = await page(s, [
      { componentId: web, kind: "component" },
      { componentId: pay, kind: "component" },
    ]);
    s.at(now - 2 * hour);
    const opening = await createIncident(
      s.storage,
      {
        impact: "major",
        message: { ar: "نحقق في بطء صفحات الدفع." },
        stage: "investigating",
        statuses: [
          { componentId: hidden, status: "partial_outage" },
          { componentId: pay, status: "partial_outage" },
        ],
        title: { ar: "بطء في الدفع" },
      },
      "owner@example.com"
    );
    if (!opening.ok) {
      throw new Error(opening.reason);
    }
    s.at(now - hour);
    await postUpdate(
      s.storage,
      opening.incident.id,
      {
        message: { ar: "وجدنا السبب." },
        stage: "identified",
        statuses: [
          { componentId: hidden, status: "partial_outage" },
          { componentId: pay, status: "major_outage" },
        ],
      },
      "owner@example.com"
    );
    const document = await overview(s, pageId);
    expect(document.incidents).toEqual([
      {
        components: [pay],
        id: opening.incident.id,
        impact: "major",
        stage: "identified",
        title: { ar: "بطء في الدفع" },
        update: {
          at: new Date(now - hour).toISOString(),
          message: { ar: "وجدنا السبب." },
        },
      },
    ]);
    expect(JSON.stringify(document)).not.toContain("owner@example.com");
    expect(document.level).toBe("major_outage");
    // Today's cell of the affected component names the incident; the other's names none.
    const today = (id: string) =>
      document.items.flatMap((item) =>
        item.kind === "component" && item.component.id === id
          ? (item.component.days?.at(-1)?.incidents ?? [])
          : []
      );
    expect(today(pay)).toEqual([
      { id: opening.incident.id, title: { ar: "بطء في الدفع" } },
    ]);
    expect(today(web)).toEqual([]);
  });

  test("resolved incidents and incidents touching only other components are not cards; open ones are newest first", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const other = await component(s, "آخر");
    const pageId = await page(s, [{ componentId: web, kind: "component" }]);
    const open = async (title: string, componentId: string, at: number) => {
      s.at(at);
      const created = await createIncident(
        s.storage,
        {
          impact: "minor",
          message: { ar: "نحقق." },
          stage: "investigating",
          statuses: [{ componentId, status: "degraded_performance" }],
          title: { ar: title },
        },
        "owner@example.com"
      );
      if (!created.ok) {
        throw new Error(created.reason);
      }
      return created.incident.id;
    };
    const older = await open("الأقدم", web, now - 3 * hour);
    await open("لغيرها", other, now - 2 * hour);
    const closed = await open("انتهت", web, now - 90 * minute);
    await postUpdate(
      s.storage,
      closed,
      { keep: false, message: { ar: "انتهت." }, stage: "resolved" },
      "owner@example.com"
    );
    const newer = await open("الأحدث", web, now - hour);
    const document = await overview(s, pageId);
    expect(document.incidents.map((incident) => incident.id)).toEqual([
      newer,
      older,
    ]);
  });

  test("maintenance cards are the windows in progress first, then the scheduled ones soonest first, each with the page's components it affects", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const db = await component(s, "قاعدة البيانات");
    const other = await component(s, "آخر");
    const pageId = await page(s, [
      { componentId: web, kind: "component" },
      { componentId: db, kind: "component" },
    ]);
    const schedule = async (
      title: string,
      componentIds: string[],
      startsAt: number,
      endsAt: number
    ) => {
      const created = await createWindow(
        s.storage,
        {
          componentIds,
          endsAt,
          message: { ar: `${title}.` },
          startsAt,
          title: { ar: title },
        },
        now - 3 * hour
      );
      if (!created.ok) {
        throw new Error(created.reason);
      }
      return created.window.id;
    };
    const later = await schedule("لاحقة", [db], now + 5 * hour, now + 6 * hour);
    const sooner = await schedule(
      "قريبة",
      [web, other],
      now + 2 * hour,
      now + 3 * hour
    );
    const running = await schedule("جارية", [db], now - 2 * hour, now + hour);
    const done = await schedule("انتهت", [web], now - 2 * hour, now - hour);
    await schedule("لغيرها", [other], now + hour, now + 2 * hour);
    await s.storage.maintenance.advance(now);
    const document = await overview(s, pageId);
    expect(
      document.maintenance.map((window) => [
        window.id,
        window.stage,
        window.components,
      ])
    ).toEqual([
      [running, "in_progress", [db]],
      [sooner, "scheduled", [web]],
      [later, "scheduled", [db]],
    ]);
    expect(document.maintenance.map((window) => window.id)).not.toContain(done);
    expect(document.maintenance[0]).toMatchObject({
      endsAt: new Date(now + hour).toISOString(),
      message: { ar: "جارية." },
      startsAt: new Date(now - 2 * hour).toISOString(),
      title: { ar: "جارية" },
    });
    expect(document.level).toBe("under_maintenance");
  });

  test("carries the page's text, its images and what its customization shows, in both locales alike", async () => {
    const s = await opened();
    const pageId = await page(s, [], {
      brandColour: "#123456",
      contactUrl: "mailto:help@example.test",
      customCss: ".banner { border-width: 2px; }",
      description: { ar: "حالة خدمات المتجر" },
      footerLinks: [{ label: { ar: "الموقع" }, url: "https://example.test" }],
      labels: { operational: { ar: "كل شيء بخير" } },
      noindex: true,
      poweredBy: false,
      statusColours: { major_outage: "#ff0000" },
      theme: "dark",
    });
    await s.storage.pages.setImage(pageId, {
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
      hash: "abc123",
      kind: "logo",
    });
    const document = await overview(s, pageId);
    expect(document.page).toEqual({
      brandColour: "#123456",
      contactUrl: "mailto:help@example.test",
      customCss: ".banner { border-width: 2px; }",
      description: { ar: "حالة خدمات المتجر" },
      footerLinks: [{ label: { ar: "الموقع" }, url: "https://example.test" }],
      id: pageId,
      images: { logo: `/api/pages/${pageId}/logo?v=abc123` },
      labels: { operational: { ar: "كل شيء بخير" } },
      locale: "ar",
      noindex: true,
      poweredBy: false,
      statusColours: { major_outage: "#ff0000" },
      theme: "dark",
      title: { ar: "حالة المتجر" },
    });
  });

  test("carries the install's clock and time zone, which a visitor's times are first written in", async () => {
    const s = await opened();
    await s.storage.settings.set(timeZone, "Asia/Riyadh");
    await s.storage.settings.set(clock, "24h");
    const document = await overview(s, await page(s, []));
    expect(document.clock).toBe("24h");
    expect(document.timeZone).toBe("Asia/Riyadh");
  });

  test("carries the install's calendar, Gregorian until one is chosen, which a visitor's dates are written in", async () => {
    const s = await opened();
    const pageId = await page(s, []);
    expect((await overview(s, pageId)).calendar).toBe("gregorian");
    await s.storage.settings.set(calendar, "hijri_gregorian");
    expect((await overview(s, pageId)).calendar).toBe("hijri_gregorian");
  });

  test("the document fits its own schema, which the OpenAPI document publishes", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const pageId = await page(s, [
      { componentIds: [web], kind: "group", name: { ar: "الواجهة" } },
    ]);
    const document = await overview(s, pageId);
    expect(overviewDocumentSchema.parse(document)).toEqual(document);
  });

  test("an unknown page is not found", async () => {
    const s = await opened();
    expect(await readOverview(s.storage, "nope", now)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const s = await opened();
    const pageId = await page(s, []);
    const broken = {
      ...s.storage,
      pages: {
        ...s.storage.pages,
        find: () => Promise.reject(new Error("gone")),
      },
    };
    expect(await readOverview(broken, pageId, now)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("the overview document's public answer", () => {
  test("is the document as JSON with Cache-Control public, so the memo keeps it", async () => {
    const s = await opened();
    const pageId = await page(s, []);
    const response = await overviewResponse(s.storage, pageId, now);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate"
    );
    expect(await response.json()).toEqual(await overview(s, pageId));
  });

  test("an unknown page answers 404 and no database 503, neither kept", async () => {
    const s = await opened();
    const missing = await overviewResponse(s.storage, "nope", now);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    const closed = await overviewResponse(undefined, "nope", now);
    expect(closed.status).toBe(503);
    expect(closed.headers.get("cache-control")).toBe("no-store");
  });
});

describe("edges of the overview document", () => {
  test("a group whose components were all deleted shows nothing", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const gone = await component(s, "سيحذف");
    const pageId = await page(s, [
      { componentId: web, kind: "component" },
      { componentIds: [gone], kind: "group", name: { ar: "فارغة" } },
    ]);
    await deleteComponent(s.storage, gone);
    const document = await overview(s, pageId);
    expect(document.items.map((item) => item.kind)).toEqual(["component"]);
  });

  test("a page showing percentages but no bar carries the uptime alone", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const pageId = await page(s, [{ componentId: web, kind: "component" }], {
      bars: false,
    });
    const [item] = (await overview(s, pageId)).items;
    const shown = item?.kind === "component" ? item.component : undefined;
    expect(shown?.days).toBeUndefined();
    expect(shown?.uptime).toEqual({ decimals: 0, percent: 100 });
  });

  test("a card never names a component deleted since, which left the page's layout with its row", async () => {
    const s = await opened();
    const web = await component(s, "الموقع");
    const gone = await component(s, "سيحذف");
    const pageId = await page(s, [
      { componentId: web, kind: "component" },
      { componentId: gone, kind: "component" },
    ]);
    await createIncident(
      s.storage,
      {
        impact: "minor",
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [
          { componentId: web, status: "degraded_performance" },
          { componentId: gone, status: "degraded_performance" },
        ],
        title: { ar: "بطء" },
      },
      "owner@example.com"
    );
    await deleteComponent(s.storage, gone);
    const document = await overview(s, pageId);
    expect(document.incidents.map((each) => each.components)).toEqual([[web]]);
  });
});

describe("the subscribe form's channels in the overview document", () => {
  test("are the ones the page shows, email only while an email channel exists", async () => {
    const s = await opened();
    const both = await page(s, []);
    const hooks = await page(s, [], { subscriptions: ["webhook"] }, "hooks");
    const none = await page(s, [], { subscriptions: [] }, "none");
    expect((await overview(s, both)).subscribe).toEqual(["webhook"]);
    await s.storage.channels.create({
      appliesToNew: false,
      config: {
        from: "status@example.test",
        to: "ops@example.test",
      },
      locale: undefined,
      name: "mail",
      type: "email",
    });
    expect((await overview(s, both)).subscribe).toEqual(["email", "webhook"]);
    expect((await overview(s, hooks)).subscribe).toEqual(["webhook"]);
    expect((await overview(s, none)).subscribe).toEqual([]);
  });
});

describe("the overview document's content", () => {
  test("it carries each piece of content in every locale it is written in, so one document serves both locales' views", async () => {
    const s = await opened();
    const created = await createComponent(s.storage, {
      description: { ar: "المتجر", en: "The shop" },
      monitorIds: [],
      name: { ar: "الموقع", en: "Website" },
      status: "operational",
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const web = created.component.id;
    const pageId = await page(
      s,
      [
        {
          componentIds: [web],
          kind: "group",
          name: { ar: "الأساس", en: "Core" },
        },
      ],
      {
        description: { ar: "حالة خدماتنا" },
        footerLinks: [
          {
            label: { ar: "المساعدة", en: "Help" },
            url: "https://example.test",
          },
        ],
        labels: { operational: { en: "All good" } },
      }
    );
    const opening = await createIncident(
      s.storage,
      {
        impact: "minor",
        message: { ar: "نحقق.", en: "Looking into it." },
        stage: "investigating",
        statuses: [{ componentId: web, status: "degraded_performance" }],
        title: { ar: "بطء", en: "Slow" },
      },
      "owner@example.com"
    );
    expect(opening.ok).toBe(true);
    const document = await overview(s, pageId);
    expect(document.page).toMatchObject({
      description: { ar: "حالة خدماتنا" },
      footerLinks: [
        { label: { ar: "المساعدة", en: "Help" }, url: "https://example.test" },
      ],
      labels: { operational: { en: "All good" } },
      title: { ar: "حالة المتجر" },
    });
    const [group] = document.items;
    expect(group?.kind === "group" && group.name).toEqual({
      ar: "الأساس",
      en: "Core",
    });
    expect(group?.kind === "group" && group.components[0]).toMatchObject({
      description: { ar: "المتجر", en: "The shop" },
      name: { ar: "الموقع", en: "Website" },
    });
    expect(document.incidents[0]).toMatchObject({
      title: { ar: "بطء", en: "Slow" },
      update: { message: { ar: "نحقق.", en: "Looking into it." } },
    });
    expect(overviewDocumentSchema.parse(document)).toEqual(document);
  });
});

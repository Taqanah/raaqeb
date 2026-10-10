import { afterEach, describe, expect, test } from "bun:test";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { timeZone } from "@/server/settings/clock.ts";
import type {
  IncidentCreateInput,
  IncidentUpdateInput,
} from "@/shared/schemas/incident.ts";
import type { PagePaths } from "@/shared/schemas/overview.ts";
import { defaultCustomization, type PageInput } from "@/shared/schemas/page.ts";
import {
  type SummaryDocument,
  summaryDocumentSchema,
} from "@/shared/schemas/summary.ts";
import { createComponent } from "./components.ts";
import {
  d0,
  day,
  hour,
  type PagesScratch,
  scratchPages,
  testAddress,
} from "./fixture.ts";
import { createPage, savePage } from "./pages.ts";
import {
  readIncidentEvent,
  readSummary,
  type SummaryStorage,
} from "./summary.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** Noon of 11 September 2026, UTC. */
const now = d0 + 10 * day + 12 * hour;
const author = "owner@example.com";
const iso = (ms: number) => new Date(ms).toISOString();

/** The default page's addresses on the public address. */
const paths: PagePaths = {
  bases: { ar: "", en: "/en" },
  origin: testAddress,
};

async function component(s: PagesScratch, name: string): Promise<string> {
  const created = await createComponent(s.storage, {
    description: name === "الموقع" ? { ar: "الواجهة العامة" } : undefined,
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
  layout: PageInput["layout"]
): Promise<string> {
  const created = await createPage(s.storage, {
    locale: "ar",
    slug: "main",
    title: "حالة المتجر",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const saved = await savePage(s.storage, created.page.id, {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: true,
    published: true,
    layout,
    locale: "ar",
    slug: "main",
    title: { ar: "حالة المتجر" },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return created.page.id;
}

async function incident(
  s: PagesScratch,
  input: Omit<IncidentCreateInput, "message" | "stage">,
  start: number
): Promise<string> {
  s.at(start);
  const created = await createIncident(
    s.storage,
    {
      ...input,
      message: { ar: `${input.title.ar}: نحقق.` },
      stage: "investigating",
    },
    author
  );
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.incident.id;
}

async function update(
  s: PagesScratch,
  incidentId: string,
  at: number,
  input: IncidentUpdateInput
): Promise<void> {
  s.at(at);
  const posted = await postUpdate(s.storage, incidentId, input, author);
  if (!posted.ok) {
    throw new Error(posted.reason);
  }
}

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

/**
 * A page showing the site alone, then a group "الخدمات" of payments and
 * search; a component it does not show. An open incident on the site and
 * the hidden one, moved to identified and then monitoring; a resolved
 * incident on payments; an incident on the hidden one alone; a window in
 * progress on search, one to come on payments, one completed on the site,
 * one to come on the hidden one.
 */
async function world() {
  scratch = await scratchPages(d0);
  const s = scratch;
  const web = await component(s, "الموقع");
  const pay = await component(s, "الدفع");
  const search = await component(s, "البحث");
  const hidden = await component(s, "خارج الصفحة");
  const pageId = await page(s, [
    { componentId: web, kind: "component" },
    { componentIds: [pay, search], kind: "group", name: { ar: "الخدمات" } },
  ]);
  const open = await incident(
    s,
    {
      impact: "major",
      statuses: [
        { componentId: web, status: "partial_outage" },
        { componentId: hidden, status: "major_outage" },
      ],
      title: { ar: "بطء الموقع" },
    },
    now - 3 * hour
  );
  const held = [
    { componentId: web, status: "major_outage" },
    { componentId: hidden, status: "major_outage" },
  ] as const;
  await update(s, open, now - 2 * hour, {
    message: { ar: "عرفنا السبب" },
    stage: "identified",
    statuses: [...held],
  });
  await update(s, open, now - hour, {
    message: { ar: "نراقب" },
    stage: "monitoring",
    statuses: [...held],
  });
  const resolved = await incident(
    s,
    {
      impact: "critical",
      statuses: [{ componentId: pay, status: "major_outage" }],
      title: { ar: "توقف الدفع" },
    },
    now - 5 * day
  );
  await update(s, resolved, now - 5 * day + hour, {
    keep: false,
    message: { ar: "حُلّت" },
    stage: "resolved",
  });
  const elsewhere = await incident(
    s,
    {
      impact: "critical",
      statuses: [{ componentId: hidden, status: "major_outage" }],
      title: { ar: "لغيرها" },
    },
    now - 2 * day
  );
  const running = await window(
    s,
    "صيانة البحث",
    [search],
    now - hour,
    now + hour
  );
  const coming = await window(
    s,
    "صيانة الدفع",
    [pay],
    now + day,
    now + day + hour
  );
  const done = await window(s, "انتهت", [web], now - 3 * day, now - 2 * day);
  const away = await window(s, "بعيدة", [hidden], now + day, now + 2 * day);
  s.at(now);
  await s.storage.maintenance.advance(now);
  return {
    away,
    coming,
    done,
    elsewhere,
    hidden,
    open,
    pageId,
    pay,
    resolved,
    running,
    s,
    search,
    web,
  };
}

async function summaryOf(
  w: Awaited<ReturnType<typeof world>>,
  at = paths
): Promise<SummaryDocument> {
  const result = await readSummary(w.s.storage, w.pageId, at);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.document;
}

describe("the Statuspage-compatible summary", () => {
  test("parses as the shared summary schema, the one the OpenAPI document embeds", async () => {
    const w = await world();
    const document = await summaryOf(w);
    expect(summaryDocumentSchema.parse(document)).toEqual(document);
  });

  test("names the page by its id, title, plain address and the install's time zone", async () => {
    const w = await world();
    // Not the host's zone, so a summary that ignored the setting would differ.
    await w.s.storage.settings.set(timeZone, "Asia/Riyadh");
    const named = (await summaryOf(w)).page;
    expect(named.id).toBe(w.pageId);
    expect(named.name).toBe("حالة المتجر");
    expect(named.url).toBe(testAddress);
    expect(named.time_zone).toBe("Asia/Riyadh");
  });

  test("the page's url hangs from its own plain address, and is a path when no public address is stored", async () => {
    const w = await world();
    const other = await summaryOf(w, {
      bases: { ar: "/status/main", en: "/en/status/main" },
      origin: testAddress,
    });
    expect(other.page.url).toBe(`${testAddress}/status/main`);
    const bare = await summaryOf(w, {
      bases: { ar: "", en: "/en" },
      origin: undefined,
    });
    expect(bare.page.url).toBe("/");
  });

  test("the page's updated_at is the latest change to anything the summary lists", async () => {
    const w = await world();
    const changed = (await summaryOf(w)).page.updated_at;
    // The scheduler's move of the window in progress, at now, is the latest; the open incident's last update is an hour before.
    expect(changed).toBe(iso(now));
  });

  test("an update to an open incident moves the page's updated_at", async () => {
    const w = await world();
    await update(w.s, w.open, now + hour, {
      message: { ar: "ما زلنا نراقب" },
      stage: "monitoring",
      statuses: [
        { componentId: w.web, status: "degraded_performance" },
        { componentId: w.hidden, status: "degraded_performance" },
      ],
    });
    expect((await summaryOf(w)).page.updated_at).toBe(iso(now + hour));
  });

  test("lists the page's components in its order, a group before its members, with positions and group ids", async () => {
    const w = await world();
    const { components } = await summaryOf(w);
    expect(components.map((each) => each.name)).toEqual([
      "الموقع",
      "الخدمات",
      "الدفع",
      "البحث",
    ]);
    const [site, group, pay, search] = components;
    expect(site).toMatchObject({
      description: "الواجهة العامة",
      group: false,
      group_id: null,
      id: w.web,
      page_id: w.pageId,
      position: 1,
      showcase: true,
    });
    expect(group).toMatchObject({
      components: [w.pay, w.search],
      description: null,
      group: true,
      group_id: null,
      position: 2,
      showcase: false,
    });
    expect(pay).toMatchObject({ group_id: group?.id, position: 1 });
    expect(search).toMatchObject({ group_id: group?.id, position: 2 });
    expect(site?.components).toBe(undefined);
    expect(group?.id).not.toBe(w.pageId);
  });

  test("a group's id stays while the page keeps its layout", async () => {
    const w = await world();
    const first = await summaryOf(w);
    const second = await summaryOf(w);
    expect(second.components[1]?.id).toBe(first.components[1]?.id);
  });

  test("each component carries its status now, and a group the worst of its members'", async () => {
    const w = await world();
    const { components } = await summaryOf(w);
    expect(components.map((each) => each.status)).toEqual([
      "major_outage",
      "under_maintenance",
      "operational",
      "under_maintenance",
    ]);
  });

  test("lists only the open incidents touching the page, with the page's components they affect", async () => {
    const w = await world();
    const { incidents } = await summaryOf(w);
    expect(incidents.map((each) => each.id)).toEqual([w.open]);
    const [open] = incidents;
    expect(open).toMatchObject({
      created_at: iso(now - 3 * hour),
      impact: "major",
      monitoring_at: iso(now - hour),
      name: "بطء الموقع",
      page_id: w.pageId,
      reminder_intervals: null,
      resolved_at: null,
      shortlink: `${testAddress}/incidents/${w.open}`,
      started_at: iso(now - 3 * hour),
      status: "monitoring",
      updated_at: iso(now - hour),
    });
    expect(open?.components.map((each) => each.id)).toEqual([w.web]);
  });

  test("an incident's updates come newest first, each with what it set on the page's components", async () => {
    const w = await world();
    const [open] = (await summaryOf(w)).incidents;
    expect(open?.incident_updates.map((each) => each.status)).toEqual([
      "monitoring",
      "identified",
      "investigating",
    ]);
    const [monitoring, identified, investigating] =
      open?.incident_updates ?? [];
    expect(investigating).toMatchObject({
      affected_components: [
        {
          code: w.web,
          name: "الموقع",
          new_status: "partial_outage",
          old_status: "operational",
        },
      ],
      body: "بطء الموقع: نحقق.",
      created_at: iso(now - 3 * hour),
      custom_tweet: null,
      deliver_notifications: true,
      display_at: iso(now - 3 * hour),
      incident_id: w.open,
      tweet_id: null,
      updated_at: iso(now - 3 * hour),
    });
    expect(identified?.affected_components).toEqual([
      {
        code: w.web,
        name: "الموقع",
        new_status: "major_outage",
        old_status: "partial_outage",
      },
    ]);
    expect(monitoring?.affected_components).toEqual([
      {
        code: w.web,
        name: "الموقع",
        new_status: "major_outage",
        old_status: "major_outage",
      },
    ]);
    expect(new Set(open?.incident_updates.map((each) => each.id)).size).toBe(3);
  });

  test("the update that first names a component gives as its old_status the status kept before it; one kept without falls back to operational", async () => {
    const w = await world();
    const opening = {
      author,
      message: { ar: "نحقق." },
      stage: "investigating",
    } as const;
    const kept = await w.s.storage.incidents.create(
      { impact: "minor", title: { ar: "معروفة" } },
      {
        ...opening,
        before: new Map([[w.pay, "partial_outage"]]),
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
      }
    );
    await w.s.storage.incidents.post(
      kept.id,
      {
        ...opening,
        before: new Map([[w.search, "under_maintenance"]]),
        stage: "identified",
        statuses: [
          { componentId: w.pay, status: "major_outage" },
          { componentId: w.search, status: "major_outage" },
        ],
      },
      [],
      kept.updates.at(-1)?.id ?? ""
    );
    const unkept = await w.s.storage.incidents.create(
      { impact: "minor", title: { ar: "قديمة" } },
      {
        ...opening,
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
      }
    );
    const { incidents } = await summaryOf(w);
    const changes = (id: string) =>
      incidents
        .find((each) => each.id === id)
        ?.incident_updates.toReversed()
        .map((each) =>
          each.affected_components.map(({ code, new_status, old_status }) => ({
            code,
            new_status,
            old_status,
          }))
        );
    expect(changes(kept.id)).toEqual([
      [
        {
          code: w.pay,
          new_status: "degraded_performance",
          old_status: "partial_outage",
        },
      ],
      [
        {
          code: w.pay,
          new_status: "major_outage",
          old_status: "degraded_performance",
        },
        {
          code: w.search,
          new_status: "major_outage",
          old_status: "under_maintenance",
        },
      ],
    ]);
    expect(changes(unkept.id)).toEqual([
      [
        {
          code: w.pay,
          new_status: "degraded_performance",
          old_status: "operational",
        },
      ],
    ]);
  });

  test("an incident never at monitoring has no monitoring_at", async () => {
    const w = await world();
    const fresh = await incident(
      w.s,
      {
        impact: "minor",
        statuses: [{ componentId: w.web, status: "degraded_performance" }],
        title: { ar: "جديدة" },
      },
      now
    );
    const found = (await summaryOf(w)).incidents.find(
      (each) => each.id === fresh
    );
    expect(found?.monitoring_at).toBe(null);
    expect(found?.status).toBe("investigating");
  });

  test("the open incidents come newest first", async () => {
    const w = await world();
    const fresh = await incident(
      w.s,
      {
        impact: "none",
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
        title: { ar: "جديدة" },
      },
      now
    );
    const { incidents } = await summaryOf(w);
    expect(incidents.map((each) => each.id)).toEqual([fresh, w.open]);
  });

  test("lists the windows in progress and scheduled on the page's components, in progress first, with no updates", async () => {
    const w = await world();
    const { scheduled_maintenances: windows } = await summaryOf(w);
    expect(windows.map((each) => each.id)).toEqual([w.running, w.coming]);
    const [running, coming] = windows;
    expect(running).toMatchObject({
      impact: "maintenance",
      incident_updates: [],
      monitoring_at: null,
      name: "صيانة البحث",
      page_id: w.pageId,
      resolved_at: null,
      scheduled_for: iso(now - hour),
      scheduled_until: iso(now + hour),
      shortlink: `${testAddress}/maintenance/${w.running}`,
      status: "in_progress",
    });
    expect(running?.components.map((each) => each.id)).toEqual([w.search]);
    expect(coming).toMatchObject({
      scheduled_for: iso(now + day),
      status: "scheduled",
    });
  });

  test("the indicator is the worse of the page level mapped and the open incidents' impact, with Statuspage's description", async () => {
    const w = await world();
    expect((await summaryOf(w)).status).toEqual({
      description: "Major System Outage",
      indicator: "critical",
    });
  });

  test("an operational page with no open incident reads none", async () => {
    scratch = await scratchPages(d0);
    const web = await component(scratch, "الموقع");
    const pageId = await page(scratch, [
      { componentId: web, kind: "component" },
    ]);
    const result = await readSummary(scratch.storage, pageId, paths);
    expect(result.ok && result.document.status).toEqual({
      description: "All Systems Operational",
      indicator: "none",
    });
    expect(result.ok && result.document.incidents).toEqual([]);
    expect(result.ok && result.document.scheduled_maintenances).toEqual([]);
  });

  test("a group whose components are all deleted is left out, and the positions close up", async () => {
    const w = await world();
    for (const id of [w.pay, w.search]) {
      // biome-ignore lint/performance/noAwaitInLoops: one delete at a time
      await w.s.storage.components.remove(id);
    }
    const { components } = await summaryOf(w);
    expect(components.map((each) => [each.name, each.position])).toEqual([
      ["الموقع", 1],
    ]);
    expect((await summaryOf(w)).scheduled_maintenances).toEqual([]);
  });

  test("an unknown page is not found", async () => {
    scratch = await scratchPages(d0);
    const result = await readSummary(scratch.storage, "no-such-page", paths);
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const w = await world();
    const broken: SummaryStorage = {
      ...w.s.storage,
      incidents: {
        ...w.s.storage.incidents,
        open: () => Promise.reject(new Error("the database went away")),
      },
    };
    expect(await readSummary(broken, w.pageId, paths)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("the summary's content", () => {
  /** An Arabic page showing one component written in both locales and one in English alone, with an open incident on both. */
  async function bilingual() {
    scratch = await scratchPages(d0);
    const s = scratch;
    const both = await createComponent(s.storage, {
      description: { ar: "الواجهة العامة", en: "The public API" },
      monitorIds: [],
      name: { ar: "الواجهة", en: "API" },
      status: "operational",
    });
    // Stored as is: an install whose language was English when it was written.
    const english = await s.storage.components.create({
      description: undefined,
      monitorIds: [],
      name: { en: "Website" },
      status: "operational",
    });
    if (!both.ok) {
      throw new Error(both.reason);
    }
    const pageId = await page(s, [
      { componentId: both.component.id, kind: "component" },
      { componentId: english.id, kind: "component" },
    ]);
    s.at(now - hour);
    const opened = await createIncident(
      s.storage,
      {
        impact: "minor",
        message: { ar: "نحقق.", en: "Looking into it." },
        stage: "investigating",
        statuses: [{ componentId: english.id, status: "degraded_performance" }],
        title: { ar: "بطء", en: "Slow" },
      },
      author
    );
    if (!opened.ok) {
      throw new Error(opened.reason);
    }
    s.at(now);
    return { incident: opened.incident, pageId, s };
  }

  test("it names everything in the page language, an empty translation falling back to the locale written", async () => {
    const { pageId, s } = await bilingual();
    const result = await readSummary(s.storage, pageId, paths);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { document } = result;
    expect(document.page.name).toBe("حالة المتجر");
    expect(
      document.components.map((each) => [each.name, each.description])
    ).toEqual([
      ["الواجهة", "الواجهة العامة"],
      ["Website", null],
    ]);
    expect(document.incidents[0]?.name).toBe("بطء");
    expect(document.incidents[0]?.incident_updates[0]?.body).toBe("نحقق.");
    expect(document.incidents[0]?.components[0]?.name).toBe("Website");
  });

  test("an event for the other locale's subscribers names everything in that locale, falling back to the page language's", async () => {
    const { incident: published, pageId, s } = await bilingual();
    const event = await readIncidentEvent(
      s.storage,
      pageId,
      paths,
      published,
      "en"
    );
    expect(event?.page.name).toBe("حالة المتجر");
    expect(event?.incident.name).toBe("Slow");
    expect(event?.incident.incident_updates[0]?.body).toBe("Looking into it.");
    expect(event?.incident.components.map((each) => each.name)).toEqual([
      "Website",
    ]);
  });
});

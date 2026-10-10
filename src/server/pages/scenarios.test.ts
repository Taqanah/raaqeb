/**
 * The scenarios, end to end over storage on either backend
 * Scenario 3 needs the scheduler to
 * start and end its window, so it lives in
 * src/server/scheduler/scheduler.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  createComponent,
  listComponents,
  readComponentDays,
} from "./components.ts";
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
import { createPage, listPages, savePage } from "./pages.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** Noon of the scratch install's first day. */
const noon = d0 + 12 * hour;

async function pageShowing(
  opened: PagesScratch,
  slug: string,
  componentId: string
): Promise<string> {
  const created = await createPage(opened.storage, {
    locale: "ar",
    slug,
    title: slug,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const saved = await savePage(opened.storage, created.page.id, {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: created.page.isDefault,
    published: true,
    layout: [{ componentId, kind: "component" }],
    locale: "ar",
    slug,
    title: { ar: slug },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return created.page.id;
}

async function component(
  opened: PagesScratch,
  name: string,
  monitorIds: readonly string[]
): Promise<string> {
  const created = await createComponent(opened.storage, {
    monitorIds: [...monitorIds],
    name: { ar: name },
    status: "operational",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.component.id;
}

describe("the domain model's scenarios", () => {
  test("scenario 1: one monitor linked to two components on two pages is one outage; both components derive major outage, both pages show it, both bars show the same downtime", async () => {
    scratch = await scratchPages();
    const { storage } = scratch;
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 11 * hour, "up");
    await checksEveryMinute(storage, monitor, d0 + 11 * hour, noon, "down");
    expect(
      await storage.outages.open(monitor.id, d0 + 11 * hour, reasons.timeout)
    ).toBe(true);

    // Each record a millisecond apart, so the lists' creation order is certain.
    scratch.at(noon);
    const web = await component(scratch, "Web", [monitor.id]);
    scratch.at(noon + 1);
    const api = await component(scratch, "API", [monitor.id]);
    scratch.at(noon + 2);
    const first = await pageShowing(scratch, "first", web);
    scratch.at(noon + 3);
    const second = await pageShowing(scratch, "second", api);

    expect(await storage.outages.ongoing()).toHaveLength(1);
    const listed = await listComponents(storage, noon);
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    expect(
      listed.components.map((item) => [item.component.id, item.status])
    ).toEqual([
      [web, "major_outage"],
      [api, "major_outage"],
    ]);

    const pages = await listPages(storage);
    if (!pages.ok) {
      throw new Error(pages.reason);
    }
    expect(pages.pages.map((item) => [item.page.id, item.level])).toEqual([
      [first, "major_outage"],
      [second, "major_outage"],
    ]);

    const components = await storage.components.list();
    const days = await readComponentDays(storage, components, {
      days: 90,
      now: noon,
    });
    const webDays = days.get(web);
    expect(webDays).toEqual(days.get(api));
    expect(webDays?.at(-1)).toEqual({
      day: d0,
      downtimeMs: hour,
      incidents: [],
      maintenance: [],
      observedMs: 12 * hour,
      responseMs: 120,
    });
  });

  test("scenario 4: with every linked monitor paused the last derived status stands, and the paused time is no data", async () => {
    scratch = await scratchPages();
    const { storage } = scratch;
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 11 * hour, "up");
    await checksEveryMinute(storage, monitor, d0 + 11 * hour, noon, "down");
    await storage.outages.open(monitor.id, d0 + 11 * hour, reasons.timeout);
    const id = await component(scratch, "Web", [monitor.id]);

    scratch.at(noon);
    await storage.monitors.pause([monitor.id]);

    // The next day, still paused.
    const later = d0 + day + 12 * hour;
    const listed = await listComponents(storage, later);
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    expect(listed.components[0]?.status).toBe("major_outage");

    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 90, now: later }
    );
    const cells = days.get(id) ?? [];
    // The first day is observed up to the last check before the pause, which closed the outage; the next day, paused throughout, is no data.
    expect(cells.at(-2)).toEqual({
      day: d0,
      downtimeMs: hour,
      incidents: [],
      maintenance: [],
      observedMs: 12 * hour - minute,
      responseMs: 120,
    });
    expect(cells.at(-1)).toEqual({
      day: d0 + day,
      downtimeMs: 0,
      incidents: [],
      maintenance: [],
      observedMs: 0,
      responseMs: undefined,
    });
  });

  test("scenario 2: an incident with no monitor sets its component's status by its updates, and the bar shows the time it held the component down", async () => {
    scratch = await scratchPages();
    const { storage } = scratch;
    const id = await component(scratch, "Payments", []);
    const page = await pageShowing(scratch, "status", id);

    scratch.at(d0 + 2 * hour);
    const opened = await createIncident(
      storage,
      {
        impact: "major",
        message: { ar: "Payments fail for some cards." },
        stage: "investigating",
        statuses: [{ componentId: id, status: "partial_outage" }],
        title: { ar: "Card payments failing" },
      },
      "owner@example.com"
    );
    if (!opened.ok) {
      throw new Error(opened.reason);
    }
    const shown = async () => {
      const listed = await listComponents(storage, noon);
      const pages = await listPages(storage);
      return [
        listed.ok ? listed.components[0]?.status : listed.reason,
        pages.ok
          ? pages.pages.find((item) => item.page.id === page)?.level
          : pages.reason,
      ];
    };
    expect(await shown()).toEqual(["partial_outage", "partial_outage"]);

    scratch.at(d0 + 4 * hour);
    await postUpdate(
      storage,
      opened.incident.id,
      {
        message: { ar: "Every payment fails now." },
        stage: "identified",
        statuses: [{ componentId: id, status: "major_outage" }],
      },
      "owner@example.com"
    );
    expect(await shown()).toEqual(["major_outage", "major_outage"]);

    scratch.at(d0 + 5 * hour);
    await postUpdate(
      storage,
      opened.incident.id,
      { keep: false, message: { ar: "Fixed." }, stage: "resolved" },
      "owner@example.com"
    );
    expect(await shown()).toEqual(["operational", "operational"]);

    const days = await readComponentDays(
      storage,
      await storage.components.list(),
      { days: 1, now: noon }
    );
    // Held at partial then major outage from 02:00 to 05:00; an unlinked component observes every moment since it was created.
    expect(days.get(id)).toEqual([
      {
        day: d0,
        downtimeMs: 3 * hour,
        incidents: [
          { id: opened.incident.id, title: { ar: "Card payments failing" } },
        ],
        maintenance: [],
        observedMs: 12 * hour,
        responseMs: undefined,
      },
    ]);
  });

  test("scenario 5: an incident resolved while a linked monitor is still down leaves the component red from its derived status", async () => {
    scratch = await scratchPages();
    const { storage } = scratch;
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, d0, d0 + 11 * hour, "up");
    await checksEveryMinute(storage, monitor, d0 + 11 * hour, noon, "down");
    await storage.outages.open(monitor.id, d0 + 11 * hour, reasons.timeout);
    const id = await component(scratch, "Web", [monitor.id]);

    scratch.at(d0 + 11 * hour + 30 * minute);
    const opened = await createIncident(
      storage,
      {
        impact: "critical",
        message: { ar: "The site is down." },
        stage: "investigating",
        statuses: [{ componentId: id, status: "major_outage" }],
        title: { ar: "Site down" },
      },
      "owner@example.com"
    );
    if (!opened.ok) {
      throw new Error(opened.reason);
    }
    scratch.at(noon - minute);
    const resolved = await postUpdate(
      storage,
      opened.incident.id,
      {
        keep: false,
        message: { ar: "We think it is fixed." },
        stage: "resolved",
      },
      "owner@example.com"
    );
    expect(resolved.ok).toBe(true);
    const listed = await listComponents(storage, noon);
    expect(listed.ok && listed.components[0]?.status).toBe("major_outage");
  });
});

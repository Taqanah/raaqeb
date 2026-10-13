/**
 * Every write able to change public content moves the change counter: the memo is valid while the counter matches, so a write that forgets
 * leaves a stale page with nothing to heal it. One row per write the
 * operator makes, each through the module a route calls, on either backend.
 *
 * The scheduler's own writes are pinned beside the scheduler, where they
 * happen:
 * - a monitor's transition and every failing check while it is down,
 *   `src/server/scheduler/scheduler.test.ts` ("an outage opens on the first
 *   confirmed down check...", and "a silent period yields one down check..."
 *   for a heartbeat monitor);
 * - a maintenance window started and completed,
 *   `src/server/scheduler/maintenance.test.ts` and "the change counter moves
 *   when a window starts and again when it completes";
 * - the nightly purge, `src/server/scheduler/purge.test.ts`;
 * - every size-budget delete, `src/server/scheduler/budget.test.ts`;
 * - the five-minute refresh, "the five-minute refresh of the public figures".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import type { InstallKey } from "@/server/boot/installkey.ts";
import {
  createIncident,
  deleteIncident,
  editIncident,
  fixUpdate,
  postUpdate,
} from "@/server/incidents/incidents.ts";
import {
  createWindow,
  deleteWindow,
  editWindow,
  endWindow,
} from "@/server/maintenance/maintenance.ts";
import {
  createMonitor,
  deleteMonitors,
  editMonitor,
  pauseMonitors,
  resumeMonitors,
} from "@/server/monitors/monitors.ts";
import { createChannel, deleteChannel } from "@/server/notify/channels.ts";
import {
  createComponent,
  deleteComponent,
  editComponent,
} from "@/server/pages/components.ts";
import {
  d0,
  hour,
  type PagesScratch,
  scratchPages,
  site,
} from "@/server/pages/fixture.ts";
import { removePageImage, uploadPageImage } from "@/server/pages/images.ts";
import { createPage, deletePage, savePage } from "@/server/pages/pages.ts";
import { saveGeneralSettings } from "@/server/settings/general.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const now = d0 + 12 * hour;
const author = "owner@example.com";

/** One of everything public: a monitor, a component linked to it, a page showing it, an open incident and a scheduled window. */
interface World {
  readonly componentId: string;
  readonly incidentId: string;
  readonly key: InstallKey;
  readonly monitorId: string;
  readonly pageId: string;
  readonly s: PagesScratch;
  readonly updateId: string;
  readonly windowId: string;
}

/** Fails the test on a refused setup write. */
function must<T extends { readonly ok: boolean }>(
  result: T
): asserts result is Extract<T, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(`a setup write was refused: ${JSON.stringify(result)}`);
  }
}

async function world(): Promise<World> {
  scratch = await scratchPages(now);
  const s = scratch;
  const key = await scratchInstallKey();
  const monitor = await createMonitor(s.storage, key, site);
  must(monitor);
  const component = await createComponent(s.storage, {
    description: undefined,
    monitorIds: [monitor.monitor.id],
    name: { ar: "الموقع" },
    status: "operational",
  });
  must(component);
  const page = await createPage(s.storage, {
    locale: "ar",
    slug: "main",
    title: "Main",
  });
  must(page);
  const saved = await savePage(s.storage, page.page.id, {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: true,
    published: true,
    layout: [{ componentId: component.component.id, kind: "component" }],
    locale: "ar",
    slug: "main",
    title: { ar: "Main" },
  });
  must(saved);
  const incident = await createIncident(
    s.storage,
    {
      impact: "minor",
      message: { ar: "نحقق." },
      stage: "investigating",
      statuses: [
        { componentId: component.component.id, status: "degraded_performance" },
      ],
      title: { ar: "بطء" },
    },
    author
  );
  must(incident);
  const window = await createWindow(
    s.storage,
    {
      componentIds: [component.component.id],
      endsAt: now + 3 * hour,
      message: { ar: "ترقية." },
      startsAt: now + 2 * hour,
      title: { ar: "صيانة" },
    },
    now
  );
  must(window);
  return {
    componentId: component.component.id,
    incidentId: incident.incident.id,
    key,
    monitorId: monitor.monitor.id,
    pageId: page.page.id,
    s,
    updateId: incident.incident.updates[0]?.id ?? "",
    windowId: window.window.id,
  };
}

type Write = (w: World) => Promise<{ ok: boolean }>;

/** What a write needs done first; the counter is read after it, so a bump in the setup never stands in for the write's own. */
type Setup = (w: World) => Promise<unknown>;

const png = new Blob([
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
]);

/** An email channel as the channels page posts it. */
const mailChannel = {
  appliesToNew: false,
  name: "البريد",
  type: "email" as const,
  values: {
    from: "status@example.test",
    host: "127.0.0.1",
    port: "25",
    security: "none",
    to: "ops@example.test",
  },
};

/** Each write the operator makes that a status page can show. */
const writes: readonly (readonly [string, Write, Setup?])[] = [
  [
    "a monitor created",
    (w) => createMonitor(w.s.storage, w.key, { ...site, name: "API" }),
  ],
  [
    "a monitor edited",
    (w) =>
      editMonitor(w.s.storage, w.key, w.monitorId, { ...site, name: "Site 2" }),
  ],
  ["a monitor paused", (w) => pauseMonitors(w.s.storage, [w.monitorId])],
  [
    "a monitor resumed",
    (w) => resumeMonitors(w.s.storage, [w.monitorId]),
    (w) => pauseMonitors(w.s.storage, [w.monitorId]),
  ],
  ["a monitor deleted", (w) => deleteMonitors(w.s.storage, [w.monitorId])],
  [
    "a component created",
    (w) =>
      createComponent(w.s.storage, {
        description: undefined,
        monitorIds: [],
        name: { ar: "البريد" },
        status: "operational",
      }),
  ],
  [
    "a component edited, its status set by hand included",
    (w) =>
      editComponent(w.s.storage, w.componentId, {
        description: { ar: "وصف" },
        monitorIds: [],
        name: { ar: "الموقع" },
        status: "major_outage",
      }),
  ],
  ["a component deleted", (w) => deleteComponent(w.s.storage, w.componentId)],
  [
    "a page created",
    (w) => createPage(w.s.storage, { locale: "en", slug: "api", title: "API" }),
  ],
  [
    "a page saved",
    (w) =>
      savePage(w.s.storage, w.pageId, {
        customDomain: undefined,
        customization: { ...defaultCustomization, poweredBy: false },
        isDefault: true,
        published: true,
        layout: [],
        locale: "ar",
        slug: "main",
        title: { ar: "Main" },
      }),
  ],
  ["a page deleted", (w) => deletePage(w.s.storage, w.pageId)],
  [
    "a page image uploaded",
    (w) => uploadPageImage(w.s.storage, w.pageId, "logo", png),
  ],
  [
    "a page image removed",
    (w) => removePageImage(w.s.storage, w.pageId, "logo"),
    (w) => uploadPageImage(w.s.storage, w.pageId, "logo", png),
  ],
  [
    "an incident created",
    (w) =>
      createIncident(
        w.s.storage,
        {
          impact: "major",
          message: { ar: "انقطاع." },
          stage: "investigating",
          statuses: [{ componentId: w.componentId, status: "major_outage" }],
          title: { ar: "انقطاع" },
        },
        author
      ),
  ],
  [
    "an incident's title and impact edited",
    (w) =>
      editIncident(w.s.storage, w.incidentId, {
        impact: "critical",
        title: { ar: "بطء شديد" },
      }),
  ],
  [
    "an incident updated",
    (w) =>
      postUpdate(
        w.s.storage,
        w.incidentId,
        {
          message: { ar: "وجدنا السبب." },
          stage: "identified",
          statuses: [{ componentId: w.componentId, status: "partial_outage" }],
        },
        author
      ),
  ],
  [
    "an incident resolved",
    (w) =>
      postUpdate(
        w.s.storage,
        w.incidentId,
        { keep: false, message: { ar: "انتهت." }, stage: "resolved" },
        author
      ),
  ],
  [
    "an update's text fixed",
    (w) =>
      fixUpdate(w.s.storage, w.incidentId, w.updateId, {
        ar: "نحقق في البطء.",
      }),
  ],
  ["an incident deleted", (w) => deleteIncident(w.s.storage, w.incidentId)],
  [
    "a maintenance window scheduled",
    (w) =>
      createWindow(
        w.s.storage,
        {
          componentIds: [w.componentId],
          endsAt: now + 6 * hour,
          message: { ar: "نقل." },
          startsAt: now + 5 * hour,
          title: { ar: "نقل" },
        },
        now
      ),
  ],
  [
    "a maintenance window edited",
    (w) =>
      editWindow(
        w.s.storage,
        w.windowId,
        {
          componentIds: [w.componentId],
          endsAt: now + 4 * hour,
          message: { ar: "ترقية القاعدة." },
          startsAt: now + 2 * hour,
          title: { ar: "صيانة القاعدة" },
        },
        now
      ),
  ],
  [
    "a maintenance window ended now",
    (w) => endWindow(w.s.storage, w.windowId, now + 2 * hour + 1000),
    (w) => w.s.storage.maintenance.advance(now + 2 * hour),
  ],
  [
    "a maintenance window cancelled",
    (w) => deleteWindow(w.s.storage, w.windowId, now),
  ],
  [
    "an email channel created, since the subscribe form offers email only while one exists",
    (w) => createChannel(w.s.storage, w.key, mailChannel),
  ],
  [
    "an email channel deleted",
    async (w) => {
      const [mail] = await w.s.storage.channels.list();
      return deleteChannel(w.s.storage, mail?.id ?? "");
    },
    (w) => createChannel(w.s.storage, w.key, mailChannel),
  ],
  [
    "the general settings saved, the public address and the clock among them",
    (w) =>
      saveGeneralSettings(
        w.s.storage,
        {
          calendar: "gregorian",
          clock: "24h",
          installLanguage: "en",
          publicAddress: "https://status.example.test",
          releaseCheck: false,
          requestLog: false,
          timeZone: "Asia/Riyadh",
        },
        { trustedProxies: [] }
      ),
  ],
];

describe("every write able to change public content moves the change counter", () => {
  for (const [name, write, setup] of writes) {
    test(name, async () => {
      const w = await world();
      await setup?.(w);
      const before = await w.s.storage.changeCounter();
      const result = await write(w);
      expect(result.ok).toBe(true);
      expect(await w.s.storage.changeCounter()).toBeGreaterThan(before);
    });
  }

  test("a webhook channel's create and delete move nothing: no status page shows a channel but email's", async () => {
    const w = await world();
    const before = await w.s.storage.changeCounter();
    const created = await createChannel(w.s.storage, w.key, {
      appliesToNew: false,
      name: "ops",
      type: "webhook",
      values: { url: "https://hooks.example.test/ops" },
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    await deleteChannel(w.s.storage, created.channel.id);
    expect(await w.s.storage.changeCounter()).toBe(before);
  });

  test("a refused write moves nothing", async () => {
    const w = await world();
    const before = await w.s.storage.changeCounter();
    expect(
      (
        await createPage(w.s.storage, {
          locale: "ar",
          slug: "main",
          title: "x",
        })
      ).ok
    ).toBe(false);
    expect((await deleteComponent(w.s.storage, "nope")).ok).toBe(false);
    expect(await w.s.storage.changeCounter()).toBe(before);
  });
});

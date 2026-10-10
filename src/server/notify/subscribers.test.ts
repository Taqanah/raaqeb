import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { createComponent } from "@/server/pages/components.ts";
import {
  d0,
  day,
  hour,
  minute,
  type PagesScratch,
  scratchPages,
  testAddress,
} from "@/server/pages/fixture.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import { loadCatalog } from "@/server/settings/language.ts";
import type { StoredSubscription } from "@/server/storage/subscriptions.ts";
import { formatDateTimeWithZone } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import type {
  IncidentCreateInput,
  IncidentUpdateInput,
} from "@/shared/schemas/incident.ts";
import {
  defaultCustomization,
  type PageInput,
  type SubscriptionChannel,
} from "@/shared/schemas/page.ts";
import {
  confirmationWebhookSchema,
  type SubscriberNotification,
  type SubscriberPayload,
  type SubscriptionStatus,
  subscriberPayloadSchema,
  subscriberWebhookSchema,
} from "@/shared/schemas/subscription.ts";
import type { DeliverIo } from "./channel.ts";
import type { HostLookup } from "./destination.ts";
import {
  bodyText,
  decodeWords,
  type FakeSmtp,
  fakeSmtp,
  htmlLinks,
  htmlText,
  parse,
} from "./fixture.ts";
import {
  createSubscriberNotifications,
  sendToSubscriber,
  subscriberMail,
  subscriberPayloads,
  subscriberWebhookBody,
  subscriptionLinks,
} from "./subscribers.ts";

const key = await scratchInstallKey();

/** The webhook URLs the subscribers here are given. */
const sealedHook = /^https:\/\/hooks\.example\.com\/\d+\?key=secret-\d+$/;

const byText = (a: string, b: string) => a.localeCompare(b);

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const now = d0 + 10 * day + 12 * hour;
const author = "owner@example.com";
const iso = (ms: number) => new Date(ms).toISOString();
const time = {
  calendar: "gregorian" as const,
  clock: "24h" as const,
  timeZone: "Asia/Riyadh",
};

/** The value, or a failed test when there is none. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

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
  fields: {
    readonly customDomain?: string;
    readonly layout: PageInput["layout"];
    readonly locale: Locale;
    readonly slug: string;
    readonly title: string;
  }
): Promise<string> {
  const created = await createPage(s.storage, {
    locale: fields.locale,
    slug: fields.slug,
    title: fields.title,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const saved = await savePage(s.storage, created.page.id, {
    customDomain: fields.customDomain,
    customization: defaultCustomization,
    isDefault: created.page.isDefault,
    published: true,
    layout: fields.layout,
    locale: fields.locale,
    slug: fields.slug,
    title: { [fields.locale]: fields.title },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return created.page.id;
}

/** Takes the page off the public, its fields and layout kept. */
async function unpublish(s: PagesScratch, pageId: string): Promise<void> {
  const stored = defined(await s.storage.pages.find(pageId));
  await s.storage.pages.save(
    pageId,
    { ...stored, published: false },
    await s.storage.pages.layout(pageId)
  );
}

let addresses = 0;

/** A subscription of the page in the state asked for, its webhook URL sealed as the module seals it. */
async function subscriber(
  s: PagesScratch,
  pageId: string,
  channel: SubscriptionChannel,
  status: SubscriptionStatus,
  locale: Locale = "ar"
): Promise<StoredSubscription> {
  addresses += 1;
  const url = `https://hooks.example.com/${addresses}?key=secret-${addresses}`;
  const stored = defined(
    await s.storage.subscriptions.request({
      address:
        channel === "email"
          ? `reader${addresses}@example.test`
          : `hash-${addresses}`,
      channel,
      credentials: channel === "webhook" ? await encrypt(key, url) : undefined,
      locale,
      pageId,
      quietSince: now - 1,
      requestedAt: now,
    })
  );
  if (status !== "pending") {
    await s.storage.subscriptions.confirm(stored.token, now, now - 1);
  }
  if (status === "unsubscribed") {
    await s.storage.subscriptions.unsubscribe(stored.token);
  }
  return defined(await s.storage.subscriptions.find(stored.id));
}

/**
 * The default page "حالة المتجر" in Arabic shows the site and payments; the
 * English page "API status" at /status/api shows payments; the page on its
 * own domain shows a third component. Each page has subscribers in every
 * state.
 */
async function world() {
  scratch = await scratchPages(d0);
  const s = scratch;
  s.at(now);
  const web = await component(s, "الموقع");
  const pay = await component(s, "الدفع");
  const far = await component(s, "البعيد");
  const main = await page(s, {
    layout: [
      { componentId: web, kind: "component" },
      { componentId: pay, kind: "component" },
    ],
    locale: "ar",
    slug: "main",
    title: "حالة المتجر",
  });
  const api = await page(s, {
    layout: [{ componentId: pay, kind: "component" }],
    locale: "en",
    slug: "api",
    title: "API status",
  });
  const domain = await page(s, {
    customDomain: "status.far.example",
    layout: [{ componentId: far, kind: "component" }],
    locale: "ar",
    slug: "far",
    title: "البعيد",
  });
  return { api, domain, far, main, pay, s, web };
}

async function incident(
  s: PagesScratch,
  input: Omit<IncidentCreateInput, "message" | "stage">,
  at: number
) {
  s.at(at);
  const created = await createIncident(
    s.storage,
    { ...input, message: { ar: "نحقق في بطء الدفع." }, stage: "investigating" },
    author
  );
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.incident;
}

async function update(
  s: PagesScratch,
  incidentId: string,
  at: number,
  input: IncidentUpdateInput
) {
  s.at(at);
  const posted = await postUpdate(s.storage, incidentId, input, author);
  if (!posted.ok) {
    throw new Error(posted.reason);
  }
  return posted.incident;
}

async function window(s: PagesScratch, componentIds: string[], start: number) {
  const created = await createWindow(
    s.storage,
    {
      componentIds,
      endsAt: start + hour,
      message: { ar: "ننقل قاعدة البيانات." },
      startsAt: start,
      title: { ar: "ترقية قاعدة البيانات" },
    },
    now
  );
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.window;
}

/** A queue that records what is handed to it. */
function recordingQueue() {
  const queued: {
    ids: string[];
    now: number;
    payload: SubscriberPayload;
  }[] = [];
  return {
    queue: {
      enqueueSubscribers: (
        ids: readonly string[],
        payload: SubscriberPayload,
        at: number
      ) => {
        queued.push({ ids: [...ids], now: at, payload });
        return Promise.resolve();
      },
    },
    queued,
  };
}

describe("an event as each page it reaches stores it", () => {
  test("an incident reaches every page that shows a component it affects, as far as each page's components reach, in Statuspage's shape", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [
          { componentId: w.web, status: "partial_outage" },
          { componentId: w.pay, status: "major_outage" },
        ],
        title: { ar: "بطء الدفع" },
      },
      now
    );
    const payloads = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.published",
    });
    expect(payloads.map((each) => each.pageId).toSorted(byText)).toEqual(
      [w.main, w.api].toSorted(byText)
    );
    const main = defined(payloads.find((each) => each.pageId === w.main));
    expect(subscriberPayloadSchema.parse(main.payload)).toEqual(main.payload);
    expect(main.payload).toMatchObject({
      incident: {
        id: created.id,
        impact: "major",
        name: "بطء الدفع",
        resolved_at: null,
        shortlink: `${testAddress}/incidents/${created.id}`,
        status: "investigating",
      },
      page: {
        id: w.main,
        name: "حالة المتجر",
        status_indicator: "critical",
        url: testAddress,
      },
      timestamp: iso(now),
      type: "incident.published",
    });
    if (main.payload.type !== "incident.published") {
      throw new Error("expected an incident");
    }
    expect(main.payload.incident.components.map((each) => each.id)).toEqual([
      w.web,
      w.pay,
    ]);
    expect(
      main.payload.incident.incident_updates.map((each) => each.body)
    ).toEqual(["نحقق في بطء الدفع."]);
    const api = defined(payloads.find((each) => each.pageId === w.api));
    expect(api.payload).toMatchObject({
      incident: {
        shortlink: `${testAddress}/status/api/incidents/${created.id}`,
      },
      page: { name: "API status", url: `${testAddress}/status/api` },
    });
    if (api.payload.type !== "incident.published") {
      throw new Error("expected an incident");
    }
    expect(api.payload.incident.components.map((each) => each.id)).toEqual([
      w.pay,
    ]);
  });

  test("an update's event is stamped with the update's time, and a resolving one carries the resolve time and stage", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "minor",
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
        title: { ar: "بطء الدفع" },
      },
      now
    );
    const identified = await update(w.s, created.id, now + minute, {
      message: { ar: "عرفنا السبب." },
      stage: "identified",
      statuses: [{ componentId: w.pay, status: "degraded_performance" }],
    });
    const [updated] = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.updated",
    });
    expect(updated?.payload).toMatchObject({
      incident: { resolved_at: null, status: "identified" },
      timestamp: iso(defined(identified.updates.at(-1)).createdAt),
      type: "incident.updated",
    });
    const resolved = await update(w.s, created.id, now + hour, {
      keep: false,
      message: { ar: "حُلّت." },
      stage: "resolved",
    });
    const [last] = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.updated",
    });
    expect(last?.payload).toMatchObject({
      incident: {
        resolved_at: iso(defined(resolved.resolvedAt)),
        status: "resolved",
      },
      type: "incident.updated",
    });
  });

  test("incident published tells each component's status before the incident as its old_status, not operational", async () => {
    const w = await world();
    const pay = defined(await w.s.storage.components.find(w.pay));
    await w.s.storage.components.update(w.pay, {
      ...pay,
      status: "degraded_performance",
    });
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.pay, status: "major_outage" }],
        title: { ar: "توقف الدفع" },
      },
      now
    );
    const [published] = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.published",
    });
    const { payload } = defined(published);
    expect(
      "incident" in payload
        ? payload.incident.incident_updates[0]?.affected_components
        : []
    ).toEqual([
      {
        code: w.pay,
        name: "الدفع",
        new_status: "major_outage",
        old_status: "degraded_performance",
      },
    ]);
  });

  test("incident published is stamped with the incident's first update even when a later one landed before it was read", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "minor",
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
        title: { ar: "بطء الدفع" },
      },
      now
    );
    await update(w.s, created.id, now + minute, {
      message: { ar: "عرفنا السبب." },
      stage: "identified",
      statuses: [{ componentId: w.pay, status: "degraded_performance" }],
    });
    const [published] = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.published",
    });
    expect(published?.payload.timestamp).toBe(iso(now));
  });

  test("a maintenance window reaches the pages of its components at each stage, as an incident with impact maintenance", async () => {
    const w = await world();
    const start = now + day;
    const created = await window(w.s, [w.pay], start);
    const scheduled = await subscriberPayloads(w.s.storage, {
      type: "maintenance.scheduled",
      windowId: created.id,
    });
    expect(scheduled.map((each) => each.pageId).toSorted(byText)).toEqual(
      [w.main, w.api].toSorted(byText)
    );
    expect(scheduled[0]?.payload).toMatchObject({
      incident: {
        id: created.id,
        impact: "maintenance",
        resolved_at: null,
        scheduled_for: iso(start),
        scheduled_until: iso(start + hour),
        status: "scheduled",
      },
      timestamp: iso(created.createdAt),
      type: "maintenance.scheduled",
    });
    w.s.at(start);
    await w.s.storage.maintenance.advance(start);
    const [started] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.started",
      windowId: created.id,
    });
    expect(started?.payload).toMatchObject({
      incident: { status: "in_progress" },
      timestamp: iso(start),
      type: "maintenance.started",
    });
    w.s.at(start + hour);
    await w.s.storage.maintenance.advance(start + hour);
    const [completed] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.completed",
      windowId: created.id,
    });
    expect(completed?.payload).toMatchObject({
      incident: { resolved_at: iso(start + hour), status: "completed" },
      timestamp: iso(start + hour),
      type: "maintenance.completed",
    });
  });

  test("a window's start lists each affected component the page shows going from its status before to under maintenance, its end the way back, and its scheduling lists none", async () => {
    const w = await world();
    await incident(
      w.s,
      {
        impact: "minor",
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
        title: { ar: "بطء الدفع" },
      },
      now
    );
    const start = now + day;
    const created = await window(w.s, [w.web, w.pay], start);
    /** Each page's updates' affected components for the window's event. */
    const changes = async (
      type:
        | "maintenance.scheduled"
        | "maintenance.started"
        | "maintenance.completed"
    ) => {
      const payloads = await subscriberPayloads(w.s.storage, {
        type,
        windowId: created.id,
      });
      return new Map(
        payloads.map(({ pageId, payload }) => [
          pageId,
          "incident" in payload
            ? payload.incident.incident_updates.map(
                (each) => each.affected_components
              )
            : [],
        ])
      );
    };
    const web = { code: w.web, name: "الموقع" };
    const pay = { code: w.pay, name: "الدفع" };
    const scheduled = await changes("maintenance.scheduled");
    expect(scheduled.get(w.main)).toEqual([[]]);
    expect(scheduled.get(w.api)).toEqual([[]]);
    w.s.at(start);
    await w.s.storage.maintenance.advance(start);
    const started = await changes("maintenance.started");
    expect(started.get(w.main)).toEqual([
      [
        { ...web, new_status: "under_maintenance", old_status: "operational" },
        {
          ...pay,
          new_status: "under_maintenance",
          old_status: "degraded_performance",
        },
      ],
    ]);
    expect(started.get(w.api)).toEqual([
      [
        {
          ...pay,
          new_status: "under_maintenance",
          old_status: "degraded_performance",
        },
      ],
    ]);
    w.s.at(start + hour);
    await w.s.storage.maintenance.advance(start + hour);
    const completed = await changes("maintenance.completed");
    expect(completed.get(w.main)).toEqual([
      [
        { ...web, new_status: "operational", old_status: "under_maintenance" },
        {
          ...pay,
          new_status: "degraded_performance",
          old_status: "under_maintenance",
        },
      ],
    ]);
  });

  test("a rescheduled window carries its new times at its stage, stamped with the edit, in an update of its own that lists no component", async () => {
    const w = await world();
    const start = now + day;
    const created = await window(w.s, [w.pay], start);
    const edited = now + 5 * minute;
    w.s.at(edited);
    await w.s.storage.maintenance.edit(created.id, "scheduled", {
      endsAt: start + 3 * hour,
      message: created.message,
      startsAt: start + hour,
      title: created.title,
    });
    const payloads = await subscriberPayloads(w.s.storage, {
      type: "maintenance.rescheduled",
      windowId: created.id,
    });
    expect(payloads.map((each) => each.pageId).toSorted(byText)).toEqual(
      [w.main, w.api].toSorted(byText)
    );
    const rescheduled = defined(payloads[0]).payload;
    expect(rescheduled).toMatchObject({
      incident: {
        resolved_at: null,
        scheduled_for: iso(start + hour),
        scheduled_until: iso(start + 3 * hour),
        status: "scheduled",
      },
      timestamp: iso(edited),
      type: "maintenance.rescheduled",
    });
    const [scheduled] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.scheduled",
      windowId: created.id,
    });
    const updateOf = (payload: SubscriberPayload | undefined) =>
      payload && "incident" in payload
        ? payload.incident.incident_updates[0]
        : undefined;
    expect(updateOf(rescheduled)).toMatchObject({
      affected_components: [],
      created_at: iso(edited),
      status: "scheduled",
    });
    expect(updateOf(rescheduled)?.id).not.toBe(
      updateOf(scheduled?.payload)?.id
    );
    w.s.at(start + hour);
    await w.s.storage.maintenance.advance(start + hour);
    const extended = start + hour + 10 * minute;
    w.s.at(extended);
    await w.s.storage.maintenance.edit(created.id, "in_progress", {
      endsAt: start + 4 * hour,
      message: created.message,
      title: created.title,
    });
    const [running] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.rescheduled",
      windowId: created.id,
    });
    expect(running?.payload).toMatchObject({
      incident: {
        scheduled_until: iso(start + 4 * hour),
        status: "in_progress",
      },
      timestamp: iso(extended),
    });
    expect(updateOf(running?.payload)?.affected_components).toEqual([]);
  });

  test("a cancelled window reaches the pages of its components after its row is gone, completed and resolved at the cancel, in an update that lists no component", async () => {
    const w = await world();
    const start = now + day;
    const created = await window(w.s, [w.pay], start);
    await w.s.storage.maintenance.remove(created.id);
    const cancelled = now + 5 * minute;
    const payloads = await subscriberPayloads(w.s.storage, {
      at: cancelled,
      type: "maintenance.cancelled",
      window: created,
    });
    expect(payloads.map((each) => each.pageId).toSorted(byText)).toEqual(
      [w.main, w.api].toSorted(byText)
    );
    const { payload } = defined(payloads[0]);
    expect(payload).toMatchObject({
      incident: {
        id: created.id,
        impact: "maintenance",
        resolved_at: iso(cancelled),
        scheduled_for: iso(start),
        scheduled_until: iso(start + hour),
        status: "completed",
      },
      timestamp: iso(cancelled),
      type: "maintenance.cancelled",
    });
    expect(subscriberPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      "incident" in payload ? payload.incident.incident_updates : []
    ).toMatchObject([
      {
        affected_components: [],
        created_at: iso(cancelled),
        status: "completed",
      },
    ]);
  });

  test("on a page's own domain, its addresses hang from that domain", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "none",
        statuses: [{ componentId: w.far, status: "degraded_performance" }],
        title: { ar: "بطء" },
      },
      now
    );
    const [only, ...rest] = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.published",
    });
    expect(rest).toEqual([]);
    expect(only?.payload).toMatchObject({
      incident: {
        shortlink: `https://status.far.example/incidents/${created.id}`,
      },
      page: { id: w.domain, url: "https://status.far.example" },
    });
  });

  test("an incident or window that is gone, or on no page, reaches nothing", async () => {
    const w = await world();
    const loose = await component(w.s, "خارج الصفحات");
    const created = await incident(
      w.s,
      {
        impact: "minor",
        statuses: [{ componentId: loose, status: "partial_outage" }],
        title: { ar: "لا صفحة" },
      },
      now
    );
    for (const event of [
      { incidentId: created.id, type: "incident.published" },
      { incidentId: "gone", type: "incident.updated" },
      { type: "maintenance.started", windowId: "gone" },
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each event is its own case
      expect(await subscriberPayloads(w.s.storage, event)).toEqual([]);
    }
  });
});

describe("announcing an event and confirming a subscription", () => {
  test("an event is queued for every confirmed subscription of each page it reaches, with that page's copy, and never for a pending or unsubscribed one", async () => {
    const w = await world();
    const confirmedMain = await subscriber(w.s, w.main, "email", "confirmed");
    const hookMain = await subscriber(w.s, w.main, "webhook", "confirmed");
    await subscriber(w.s, w.main, "email", "pending");
    await subscriber(w.s, w.main, "webhook", "unsubscribed");
    const confirmedApi = await subscriber(w.s, w.api, "webhook", "confirmed");
    await subscriber(w.s, w.domain, "email", "confirmed");
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.pay, status: "major_outage" }],
        title: { ar: "توقف الدفع" },
      },
      now
    );
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.announce(
      { incidentId: created.id, type: "incident.published" },
      now + 5
    );
    const byPage = new Map(
      queued.map((each) => [
        each.payload.type === "subscription.confirmation"
          ? ""
          : each.payload.page.id,
        each,
      ])
    );
    expect(queued).toHaveLength(2);
    expect(byPage.get(w.main)?.ids.toSorted(byText)).toEqual(
      [confirmedMain.id, hookMain.id].toSorted(byText)
    );
    expect(byPage.get(w.api)?.ids).toEqual([confirmedApi.id]);
    expect(byPage.get(w.main)?.now).toBe(now + 5);
  });

  test("an unpublished page's subscribers are queued nothing, while the published pages the event reaches are", async () => {
    const w = await world();
    await subscriber(w.s, w.main, "email", "confirmed");
    const confirmedApi = await subscriber(w.s, w.api, "webhook", "confirmed");
    await unpublish(w.s, w.main);
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.pay, status: "major_outage" }],
        title: { ar: "توقف الدفع" },
      },
      now
    );
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.announce(
      { incidentId: created.id, type: "incident.published" },
      now + 5
    );
    expect(queued.map((each) => each.ids)).toEqual([[confirmedApi.id]]);
  });

  test("a cancel is queued for the confirmed subscribers of the published pages the window reached, after its row is gone", async () => {
    const w = await world();
    await subscriber(w.s, w.main, "email", "confirmed");
    const confirmedApi = await subscriber(w.s, w.api, "webhook", "confirmed");
    await unpublish(w.s, w.main);
    const created = await window(w.s, [w.pay], now + day);
    await w.s.storage.maintenance.remove(created.id);
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.announce(
      { at: now + 5, type: "maintenance.cancelled", window: created },
      now + 5
    );
    expect(queued.map((each) => [each.ids, each.payload.type])).toEqual([
      [[confirmedApi.id], "maintenance.cancelled"],
    ]);
  });

  test("an update that adds a component another page shows reaches that page's subscribers too", async () => {
    const w = await world();
    const far = await subscriber(w.s, w.domain, "email", "confirmed");
    const created = await incident(
      w.s,
      {
        impact: "minor",
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
        title: { ar: "بطء الدفع" },
      },
      now
    );
    await update(w.s, created.id, now + minute, {
      message: { ar: "امتد البطء." },
      stage: "identified",
      statuses: [
        { componentId: w.pay, status: "degraded_performance" },
        { componentId: w.far, status: "partial_outage" },
      ],
    });
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.announce(
      { incidentId: created.id, type: "incident.updated" },
      now + minute
    );
    expect(queued.flatMap((each) => each.ids)).toContain(far.id);
  });

  test("an event that reaches no confirmed subscriber queues nothing", async () => {
    const w = await world();
    await subscriber(w.s, w.main, "email", "pending");
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.web, status: "major_outage" }],
        title: { ar: "توقف الموقع" },
      },
      now
    );
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.announce(
      { incidentId: created.id, type: "incident.published" },
      now
    );
    expect(queued).toEqual([]);
  });

  test("announcing never throws: a database that fails is a log line, and after stop nothing is queued", async () => {
    const w = await world();
    await subscriber(w.s, w.main, "email", "confirmed");
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.web, status: "major_outage" }],
        title: { ar: "توقف الموقع" },
      },
      now
    );
    const { queue, queued } = recordingQueue();
    const failing = createSubscriberNotifications(
      {
        ...w.s.storage,
        incidents: {
          ...w.s.storage.incidents,
          find: () => Promise.reject(new Error("the database is gone")),
        },
      },
      queue,
      { isStopped: () => false }
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await failing.announce(
        { incidentId: created.id, type: "incident.published" },
        now
      );
      expect(String(stderr.mock.calls[0]?.[0])).toContain(created.id);
    } finally {
      stderr.mockRestore();
    }
    const stopped = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => true,
    });
    await stopped.announce(
      { incidentId: created.id, type: "incident.published" },
      now
    );
    expect(queued).toEqual([]);
  });

  test("a pending subscription's confirmation names its page and when the visitor asked; a confirmed or unknown one gets none", async () => {
    const w = await world();
    const pending = await subscriber(w.s, w.api, "webhook", "pending");
    const confirmed = await subscriber(w.s, w.api, "email", "confirmed");
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    expect(await subscribers.confirm(pending.id, now + 3)).toBe(true);
    expect(queued).toEqual([
      {
        ids: [pending.id],
        now: now + 3,
        payload: {
          page: {
            id: w.api,
            name: "API status",
            // An Arabic subscription of an English page is sent the Arabic view's address.
            url: `${testAddress}/ar/status/api`,
          },
          timestamp: iso(pending.requestedAt),
          type: "subscription.confirmation",
        },
      },
    ]);
    expect(await subscribers.confirm(confirmed.id, now)).toBe(false);
    expect(await subscribers.confirm("unknown", now)).toBe(false);
    expect(queued).toHaveLength(1);
  });
});

describe("a subscription's addresses", () => {
  test("hang from the origin of its page's plain address", () => {
    expect(
      subscriptionLinks("https://status.example.test/status/api", "tok")
    ).toEqual({
      page: "https://status.example.test/subscriptions/tok",
      unsubscribe: "https://status.example.test/subscriptions/tok/unsubscribe",
    });
    expect(subscriptionLinks("https://status.far.example", "tok")).toEqual({
      page: "https://status.far.example/subscriptions/tok",
      unsubscribe: "https://status.far.example/subscriptions/tok/unsubscribe",
    });
  });

  test("are paths when the page's address is a path", () => {
    expect(subscriptionLinks("/status/api", "tok")).toEqual({
      page: "/subscriptions/tok",
      unsubscribe: "/subscriptions/tok/unsubscribe",
    });
  });
});

/** A subscription's addresses, as `subscriptionLinks` makes them for the token "tok". */
const links = {
  page: `${testAddress}/subscriptions/tok`,
  unsubscribe: `${testAddress}/subscriptions/tok/unsubscribe`,
};

/** Every line of a text, trimmed at its end. */
const linesOf = (text: string) =>
  text.split("\n").map((line) => line.trimEnd());

describe("a subscriber's email", () => {
  test("an incident's email leads with its impact, then its stage and the update's text, the components, the incident's link and the subscription's page, in the subscription language", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.pay, status: "major_outage" }],
        title: { ar: "Payments down" },
      },
      now
    );
    const payloads = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.published",
    });
    const api = defined(payloads.find((each) => each.pageId === w.api));
    const en = createMessages("en", await loadCatalog("en"));
    const mail = await subscriberMail(api.payload, "en", time, links);
    expect(mail.subject).toContain(en._("incident_impact_major"));
    expect(mail.subject).toContain("Payments down");
    expect(mail.subject.indexOf(en._("incident_impact_major"))).toBe(0);
    expect(mail.text).toContain("نحقق في بطء الدفع.");
    expect(mail.text).toContain(en._("incident_stage_investigating"));
    expect(mail.text).toContain("الدفع");
    const lines = linesOf(mail.text);
    expect(
      lines.some((line) =>
        line.endsWith(`${testAddress}/status/api/incidents/${created.id}`)
      )
    ).toBe(true);
    expect(lines.some((line) => line.endsWith(links.page))).toBe(true);
    // A machine token is never mid-sentence: each link ends its line.
    for (const line of lines) {
      const at = line.indexOf("https://");
      if (at !== -1) {
        expect(line.slice(at)).not.toContain(" ");
      }
    }
    const ar = await subscriberMail(api.payload, "ar", time, links);
    const arabic = createMessages("ar", await loadCatalog("ar"));
    expect(ar.subject.indexOf(arabic._("incident_impact_major"))).toBe(0);
  });

  test("a resolving update's email says the incident is resolved, which another update's does not", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "minor",
        statuses: [{ componentId: w.pay, status: "degraded_performance" }],
        title: { ar: "Slow payments" },
      },
      now
    );
    const updatedMail = async () => {
      const [only] = (
        await subscriberPayloads(w.s.storage, {
          incidentId: created.id,
          type: "incident.updated",
        })
      ).filter((each) => each.pageId === w.api);
      return await subscriberMail(defined(only).payload, "en", time, links);
    };
    const en = createMessages("en", await loadCatalog("en"));
    const resolvedSentence = en._("subscription_text_resolved", {
      page: "API status",
    });
    expect((await updatedMail()).text).not.toContain(resolvedSentence);
    await update(w.s, created.id, now + hour, {
      keep: false,
      message: { ar: "Fixed." },
      stage: "resolved",
    });
    expect((await updatedMail()).text).toContain(resolvedSentence);
  });

  test("a window's email gives its start and end on the install's clock with the zone label", async () => {
    const w = await world();
    const start = now + day;
    const created = await window(w.s, [w.web], start);
    const [only] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.scheduled",
      windowId: created.id,
    });
    const mail = await subscriberMail(defined(only).payload, "ar", time, links);
    expect(mail.subject).toContain("ترقية قاعدة البيانات");
    expect(mail.text).toContain(formatDateTimeWithZone("ar", start, time));
    expect(mail.text).toContain(
      formatDateTimeWithZone("ar", start + hour, time)
    );
    expect(mail.text).toContain("ننقل قاعدة البيانات.");
  });

  test("a window's email gives its times in the install's calendar", async () => {
    const w = await world();
    const start = now + day;
    const created = await window(w.s, [w.web], start);
    const [only] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.scheduled",
      windowId: created.id,
    });
    // The install's settings as the sender reads them, calendar and all.
    const install = { ...time, calendar: "hijri" } as const;
    const mail = await subscriberMail(
      defined(only).payload,
      "ar",
      install,
      links
    );
    expect(mail.text).toContain(formatDateTimeWithZone("ar", start, install));
    expect(mail.text).toContain(
      formatDateTimeWithZone("ar", start + hour, install)
    );
    expect(mail.text).toContain("هـ");
  });

  test("a rescheduled window's email says its times changed and gives the new ones; a cancelled one's says it is cancelled, with no stage line", async () => {
    const w = await world();
    const start = now + day;
    const created = await window(w.s, [w.web], start);
    await w.s.storage.maintenance.edit(created.id, "scheduled", {
      endsAt: start + 2 * hour,
      message: created.message,
      startsAt: start,
      title: created.title,
    });
    const [rescheduled] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.rescheduled",
      windowId: created.id,
    });
    const ar = createMessages("ar", await loadCatalog("ar"));
    const moved = await subscriberMail(
      defined(rescheduled).payload,
      "ar",
      time,
      links
    );
    expect(moved.text).toContain(
      ar._("subscription_text_rescheduled", { page: "حالة المتجر" })
    );
    expect(moved.text).toContain(
      formatDateTimeWithZone("ar", start + 2 * hour, time)
    );
    const [cancelled] = await subscriberPayloads(w.s.storage, {
      at: now + minute,
      type: "maintenance.cancelled",
      window: created,
    });
    const gone = await subscriberMail(
      defined(cancelled).payload,
      "ar",
      time,
      links
    );
    expect(gone.subject).toContain("ترقية قاعدة البيانات");
    expect(gone.text).toContain(
      ar._("subscription_text_cancelled", { page: "حالة المتجر" })
    );
    expect(gone.text).not.toContain(
      ar._("subscription_line_stage", {
        value: ar._("maintenance_stage_completed"),
      })
    );
    expect(gone.text).toContain(formatDateTimeWithZone("ar", start, time));
  });

  test("a confirmation's email names the page and gives the link to confirm on a line of its own", async () => {
    const mail = await subscriberMail(
      {
        page: { id: "p", name: "حالة المتجر", url: testAddress },
        timestamp: iso(now),
        type: "subscription.confirmation",
      },
      "ar",
      time,
      links
    );
    expect(mail.subject).toContain("حالة المتجر");
    expect(linesOf(mail.text).some((line) => line.endsWith(links.page))).toBe(
      true
    );
  });

  test("an event's plain-text part ends with why it came, then the unsubscribe line", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.pay, status: "major_outage" }],
        title: { ar: "Payments down" },
      },
      now
    );
    const [api] = (
      await subscriberPayloads(w.s.storage, {
        incidentId: created.id,
        type: "incident.published",
      })
    ).filter((each) => each.pageId === w.api);
    const mail = await subscriberMail(defined(api).payload, "en", time, links);
    const en = createMessages("en", await loadCatalog("en"));
    expect(linesOf(mail.text.trimEnd()).slice(-3)).toEqual([
      "",
      en._("subscription_footer", { page: "API status" }),
      en._("subscription_line_unsubscribe", { value: links.page }),
    ]);
  });

  test("an event's HTML part names the page in its sentence, with the incident's title as its heading, the update's own words, the lines as the plain-text part writes them, Details as a button and the unsubscribe words in its footer", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.pay, status: "major_outage" }],
        title: { ar: "Payments down" },
      },
      now
    );
    const [api] = (
      await subscriberPayloads(w.s.storage, {
        incidentId: created.id,
        type: "incident.published",
      })
    ).filter((each) => each.pageId === w.api);
    const mail = await subscriberMail(defined(api).payload, "en", time, links);
    const en = createMessages("en", await loadCatalog("en"));
    expect(mail.html).toContain('<html lang="en" dir="ltr">');
    const shown = htmlText(mail.html);
    const shownLines = shown.split("\n");
    expect(shownLines).not.toContain("API status");
    for (const each of [
      "Payments down",
      en._("subscription_text_published", { page: "API status" }),
      "نحقق في بطء الدفع.",
    ]) {
      expect(shownLines).toContain(each);
    }
    const details = en._("subscription_line_link", {
      value: `${testAddress}/status/api/incidents/${created.id}`,
    });
    const unsubscribe = en._("subscription_line_unsubscribe", {
      value: links.page,
    });
    const footer = en._("subscription_footer", { page: "API status" });
    // Every line of the plain-text part shows as written, but the two whose addresses its links open.
    for (const line of linesOf(mail.text)) {
      if (line !== "" && line !== details && line !== unsubscribe) {
        expect(shown).toContain(line);
      }
    }
    expect(htmlLinks(mail.html)).toEqual([
      {
        url: `${testAddress}/status/api/incidents/${created.id}`,
        words: en._("monitor_check_open"),
      },
      { url: links.page, words: en._("public_subscription_unsubscribe") },
    ]);
    expect(shownLines).toContain(
      `${footer} ${en._("public_subscription_unsubscribe")}`
    );
    expect(shown).not.toContain(testAddress);
  });

  test("a window's HTML part gives its start and end as the plain-text part does", async () => {
    const w = await world();
    const start = now + day;
    const created = await window(w.s, [w.web], start);
    const [only] = await subscriberPayloads(w.s.storage, {
      type: "maintenance.scheduled",
      windowId: created.id,
    });
    const mail = await subscriberMail(defined(only).payload, "ar", time, links);
    const ar = createMessages("ar", await loadCatalog("ar"));
    const starts = ar._("subscription_line_starts", {
      value: formatDateTimeWithZone("ar", start, time),
    });
    expect(linesOf(mail.text)).toContain(starts);
    expect(htmlText(mail.html).split("\n")).toContain(starts);
    expect(mail.html).toContain('<html lang="ar" dir="rtl">');
  });

  test("a confirmation's HTML part has the page's name as its heading, confirms from a button with the page's own words, and has no footer, since nothing is subscribed yet", async () => {
    const mail = await subscriberMail(
      {
        page: { id: "p", name: "حالة المتجر", url: testAddress },
        timestamp: iso(now),
        type: "subscription.confirmation",
      },
      "ar",
      time,
      links
    );
    const ar = createMessages("ar", await loadCatalog("ar"));
    expect(htmlLinks(mail.html)).toEqual([
      { url: links.page, words: ar._("public_subscription_confirm") },
    ]);
    const shown = htmlText(mail.html).split("\n");
    expect(shown).toContain("حالة المتجر");
    expect(shown).toContain(ar._("subscription_confirm_sentence"));
    expect(htmlText(mail.html)).not.toContain(
      ar._("subscription_footer", { page: "حالة المتجر" })
    );
  });
});

describe("a subscriber's webhook body", () => {
  test("an event is Statuspage's body: the unsubscribe page, the documentation and the event's name, the page's indicator, and the incident", async () => {
    const w = await world();
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.pay, status: "major_outage" }],
        title: { ar: "توقف الدفع" },
      },
      now
    );
    const [first] = await subscriberPayloads(w.s.storage, {
      incidentId: created.id,
      type: "incident.published",
    });
    const { payload } = defined(first);
    if (payload.type !== "incident.published") {
      throw new Error("expected an incident");
    }
    const body = JSON.parse(
      await subscriberWebhookBody(
        payload,
        links,
        "ar",
        `${testAddress}/api/openapi.json`
      )
    );
    expect(subscriberWebhookSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      incident: payload.incident,
      meta: {
        documentation: `${testAddress}/api/openapi.json`,
        event: "incident.published",
        unsubscribe: links.page,
      },
      page: {
        id: payload.page.id,
        status_description: payload.page.status_description,
        status_indicator: payload.page.status_indicator,
      },
    });
  });

  test("a cancelled window's email link and webhook shortlink name its page, since the window's own view is gone with its row", async () => {
    const w = await world();
    const created = await window(w.s, [w.pay], now + day);
    await w.s.storage.maintenance.remove(created.id);
    const payloads = await subscriberPayloads(w.s.storage, {
      at: now,
      type: "maintenance.cancelled",
      window: created,
    });
    const api = defined(payloads.find((each) => each.pageId === w.api));
    const { payload } = api;
    if (payload.type !== "maintenance.cancelled") {
      throw new Error("expected a cancelled window");
    }
    expect(payload.incident.shortlink).toBe(`${testAddress}/status/api`);
    expect(payload.incident.shortlink).toBe(payload.page.url);
    const body = JSON.parse(
      await subscriberWebhookBody(
        payload,
        links,
        "en",
        `${testAddress}/api/openapi.json`
      )
    );
    expect(body.incident.shortlink).toBe(payload.page.url);
    const mail = await subscriberMail(payload, "en", time, links);
    const en = createMessages("en", await loadCatalog("en"));
    expect(linesOf(mail.text)).toContain(
      en._("subscription_line_link", { value: payload.page.url })
    );
    expect(mail.text).not.toContain(`/maintenance/${created.id}`);
  });

  test("a cancelled window's body names maintenance.cancelled in meta while the window it carries is completed, as Statuspage ends one", async () => {
    const w = await world();
    const created = await window(w.s, [w.pay], now + day);
    await w.s.storage.maintenance.remove(created.id);
    const [first] = await subscriberPayloads(w.s.storage, {
      at: now,
      type: "maintenance.cancelled",
      window: created,
    });
    const body = JSON.parse(
      await subscriberWebhookBody(
        defined(first).payload,
        links,
        "ar",
        `${testAddress}/api/openapi.json`
      )
    );
    expect(subscriberWebhookSchema.parse(body)).toEqual(body);
    expect(body.meta.event).toBe("maintenance.cancelled");
    expect(body.incident).toMatchObject({
      id: created.id,
      impact: "maintenance",
      status: "completed",
    });
  });

  test("a confirmation is Raaqeb's own body, with the link to confirm and a sentence in the subscription language", async () => {
    const payload: SubscriberPayload = {
      page: { id: "p", name: "API status", url: `${testAddress}/status/api` },
      timestamp: iso(now),
      type: "subscription.confirmation",
    };
    const en = JSON.parse(
      await subscriberWebhookBody(payload, links, "en", "")
    );
    expect(confirmationWebhookSchema.parse(en)).toEqual(en);
    expect(en).toMatchObject({
      confirmUrl: links.page,
      page: payload.page,
      timestamp: iso(now),
      type: "subscription.confirmation",
    });
    const ar = JSON.parse(
      await subscriberWebhookBody(payload, links, "ar", "")
    );
    expect(ar.text).not.toBe(en.text);
  });
});

/** A fetch that records each request and answers from the script, 200 by default. */
function receiver(answer: (url: string) => Response = () => new Response("")) {
  const requests: { body: string; headers: Headers; url: string }[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    requests.push({
      body: String(init?.body ?? ""),
      headers: new Headers(init?.headers),
      url,
    });
    return await Promise.resolve(answer(url));
  }) as typeof fetch;
  return { fetch: fetcher, requests };
}

const internet: HostLookup = () => Promise.resolve(["93.184.216.34"]);

function io(fetcher: typeof fetch, lookup: HostLookup = internet): DeliverIo {
  return { fetch: fetcher, lookup, now: () => now };
}

/** A queued subscriber notification for the subscription. */
function queuedFor(
  subscriptionId: string,
  payload: SubscriberPayload
): SubscriberNotification {
  return {
    attempts: 0,
    failure: undefined,
    finishedAt: undefined,
    id: "01999a3c-0000-7000-8000-00000000000a",
    kind: "subscriber",
    nextAttemptAt: now,
    payload,
    queuedAt: now,
    status: "pending",
    subscriptionId,
  };
}

let mailServer: FakeSmtp | undefined;

afterEach(() => {
  mailServer?.stop();
  mailServer = undefined;
});

/** An email channel over the scripted SMTP server, stored as the channels module stores it; the server's messages are what it was sent. */
async function emailChannel(s: PagesScratch): Promise<FakeSmtp> {
  mailServer = fakeSmtp();
  await s.storage.channels.create(
    {
      appliesToNew: false,
      config: {
        from: "حالة المتجر <status@example.test>",
        host: "127.0.0.1",
        port: String(mailServer.port),
        security: "none",
        to: "ops@example.test",
      },
      locale: undefined,
      name: "البريد",
      type: "email",
    },
    undefined
  );
  return mailServer;
}

async function publishedFor(w: Awaited<ReturnType<typeof world>>) {
  const created = await incident(
    w.s,
    {
      impact: "major",
      statuses: [{ componentId: w.pay, status: "major_outage" }],
      title: { ar: "توقف الدفع" },
    },
    now
  );
  const payloads = await subscriberPayloads(w.s.storage, {
    incidentId: created.id,
    type: "incident.published",
  });
  return defined(payloads.find((each) => each.pageId === w.main)).payload;
}

describe("one attempt to a subscriber", () => {
  test("an email goes through the sign-in mail channel to the subscriber alone, with the List-Unsubscribe pair", async () => {
    const w = await world();
    const smtp = await emailChannel(w.s);
    const reader = await subscriber(w.s, w.main, "email", "confirmed", "en");
    const payload = await publishedFor(w);
    const net = receiver();
    const outcome = await sendToSubscriber(
      w.s.storage,
      key,
      io(net.fetch),
      queuedFor(reader.id, payload)
    );
    expect(outcome).toEqual({ ok: true });
    expect(net.requests).toEqual([]);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.commands).toContain(`RCPT TO:<${reader.address}>`);
    expect(
      smtp.commands.filter((each) => each.startsWith("RCPT"))
    ).toHaveLength(1);
    const sent = parse(defined(smtp.messages[0])).headers;
    const readerLinks = subscriptionLinks(testAddress, reader.token);
    expect(decodeWords(sent.from ?? "")).toBe(
      "حالة المتجر <status@example.test>"
    );
    expect(sent["list-unsubscribe"]).toBe(`<${readerLinks.unsubscribe}>`);
    expect(sent["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    const mail = await subscriberMail(
      payload,
      "en",
      {
        calendar: "gregorian",
        clock: "12h",
        timeZone: "UTC",
      },
      readerLinks
    );
    expect(decodeWords(sent.subject ?? "")).toBe(mail.subject);
    const whole = parse(defined(smtp.messages[0]));
    expect(bodyText(whole)).toBe(mail.text);
    expect(bodyText(whole, "text/html")).toBe(mail.html);
  });

  test("with no email channel an email subscriber's attempt fails, so the queue tries it again", async () => {
    const w = await world();
    const reader = await subscriber(w.s, w.main, "email", "confirmed");
    const net = receiver();
    const outcome = await sendToSubscriber(
      w.s.storage,
      key,
      io(net.fetch),
      queuedFor(reader.id, await publishedFor(w))
    );
    expect(outcome).toMatchObject({ ok: false });
    expect(net.requests).toEqual([]);
  });

  test("a webhook gets Statuspage's body at its sealed URL, with webhook-id and webhook-timestamp and no signature", async () => {
    const w = await world();
    const hook = await subscriber(w.s, w.main, "webhook", "confirmed");
    const payload = await publishedFor(w);
    const net = receiver();
    const notification = queuedFor(hook.id, payload);
    const outcome = await sendToSubscriber(
      w.s.storage,
      key,
      io(net.fetch),
      notification
    );
    expect(outcome).toEqual({ ok: true });
    const request = defined(net.requests[0]);
    expect(request.url).toMatch(sealedHook);
    expect(request.headers.get("webhook-id")).toBe(notification.id);
    expect(request.headers.get("webhook-timestamp")).toBe(
      String(Math.floor(now / 1000))
    );
    expect(request.headers.get("webhook-signature")).toBeNull();
    expect(request.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(request.body);
    expect(body.meta.unsubscribe).toBe(
      subscriptionLinks(testAddress, hook.token).page
    );
    expect(body.meta.event).toBe("incident.published");
  });

  test("a pending webhook's confirmation is Raaqeb's own body with its link", async () => {
    const w = await world();
    const hook = await subscriber(w.s, w.api, "webhook", "pending", "en");
    const net = receiver();
    const outcome = await sendToSubscriber(
      w.s.storage,
      key,
      io(net.fetch),
      queuedFor(hook.id, {
        page: {
          id: w.api,
          name: "API status",
          url: `${testAddress}/status/api`,
        },
        timestamp: iso(now),
        type: "subscription.confirmation",
      })
    );
    expect(outcome).toEqual({ ok: true });
    const body = JSON.parse(defined(net.requests[0]).body);
    expect(body.type).toBe("subscription.confirmation");
    expect(body.confirmUrl).toBe(
      subscriptionLinks(testAddress, hook.token).page
    );
  });

  test("a webhook whose host is not on the public internet fails without a POST", async () => {
    const w = await world();
    const hook = await subscriber(w.s, w.main, "webhook", "confirmed");
    const net = receiver();
    const outcome = await sendToSubscriber(
      w.s.storage,
      key,
      io(net.fetch, () => Promise.resolve(["10.0.0.7"])),
      queuedFor(hook.id, await publishedFor(w))
    );
    expect(outcome).toMatchObject({ ok: false });
    expect(net.requests).toEqual([]);
  });

  test("a refused POST fails with the status it saw, and the URL's secret never reaches the recorded text", async () => {
    const w = await world();
    const hook = await subscriber(w.s, w.main, "webhook", "confirmed");
    const net = receiver(
      (url) =>
        new Response(`refused ${url} and ${new URL(url).search}`, {
          status: 500,
        })
    );
    const outcome = await sendToSubscriber(
      w.s.storage,
      key,
      io(net.fetch),
      queuedFor(hook.id, await publishedFor(w))
    );
    if (outcome === "dropped" || outcome.ok) {
      throw new Error("expected a failure");
    }
    expect(outcome.failure.reason).toBe("unexpected_status");
    expect(outcome.failure.error ?? "").not.toContain("secret-");
  });

  test("a subscription that no longer takes the message is dropped without a send: a pending one's event, a confirmed one's confirmation, an unsubscribed or removed one's anything", async () => {
    const w = await world();
    const payload = await publishedFor(w);
    const confirmation: SubscriberPayload = {
      page: { id: w.main, name: "حالة المتجر", url: testAddress },
      timestamp: iso(now),
      type: "subscription.confirmation",
    };
    const pending = await subscriber(w.s, w.main, "webhook", "pending");
    const confirmed = await subscriber(w.s, w.main, "webhook", "confirmed");
    const gone = await subscriber(w.s, w.main, "webhook", "unsubscribed");
    const removed = await subscriber(w.s, w.main, "email", "confirmed");
    await w.s.storage.subscriptions.remove(w.main, removed.id);
    const net = receiver();
    for (const [id, each] of [
      [pending.id, payload],
      [confirmed.id, confirmation],
      [gone.id, payload],
      [gone.id, confirmation],
      [removed.id, payload],
    ] as const) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: each is its own case
        await sendToSubscriber(
          w.s.storage,
          key,
          io(net.fetch),
          queuedFor(id, each)
        )
      ).toBe("dropped");
    }
    expect(net.requests).toEqual([]);
  });

  test("a pending subscription's confirmation is dropped without a send once its page is unpublished, as a retry after a failed first send would be", async () => {
    const w = await world();
    const smtp = await emailChannel(w.s);
    const confirmation: SubscriberPayload = {
      page: { id: w.main, name: "حالة المتجر", url: testAddress },
      timestamp: iso(now),
      type: "subscription.confirmation",
    };
    const reader = await subscriber(w.s, w.main, "email", "pending");
    const hook = await subscriber(w.s, w.main, "webhook", "pending");
    await unpublish(w.s, w.main);
    const net = receiver();
    for (const id of [reader.id, hook.id]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: each is its own case
        await sendToSubscriber(
          w.s.storage,
          key,
          io(net.fetch),
          queuedFor(id, confirmation)
        )
      ).toBe("dropped");
    }
    expect(net.requests).toEqual([]);
    expect(smtp.messages).toEqual([]);
  });

  test("an event queued before its page was unpublished is dropped without a send, by email and webhook alike", async () => {
    const w = await world();
    const smtp = await emailChannel(w.s);
    const payload = await publishedFor(w);
    const reader = await subscriber(w.s, w.main, "email", "confirmed");
    const hook = await subscriber(w.s, w.main, "webhook", "confirmed");
    await unpublish(w.s, w.main);
    const net = receiver();
    for (const id of [reader.id, hook.id]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: each is its own case
        await sendToSubscriber(
          w.s.storage,
          key,
          io(net.fetch),
          queuedFor(id, payload)
        )
      ).toBe("dropped");
    }
    expect(net.requests).toEqual([]);
    expect(smtp.messages).toEqual([]);
  });

  test("a cancelled window's queued notification is sent though its row is gone, since the drop at send time reads the subscription and its page alone", async () => {
    const w = await world();
    const smtp = await emailChannel(w.s);
    const reader = await subscriber(w.s, w.main, "email", "confirmed");
    const hook = await subscriber(w.s, w.main, "webhook", "confirmed");
    const created = await window(w.s, [w.web], now + day);
    await w.s.storage.maintenance.remove(created.id);
    const [cancelled] = await subscriberPayloads(w.s.storage, {
      at: now,
      type: "maintenance.cancelled",
      window: created,
    });
    const net = receiver();
    for (const id of [reader.id, hook.id]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: each is its own case
        await sendToSubscriber(
          w.s.storage,
          key,
          io(net.fetch),
          queuedFor(id, defined(cancelled).payload)
        )
      ).toEqual({ ok: true });
    }
    expect(net.requests).toHaveLength(1);
    expect(smtp.messages).toHaveLength(1);
  });
});

describe("edges of a maintenance window's affected components", () => {
  test("a component another window holds stays under maintenance on both sides of this window's start and end", async () => {
    const w = await world();
    const start = now + day;
    const longer = await createWindow(
      w.s.storage,
      {
        componentIds: [w.pay],
        endsAt: start + 2 * hour,
        message: { ar: "صيانة أطول." },
        startsAt: start,
        title: { ar: "صيانة الدفع" },
      },
      now
    );
    if (!longer.ok) {
      throw new Error(longer.reason);
    }
    const created = await window(w.s, [w.pay], start);
    w.s.at(start);
    await w.s.storage.maintenance.advance(start);
    /** The affected components of the window's one update, on the first page it reaches. */
    const affected = async (
      type: "maintenance.started" | "maintenance.completed"
    ) => {
      const [first] = await subscriberPayloads(w.s.storage, {
        type,
        windowId: created.id,
      });
      return first && "incident" in first.payload
        ? first.payload.incident.incident_updates[0]?.affected_components
        : undefined;
    };
    const held = [
      {
        code: w.pay,
        name: "الدفع",
        new_status: "under_maintenance",
        old_status: "under_maintenance",
      },
    ] as const;
    expect(await affected("maintenance.started")).toEqual([...held]);
    w.s.at(start + hour);
    await w.s.storage.maintenance.advance(start + hour);
    expect(await affected("maintenance.completed")).toEqual([...held]);
  });
});

describe("a subscriber notification's content", () => {
  test("each subscription language gets its own copy of the event, its content in that locale, else the page language's", async () => {
    const w = await world();
    const arabic = await subscriber(w.s, w.main, "email", "confirmed", "ar");
    const english = await subscriber(w.s, w.main, "webhook", "confirmed", "en");
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.web, status: "major_outage" }],
        title: { ar: "توقف الموقع", en: "Website down" },
      },
      now
    );
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.announce(
      { incidentId: created.id, type: "incident.published" },
      now + 5
    );
    const named = queued.map((each) => ({
      ids: each.ids,
      title:
        each.payload.type === "subscription.confirmation"
          ? undefined
          : each.payload.incident.name,
      // The update's text has no English, so the English copy falls back to the page language's.
      update:
        each.payload.type === "subscription.confirmation"
          ? undefined
          : each.payload.incident.incident_updates[0]?.body,
    }));
    expect(named).toEqual([
      { ids: [arabic.id], title: "توقف الموقع", update: "نحقق في بطء الدفع." },
      {
        ids: [english.id],
        title: "Website down",
        update: "نحقق في بطء الدفع.",
      },
    ]);
  });

  test("a confirmation names the page by its title in the subscription language, else the page language's", async () => {
    const w = await world();
    const stored = defined(await w.s.storage.pages.find(w.main));
    await w.s.storage.pages.save(
      w.main,
      { ...stored, title: { ar: "حالة المتجر", en: "Shop status" } },
      await w.s.storage.pages.layout(w.main)
    );
    const english = await subscriber(w.s, w.main, "email", "pending", "en");
    const fallback = await subscriber(w.s, w.api, "email", "pending", "ar");
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.confirm(english.id, now);
    await subscribers.confirm(fallback.id, now);
    expect(queued.map((each) => each.payload.page.name)).toEqual([
      "Shop status",
      "API status",
    ]);
  });
});

describe("a subscriber notification's links", () => {
  test("an English subscription of an Arabic page is sent the English views' addresses: the page, an incident and a window", async () => {
    const w = await world();
    const english = await subscriber(w.s, w.main, "webhook", "confirmed", "en");
    const arabic = await subscriber(w.s, w.main, "email", "confirmed", "ar");
    const created = await incident(
      w.s,
      {
        impact: "major",
        statuses: [{ componentId: w.web, status: "major_outage" }],
        title: { ar: "توقف الموقع" },
      },
      now
    );
    const scheduled = await window(w.s, [w.web], now + day);
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.announce(
      { incidentId: created.id, type: "incident.published" },
      now + 5
    );
    await subscribers.announce(
      { type: "maintenance.scheduled", windowId: scheduled.id },
      now + 6
    );
    const sent = queued.map((each) => ({
      ids: each.ids,
      page: each.payload.page.url,
      shortlink:
        each.payload.type === "subscription.confirmation"
          ? undefined
          : each.payload.incident.shortlink,
    }));
    expect(sent).toEqual([
      {
        ids: [arabic.id],
        page: testAddress,
        shortlink: `${testAddress}/incidents/${created.id}`,
      },
      {
        ids: [english.id],
        page: `${testAddress}/en`,
        shortlink: `${testAddress}/en/incidents/${created.id}`,
      },
      {
        ids: [arabic.id],
        page: testAddress,
        shortlink: `${testAddress}/maintenance/${scheduled.id}`,
      },
      {
        ids: [english.id],
        page: `${testAddress}/en`,
        shortlink: `${testAddress}/en/maintenance/${scheduled.id}`,
      },
    ]);
  });

  test("a cancelled window's link is the page's plain address in the subscription language", async () => {
    const w = await world();
    const created = await window(w.s, [w.web], now + day);
    await w.s.storage.maintenance.remove(created.id);
    const [cancelled] = await subscriberPayloads(
      w.s.storage,
      { at: now, type: "maintenance.cancelled", window: created },
      "en"
    );
    expect(
      cancelled?.payload.type === "subscription.confirmation"
        ? undefined
        : cancelled?.payload.incident.shortlink
    ).toBe(`${testAddress}/en`);
  });

  test("a confirmation names the page's address in the subscription language, on a custom domain too", async () => {
    const w = await world();
    const english = await subscriber(w.s, w.main, "email", "pending", "en");
    const far = await subscriber(w.s, w.domain, "webhook", "pending", "en");
    const { queue, queued } = recordingQueue();
    const subscribers = createSubscriberNotifications(w.s.storage, queue, {
      isStopped: () => false,
    });
    await subscribers.confirm(english.id, now);
    await subscribers.confirm(far.id, now);
    expect(queued.map((each) => each.payload.page.url)).toEqual([
      `${testAddress}/en`,
      "https://status.far.example/en",
    ]);
  });
});

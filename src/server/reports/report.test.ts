import { afterEach, describe, expect, test } from "bun:test";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { readMonitorDays } from "@/server/monitors/days.ts";
import {
  createComponent,
  readComponentDays,
} from "@/server/pages/components.ts";
import {
  checksEvery,
  d0,
  day,
  hour,
  minute,
  type PagesScratch,
  scratchPages,
  site,
} from "@/server/pages/fixture.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import type { Report, ReportQuery } from "@/shared/schemas/report.ts";
import type { RollupSpan } from "@/shared/schemas/rollup.ts";
import { monitorsPerRead, readReport, readReportChoices } from "./report.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** Noon of 6 September: 1 to 5 September are closed days, sealed as the nightly job seals them. */
const now = d0 + 5 * day + 12 * hour;
const lastClosed = d0 + 5 * day;

async function opened(): Promise<PagesScratch> {
  scratch = await scratchPages(d0);
  return scratch;
}

/** A monitor checked every hour from 1 September to `now`, every check up but those in `down` (hour spans from `d0`), its closed days sealed. */
async function monitor(
  s: PagesScratch,
  name: string,
  options: {
    down?: readonly (readonly [number, number])[];
    excluded?: readonly { from: number; to: number }[];
    group?: string;
    result?: "degraded" | "up";
  } = {}
): Promise<Monitor> {
  const created = await s.storage.monitors.create({
    ...site,
    group: options.group,
    intervalMs: hour,
    name,
  });
  const down = options.down ?? [];
  let cursor = d0;
  for (const [from, to] of down) {
    // biome-ignore lint/performance/noAwaitInLoops: one span after another, in time order
    await checksEvery(
      s.storage,
      created,
      cursor,
      d0 + from,
      options.result ?? "up",
      hour
    );
    await checksEvery(s.storage, created, d0 + from, d0 + to, "down", hour);
    cursor = d0 + to;
  }
  await checksEvery(
    s.storage,
    created,
    cursor,
    now,
    options.result ?? "up",
    hour
  );
  for (let at = d0; at < lastClosed; at += day) {
    // biome-ignore lint/performance/noAwaitInLoops: each day is sealed after the one before
    await s.storage.checks.seal(
      created.id,
      at,
      2 * hour,
      options.excluded ?? []
    );
  }
  return created;
}

/** An outage of the monitor from `from` to `to`, hour counts from `d0`; closed unless `to` is none. */
async function outage(
  s: PagesScratch,
  of: Monitor,
  from: number,
  to: number | undefined,
  acknowledgedAt?: number
): Promise<void> {
  await s.storage.outages.open(of.id, d0 + from, reasons.timeout);
  if (acknowledgedAt !== undefined) {
    await s.storage.outages.acknowledge(of.id, d0 + from, d0 + acknowledgedAt);
  }
  if (to !== undefined) {
    await s.storage.outages.close(of.id, d0 + to);
  }
}

function query(
  subject: ReportQuery["subject"],
  id: string,
  over: Partial<ReportQuery> = {}
): ReportQuery {
  return {
    from: "2026-09-01",
    id,
    subject,
    target: 99.9,
    to: "2026-09-03",
    ...over,
  };
}

async function report(s: PagesScratch, asked: ReportQuery): Promise<Report> {
  const result = await readReport(s.storage, asked, now);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.report;
}

async function component(
  s: PagesScratch,
  name: string,
  monitorIds: string[]
): Promise<string> {
  const created = await createComponent(s.storage, {
    description: undefined,
    monitorIds,
    name: { ar: name },
    status: "operational",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.component.id;
}

describe("the report of a monitor", () => {
  test("states uptime over observed time, the downtime in minutes' worth of milliseconds, and the outage's recovery and acknowledge", async () => {
    const s = await opened();
    const alpha = await monitor(s, "alpha", { down: [[26 * hour, 29 * hour]] });
    await outage(s, alpha, 26 * hour, 29 * hour, 26 * hour + 10 * minute);
    const made = await report(s, query("monitor", alpha.id));
    expect(made.subject.figures).toEqual({
      acknowledgeMs: 10 * minute,
      degradedMs: 0,
      downtimeMs: 3 * hour,
      incidents: 0,
      maintenanceMs: 0,
      noDataMs: 0,
      observedMs: 72 * hour,
      outages: 1,
      recoveryMs: 3 * hour,
    });
    // 69 hours of 72.
    expect(made.subject.uptime).toEqual({ decimals: 2, percent: 95.83 });
    expect(made).toMatchObject({
      from: "2026-09-01",
      madeAt: now,
      members: [],
      open: false,
      target: 99.9,
      to: "2026-09-03",
    });
    expect(made.subject).toMatchObject({
      id: alpha.id,
      kind: "monitor",
      name: "alpha",
    });
  });

  test("the error budget is what the target allows of the observed time, and the missed target is negative", async () => {
    const s = await opened();
    const alpha = await monitor(s, "alpha", { down: [[26 * hour, 29 * hour]] });
    await outage(s, alpha, 26 * hour, 29 * hour);
    const { subject } = await report(s, query("monitor", alpha.id));
    // 72 hours at 99.9% allow 259 200 ms.
    expect(subject.budget).toEqual({
      allowedMs: 259_200,
      leftMs: 259_200 - 3 * hour,
      met: false,
      usedRatio: (3 * hour) / 259_200,
    });
    const lenient = await report(s, query("monitor", alpha.id, { target: 90 }));
    expect(lenient.subject.budget?.met).toBe(true);
    expect(lenient.subject.budget?.leftMs).toBe(72 * hour * 0.1 - 3 * hour);
  });

  test("lists the worst outages with the monitor, longest first", async () => {
    const s = await opened();
    const alpha = await monitor(s, "alpha", {
      down: [
        [3 * hour, 4 * hour],
        [30 * hour, 35 * hour],
      ],
    });
    await outage(s, alpha, 3 * hour, 4 * hour);
    await outage(s, alpha, 30 * hour, 35 * hour);
    const { worst } = await report(s, query("monitor", alpha.id));
    expect(worst.map((each) => [each.monitorName, each.downtimeMs])).toEqual([
      ["alpha", 5 * hour],
      ["alpha", hour],
    ]);
    expect(worst[0]).toMatchObject({
      endedAt: d0 + 35 * hour,
      reason: reasons.timeout,
      startedAt: d0 + 30 * hour,
    });
  });

  test("an outage across the range's end counts its time inside the range in this report and the rest in the next, recovered only in the next", async () => {
    const s = await opened();
    const edge = await monitor(s, "edge");
    // 3 September 22:00 to 4 September 02:00.
    await outage(s, edge, 70 * hour, 74 * hour);
    const first = await report(s, query("monitor", edge.id));
    expect(first.subject.figures).toMatchObject({
      downtimeMs: 2 * hour,
      outages: 1,
      recoveryMs: undefined,
    });
    const next = await report(
      s,
      query("monitor", edge.id, { from: "2026-09-04", to: "2026-09-05" })
    );
    expect(next.subject.figures).toMatchObject({
      downtimeMs: 2 * hour,
      outages: 1,
      recoveryMs: 4 * hour,
    });
    expect(first.worst[0]?.downtimeMs).toBe(2 * hour);
  });

  test("maintenance that covered the monitor is shown, and neither observed time nor downtime", async () => {
    const s = await opened();
    const web = await monitor(s, "web", {
      down: [[33 * hour, 37 * hour]],
      excluded: [{ from: d0 + 34 * hour, to: d0 + 36 * hour }],
    });
    await outage(s, web, 33 * hour, 37 * hour);
    const comp = await component(s, "الموقع", [web.id]);
    await s.storage.maintenance.create({
      componentIds: [comp],
      endsAt: d0 + 36 * hour,
      message: { ar: "نص" },
      startsAt: d0 + 34 * hour,
      title: { ar: "صيانة" },
    });
    await s.storage.maintenance.advance(now);
    const { subject, worst } = await report(s, query("monitor", web.id));
    expect(subject.figures).toMatchObject({
      downtimeMs: 2 * hour,
      maintenanceMs: 2 * hour,
      noDataMs: 0,
      observedMs: 70 * hour,
      outages: 1,
    });
    expect(worst[0]?.downtimeMs).toBe(2 * hour);
  });

  test("a day with no checks is time with no data and never downtime", async () => {
    const s = await opened();
    const created = await s.storage.monitors.create({
      ...site,
      intervalMs: hour,
      name: "quiet",
    });
    await checksEvery(s.storage, created, d0, d0 + day, "up", hour);
    await checksEvery(
      s.storage,
      created,
      d0 + 2 * day,
      d0 + 3 * day,
      "up",
      hour
    );
    for (const at of [d0, d0 + day, d0 + 2 * day]) {
      // biome-ignore lint/performance/noAwaitInLoops: each day is sealed after the one before
      await s.storage.checks.seal(created.id, at, 2 * hour, []);
    }
    const { subject } = await report(s, query("monitor", created.id));
    expect(subject.figures.downtimeMs).toBe(0);
    expect(subject.uptime).toEqual({ decimals: 0, percent: 100 });
    expect(subject.figures.noDataMs).toBeGreaterThanOrEqual(20 * hour);
    expect(
      subject.figures.observedMs +
        subject.figures.noDataMs +
        subject.figures.maintenanceMs
    ).toBe(72 * hour);
  });

  test("a range with nothing observed has no uptime and no budget", async () => {
    const s = await opened();
    const fresh = await s.storage.monitors.create({ ...site, name: "fresh" });
    const { subject } = await report(
      s,
      query("monitor", fresh.id, { from: "2026-09-02", to: "2026-09-03" })
    );
    expect(subject.uptime).toBeUndefined();
    expect(subject.budget).toBeUndefined();
    expect(subject.figures.noDataMs).toBe(2 * day);
  });

  test("degraded time is the observed time scaled by the share of degraded checks", async () => {
    const s = await opened();
    const slow = await monitor(s, "slow", { result: "degraded" });
    const { subject } = await report(s, query("monitor", slow.id));
    expect(subject.figures.degradedMs).toBe(72 * hour);
    expect(subject.figures.downtimeMs).toBe(0);
  });

  test("a range reaching today is open, ends at now and reads the day not yet sealed", async () => {
    const s = await opened();
    const alpha = await monitor(s, "alpha", {
      down: [[5 * day + 2 * hour, 5 * day + 4 * hour]],
    });
    await outage(s, alpha, 5 * day + 2 * hour, 5 * day + 4 * hour);
    const made = await report(
      s,
      query("monitor", alpha.id, { from: "2026-09-06", to: "2026-09-30" })
    );
    expect(made.open).toBe(true);
    expect(made.subject.figures).toMatchObject({
      downtimeMs: 2 * hour,
      observedMs: 12 * hour,
      outages: 1,
    });
  });
});

describe("the report of a group, a component and a page", () => {
  test("a group lists each monitor in it, the one with most downtime first, and adds them up", async () => {
    const s = await opened();
    const one = await monitor(s, "one", {
      down: [[26 * hour, 28 * hour]],
      group: "core",
    });
    const two = await monitor(s, "two", { group: "core" });
    const out = await monitor(s, "out", {
      down: [[3 * hour, 9 * hour]],
    });
    await outage(s, one, 26 * hour, 28 * hour);
    await outage(s, out, 3 * hour, 9 * hour);
    const made = await report(s, query("group", "core"));
    expect(made.members.map((each) => each.name)).toEqual(["one", "two"]);
    expect(made.subject).toMatchObject({
      id: "core",
      kind: "group",
      name: "core",
    });
    expect(made.subject.figures).toMatchObject({
      downtimeMs: 2 * hour,
      observedMs: 144 * hour,
      outages: 1,
    });
    expect(made.subject.uptime).toEqual({ decimals: 2, percent: 98.61 });
    expect(made.members[1]?.id).toBe(two.id);
    expect(made.worst.map((each) => each.monitorName)).toEqual(["one"]);
    // The reason's words can depend on the check type, as TLS required's do.
    expect(made.worst.map((each) => each.checkType)).toEqual([one.config.type]);
  });

  test("a component's downtime is its monitors' outages and the time an incident held it down, each moment once", async () => {
    const s = await opened();
    const one = await monitor(s, "one", { down: [[26 * hour, 28 * hour]] });
    const two = await monitor(s, "two");
    await outage(s, one, 26 * hour, 28 * hour);
    const web = await component(s, "الموقع", [one.id, two.id]);
    s.at(d0 + 25 * hour);
    const opening = await createIncident(
      s.storage,
      {
        impact: "major",
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: web, status: "partial_outage" }],
        title: { ar: "عطل" },
      },
      "owner@example.com"
    );
    if (!opening.ok) {
      throw new Error(opening.reason);
    }
    s.at(d0 + 27 * hour);
    await postUpdate(
      s.storage,
      opening.incident.id,
      { keep: false, message: { ar: "حُلّ." }, stage: "resolved" },
      "owner@example.com"
    );
    const made = await report(s, query("component", web));
    // The incident held 01:00 to 03:00 on the 2nd and the outage 02:00 to 04:00: three hours together.
    expect(made.subject.figures).toMatchObject({
      downtimeMs: 3 * hour,
      incidents: 1,
      observedMs: 72 * hour,
      outages: 1,
    });
    expect(made.subject).toMatchObject({
      id: web,
      kind: "component",
      name: { ar: "الموقع" },
    });
    expect(made.members).toEqual([]);
    expect(made.worst.map((each) => each.monitorName)).toEqual(["one"]);
  });

  test("a component's degraded time is its most degraded monitor's, so two degraded monitors are not twice as degraded", async () => {
    const s = await opened();
    const one = await monitor(s, "one", { result: "degraded" });
    const two = await monitor(s, "two", { result: "degraded" });
    const web = await component(s, "الموقع", [one.id, two.id]);
    const made = await report(s, query("component", web));
    expect(made.subject.figures.degradedMs).toBe(72 * hour);
  });

  test("an incident resolved before the range is no incident of it and holds no time in it", async () => {
    const s = await opened();
    const one = await monitor(s, "one");
    const web = await component(s, "الموقع", [one.id]);
    s.at(d0 - 3 * day);
    const opening = await createIncident(
      s.storage,
      {
        impact: "major",
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: web, status: "major_outage" }],
        title: { ar: "قديمة" },
      },
      "owner@example.com"
    );
    if (!opening.ok) {
      throw new Error(opening.reason);
    }
    s.at(d0 - 2 * day);
    await postUpdate(
      s.storage,
      opening.incident.id,
      { keep: false, message: { ar: "حُلّ." }, stage: "resolved" },
      "owner@example.com"
    );
    const made = await report(s, query("component", web));
    expect(made.subject.figures).toMatchObject({
      downtimeMs: 0,
      incidents: 0,
    });
  });

  test("an incident opened after the range ended is no incident of it", async () => {
    const s = await opened();
    const one = await monitor(s, "one");
    const web = await component(s, "الموقع", [one.id]);
    s.at(now - hour);
    const opening = await createIncident(
      s.storage,
      {
        impact: "major",
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: web, status: "major_outage" }],
        title: { ar: "لاحقة" },
      },
      "owner@example.com"
    );
    if (!opening.ok) {
      throw new Error(opening.reason);
    }
    const made = await report(s, query("component", web));
    expect(made.subject.figures).toMatchObject({
      downtimeMs: 0,
      incidents: 0,
    });
  });

  test("a page lists the components it shows and adds them up", async () => {
    const s = await opened();
    const one = await monitor(s, "one", { down: [[26 * hour, 28 * hour]] });
    const two = await monitor(s, "two");
    await outage(s, one, 26 * hour, 28 * hour);
    const web = await component(s, "الموقع", [one.id]);
    const api = await component(s, "الواجهة", [two.id]);
    const created = await createPage(s.storage, {
      locale: "ar",
      slug: "main",
      title: "حالة المتجر",
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    await savePage(s.storage, created.page.id, {
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: created.page.isDefault,
      layout: [
        { componentId: web, kind: "component" },
        { componentId: api, kind: "component" },
      ],
      locale: "ar",
      published: true,
      slug: "main",
      title: { ar: "حالة المتجر" },
    });
    const made = await report(s, query("page", created.page.id));
    expect(made.members.map((each) => each.name)).toEqual([
      { ar: "الموقع" },
      { ar: "الواجهة" },
    ]);
    expect(made.subject.figures).toMatchObject({
      downtimeMs: 2 * hour,
      observedMs: 144 * hour,
    });
    expect(made.subject.name).toEqual({ ar: "حالة المتجر" });
  });

  test("a subject that does not exist, or a group with no monitor, is not found", async () => {
    const s = await opened();
    for (const [kind, id] of [
      ["monitor", "nope"],
      ["component", "nope"],
      ["page", "nope"],
      ["group", "nope"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: four reads, one result each
      const result = await readReport(s.storage, query(kind, id), now);
      expect(result).toEqual({ ok: false, reason: "not_found" });
    }
  });

  test("a range that is not one, or a target that does not fit, is invalid", async () => {
    const s = await opened();
    const alpha = await monitor(s, "alpha");
    expect(
      await readReport(
        s.storage,
        query("monitor", alpha.id, { from: "2026-09-04", to: "2026-09-01" }),
        now
      )
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await readReport(
        s.storage,
        query("monitor", alpha.id, { target: 100 }),
        now
      )
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("how much a report reads at once", () => {
  test("no read names more monitors than the batch, however many a group holds", async () => {
    const s = await opened();
    const created: Monitor[] = [];
    for (let index = 0; index < monitorsPerRead * 2 + 3; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one after another, since two creations at once collide on Postgres
      const made = await s.storage.monitors.create({
        ...site,
        group: "big",
        name: `m${index}`,
      });
      created.push(made);
    }
    const widest = { n: 0 };
    const spy = {
      ...s.storage,
      checks: {
        ...s.storage.checks,
        rollupsOf: (
          ids: readonly string[],
          span: RollupSpan,
          from: number,
          to: number
        ) => {
          widest.n = Math.max(widest.n, ids.length);
          return s.storage.checks.rollupsOf(ids, span, from, to);
        },
      },
    };
    const result = await readReport(spy, query("group", "big"), now);
    expect(result.ok).toBe(true);
    expect(widest.n).toBeGreaterThan(0);
    expect(widest.n).toBeLessThanOrEqual(monitorsPerRead);
    if (result.ok) {
      expect(result.report.members).toHaveLength(created.length);
    }
  });
});

/** A group of `count` monitors with no checks, created one after another since two creations at once collide on Postgres. */
async function bare(
  s: PagesScratch,
  count: number,
  group: string
): Promise<Monitor[]> {
  const made: Monitor[] = [];
  for (let index = 0; index < count; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one after another, as above
    const created = await s.storage.monitors.create({
      ...site,
      group,
      name: `${group}${index}`,
    });
    made.push(created);
  }
  return made;
}

/** The storage with every `rollupsOf` read named: how many monitors each names. */
function spied(s: PagesScratch, sizes: number[]): ReportStorageLike {
  return {
    ...s.storage,
    checks: {
      ...s.storage.checks,
      rollupsOf: (
        ids: readonly string[],
        span: RollupSpan,
        from: number,
        to: number
      ) => {
        sizes.push(ids.length);
        return s.storage.checks.rollupsOf(ids, span, from, to);
      },
    },
  };
}

type ReportStorageLike = Parameters<typeof readReport>[0];

describe("how much a component's report reads at once", () => {
  test("a component of many monitors is read eight at a time too, and its figures are the same as if read at once", async () => {
    const s = await opened();
    const first = await monitor(s, "first", { down: [[26 * hour, 28 * hour]] });
    await outage(s, first, 26 * hour, 28 * hour);
    const many = [first, ...(await bare(s, monitorsPerRead * 2 + 3, "many"))];
    const web = await component(
      s,
      "الموقع",
      many.map((each) => each.id)
    );
    const sizes: number[] = [];
    const result = await readReport(
      spied(s, sizes),
      query("component", web),
      now
    );
    expect(result.ok).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(monitorsPerRead);
    // Every monitor read once, in ceil(n / 8) reads.
    expect(sizes.reduce((sum, each) => sum + each, 0)).toBe(many.length);
    expect(sizes).toHaveLength(Math.ceil(many.length / monitorsPerRead));
    if (result.ok) {
      expect(result.report.subject.figures).toMatchObject({
        downtimeMs: 2 * hour,
        outages: 1,
      });
    }
  });
});

describe("what a page's total counts", () => {
  test("a monitor two of its components share is counted once: its outage is two hours, not four", async () => {
    const s = await opened();
    const shared = await monitor(s, "shared", {
      down: [[26 * hour, 28 * hour]],
    });
    await outage(s, shared, 26 * hour, 28 * hour);
    const first = await component(s, "الأول", [shared.id]);
    const second = await component(s, "الثاني", [shared.id]);
    const created = await createPage(s.storage, {
      locale: "ar",
      slug: "twice",
      title: "مرتان",
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    await savePage(s.storage, created.page.id, {
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: created.page.isDefault,
      layout: [
        { componentId: first, kind: "component" },
        { componentId: second, kind: "component" },
      ],
      locale: "ar",
      published: true,
      slug: "twice",
      title: { ar: "مرتان" },
    });
    const made = await report(s, query("page", created.page.id));
    // Each component's own line is its own.
    expect(made.members.map((each) => each.figures.downtimeMs)).toEqual([
      2 * hour,
      2 * hour,
    ]);
    expect(made.subject.figures).toMatchObject({
      downtimeMs: 2 * hour,
      observedMs: 72 * hour,
      outages: 1,
    });
  });
});

describe("what a page's total counts of incidents", () => {
  test("only the incidents on the components the page shows, not those on another component its monitors are linked to", async () => {
    const s = await opened();
    const one = await monitor(s, "one");
    const shown = await component(s, "المعروض", [one.id]);
    const hidden = await component(s, "المخفي", [one.id]);
    const created = await createPage(s.storage, {
      locale: "ar",
      slug: "shown",
      title: "معروضة",
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    await savePage(s.storage, created.page.id, {
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: created.page.isDefault,
      layout: [{ componentId: shown, kind: "component" }],
      locale: "ar",
      published: true,
      slug: "shown",
      title: { ar: "معروضة" },
    });
    s.at(d0 + 25 * hour);
    const opening = await createIncident(
      s.storage,
      {
        impact: "minor",
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: hidden, status: "degraded_performance" }],
        title: { ar: "على المخفي" },
      },
      "owner@example.com"
    );
    if (!opening.ok) {
      throw new Error(opening.reason);
    }
    const made = await report(s, query("page", created.page.id));
    expect(made.subject.figures.incidents).toBe(0);
  });
});

describe("a report's range as it is printed", () => {
  test("a last day after today is cut to today, the day the figures stop at", async () => {
    const s = await opened();
    const alpha = await monitor(s, "alpha");
    const made = await report(
      s,
      query("monitor", alpha.id, { from: "2026-09-01", to: "2026-09-30" })
    );
    expect(made.open).toBe(true);
    expect(made.to).toBe("2026-09-06");
  });
});

describe("a report's outages and the observed time", () => {
  test("an outage that stays open after the checks stopped counts the observed time only, in the list as in the subject's downtime", async () => {
    const s = await opened();
    const stops = await s.storage.monitors.create({
      ...site,
      intervalMs: hour,
      name: "stops",
    });
    await checksEvery(s.storage, stops, d0, d0 + day + 2 * hour, "up", hour);
    await checksEvery(
      s.storage,
      stops,
      d0 + day + 2 * hour,
      d0 + day + 6 * hour,
      "down",
      hour
    );
    for (const at of [d0, d0 + day]) {
      // biome-ignore lint/performance/noAwaitInLoops: each day is sealed after the one before
      await s.storage.checks.seal(stops.id, at, 2 * hour, []);
    }
    await outage(s, stops, 24 * hour + 2 * hour, undefined);
    const made = await report(s, query("monitor", stops.id));
    expect(made.subject.figures.downtimeMs).toBeLessThanOrEqual(
      made.subject.figures.observedMs
    );
    expect(made.worst).toHaveLength(1);
    expect(made.worst[0]?.downtimeMs).toBe(made.subject.figures.downtimeMs);
    expect(made.worst[0]?.downtimeMs).toBeLessThan(46 * hour);
  });
});

describe("a report and the status page's bars", () => {
  test("over a past range with maintenance and an outage across its end, a component's and a monitor's figures are the sums of their bar days", async () => {
    const s = await opened();
    const web = await monitor(s, "web", {
      down: [
        [33 * hour, 37 * hour],
        [70 * hour, 74 * hour],
      ],
      excluded: [{ from: d0 + 34 * hour, to: d0 + 36 * hour }],
    });
    await outage(s, web, 33 * hour, 37 * hour);
    await outage(s, web, 70 * hour, 74 * hour);
    const id = await component(s, "الموقع", [web.id]);
    await s.storage.maintenance.create({
      componentIds: [id],
      endsAt: d0 + 36 * hour,
      message: { ar: "نص" },
      startsAt: d0 + 34 * hour,
      title: { ar: "صيانة" },
    });
    await s.storage.maintenance.advance(now);
    const stored = await s.storage.components.find(id);
    if (!stored) {
      throw new Error("no component");
    }
    // The bars as the status page reads them at the same time, the first three of six days.
    const sum = (
      days: readonly { downtimeMs: number; observedMs: number }[]
    ) => ({
      downtimeMs: days
        .slice(0, 3)
        .reduce((all, each) => all + each.downtimeMs, 0),
      observedMs: days
        .slice(0, 3)
        .reduce((all, each) => all + each.observedMs, 0),
    });
    const bars = await readComponentDays(s.storage, [stored], { days: 6, now });
    const own = await readMonitorDays(s.storage, [web], { days: 6, now });
    const forComponent = await report(s, query("component", id));
    const forMonitor = await report(s, query("monitor", web.id));
    expect(forComponent.subject.figures).toMatchObject(sum(bars.get(id) ?? []));
    expect(forMonitor.subject.figures).toMatchObject(
      sum(own.get(web.id) ?? [])
    );
    // The outage across the range's end gives the first range its two hours of 3 September and no more.
    expect(forMonitor.subject.figures.outages).toBe(2);
  });
});

describe("report reads one at a time", () => {
  test("a second read starts when the first is done, so two big reports never hold their batches together", async () => {
    const s = await opened();
    const alpha = await monitor(s, "alpha");
    const events: string[] = [];
    const watched = {
      ...s.storage,
      monitors: {
        ...s.storage.monitors,
        list: () => {
          events.push("start");
          return s.storage.monitors.list();
        },
      },
    };
    const run = () =>
      readReport(watched, query("monitor", alpha.id), now).then(() => {
        events.push("done");
      });
    await Promise.all([run(), run()]);
    expect(events).toEqual(["start", "done", "start", "done"]);
  });
});

describe("what the form offers", () => {
  test("every monitor by name, each group once, every component and every page", async () => {
    const s = await opened();
    await s.storage.monitors.create({ ...site, group: "core", name: "b" });
    await s.storage.monitors.create({ ...site, group: "core", name: "a" });
    await s.storage.monitors.create({ ...site, name: "c" });
    const web = await component(s, "الموقع", []);
    const choices = await readReportChoices(s.storage);
    expect(choices.ok).toBe(true);
    if (choices.ok) {
      expect(choices.choices.monitors.map((each) => each.name)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(choices.choices.groups).toEqual(["core"]);
      expect(choices.choices.components).toEqual([
        { id: web, name: { ar: "الموقع" } },
      ]);
      expect(choices.choices.pages).toEqual([]);
    }
  });
});

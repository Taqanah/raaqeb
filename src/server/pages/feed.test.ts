import { afterEach, describe, expect, test } from "bun:test";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { calendar } from "@/server/settings/clock.ts";
import type { IncidentCreateInput } from "@/shared/schemas/incident.ts";
import { type PagePaths, publicPolicy } from "@/shared/schemas/overview.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { createComponent } from "./components.ts";
import {
  type FeedStorage,
  feedEntries,
  feedResponse,
  readFeed,
} from "./feed.ts";
import {
  d0,
  day,
  forbiddenInXml,
  hour,
  minute,
  type PagesScratch,
  scratchPages,
  testAddress,
} from "./fixture.ts";
import { createPage, savePage } from "./pages.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** Noon of 11 September 2026, UTC. */
const now = d0 + 10 * day + 12 * hour;
const author = "owner@example.com";
const iso = (ms: number) => new Date(ms).toISOString();

/** Another page's addresses on the public address: its own language plain, English under the prefix. */
const paths: PagePaths = {
  bases: { ar: "/status/main", en: "/en/status/main" },
  origin: testAddress,
};

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
  title = "حالة المتجر"
): Promise<string> {
  const created = await createPage(s.storage, {
    locale: "ar",
    slug: "main",
    title,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const saved = await savePage(s.storage, created.page.id, {
    customDomain: undefined,
    customization: {
      ...defaultCustomization,
      description: { ar: "كل خدماتنا" },
    },
    isDefault: false,
    published: true,
    layout: componentIds.map((componentId) => ({
      componentId,
      kind: "component",
    })),
    locale: "ar",
    slug: "main",
    title: { ar: title },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return created.page.id;
}

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
    message: { ar: `${title}: نحقق.\n\nالفقرة الثانية.` },
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

/** Schedules a window from `start` to `end`, written at `written`. */
async function window(
  s: PagesScratch,
  title: string,
  componentIds: string[],
  [start, end]: readonly [number, number],
  written: number
): Promise<string> {
  s.at(written);
  const created = await createWindow(
    s.storage,
    {
      componentIds,
      endsAt: end,
      message: { ar: `${title}.` },
      startsAt: start,
      title: { ar: title },
    },
    written
  );
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return created.window.id;
}

/**
 * A page showing the site and payments, and a component it does not show:
 * a resolved incident on payments, an open one on the site, one on the
 * hidden component alone, a completed window on the site, one to come on
 * payments and one to come on the hidden one.
 */
async function world() {
  scratch = await scratchPages(d0);
  const s = scratch;
  const web = await component(s, "الموقع");
  const pay = await component(s, "الدفع");
  const hidden = await component(s, "خارج الصفحة");
  const pageId = await page(s, [web, pay]);
  const resolved = await incident(
    s,
    "توقف الدفع",
    [pay],
    now - 4 * day,
    now - 4 * day + hour
  );
  const doneAt = [now - 3 * day, now - 3 * day + hour] as const;
  const done = await window(s, "ترقية", [web], doneAt, now - 4 * day);
  // The scheduler moves it at its start and at its end.
  for (const edge of doneAt) {
    s.at(edge);
    // biome-ignore lint/performance/noAwaitInLoops: one move at a time
    await s.storage.maintenance.advance(edge);
  }
  const open = await incident(s, "بطء", [web], now - 2 * hour);
  const elsewhere = await incident(s, "لغيرها", [hidden], now - hour);
  const later = [now + day, now + day + hour] as const;
  const coming = await window(s, "قادمة", [pay], later, now - 30 * minute);
  const away = await window(s, "بعيدة", [hidden], later, now - 20 * minute);
  s.at(now);
  return { away, coming, done, elsewhere, open, pageId, pay, resolved, s, web };
}

async function feedOf(
  w: Pick<Awaited<ReturnType<typeof world>>, "pageId" | "s">,
  locale: "ar" | "en" = "ar",
  at = paths
): Promise<string> {
  const result = await readFeed(w.s.storage, w.pageId, locale, at);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.document;
}

const entryPattern = /<entry>[\s\S]*?<\/entry>/g;
const idPattern = /<id>([^<]*)<\/id>/;
const uuidUrn = /^urn:uuid:[0-9a-f-]{36}$/;

/** The feed's entries' XML, in order. */
function entries(feed: string): string[] {
  return feed.match(entryPattern) ?? [];
}

/** The text of the first element with that name. */
function textOf(xml: string, element: string) {
  return xml.match(new RegExp(`<${element}\\b[^>]*>([^<]*)</${element}>`))?.[1];
}

/** The href of the first link with that rel. */
function linkOf(xml: string, rel: string) {
  return xml.match(new RegExp(`<link rel="${rel}"[^>]*href="([^"]*)"`))?.[1];
}

describe('a status page\'s feed (CONTEXT.md "Feed")', () => {
  test("is an Atom feed in the address's language, named by the page", async () => {
    const w = await world();
    const feed = await feedOf(w);
    expect(feed.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(
      true
    );
    expect(feed).toContain(
      '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ar">'
    );
    expect(textOf(feed, "title")).toBe("حالة المتجر");
    expect(textOf(feed, "subtitle")).toBe("كل خدماتنا");
    expect(feed).toContain("<author><name>حالة المتجر</name></author>");
    expect(await feedOf(w, "en")).toContain('xml:lang="en"');
  });

  test("links itself and the page's overview in its locale", async () => {
    const w = await world();
    const arabic = await feedOf(w);
    expect(linkOf(arabic, "self")).toBe(`${testAddress}/status/main/feed.atom`);
    expect(linkOf(arabic, "alternate")).toBe(`${testAddress}/status/main`);
    const english = await feedOf(w, "en");
    expect(linkOf(english, "self")).toBe(
      `${testAddress}/en/status/main/feed.atom`
    );
    expect(linkOf(english, "alternate")).toBe(`${testAddress}/en/status/main`);
  });

  test("with no public address its links are the page's paths", async () => {
    const w = await world();
    const feed = await feedOf(w, "ar", {
      bases: { ar: "", en: "/en" },
      origin: undefined,
    });
    expect(linkOf(feed, "self")).toBe("/feed.atom");
    expect(linkOf(feed, "alternate")).toBe("/");
  });

  test("its id is a URI, the same on every read and different in each locale", async () => {
    const w = await world();
    const id = (feed: string) =>
      feed.slice(0, feed.indexOf("<entry>")).match(idPattern)?.[1];
    const arabic = id(await feedOf(w));
    expect(arabic).toMatch(uuidUrn);
    expect(id(await feedOf(w))).toBe(arabic);
    expect(id(await feedOf(w, "en"))).not.toBe(arabic);
    // The address it is read at does not change what it is.
    expect(
      id(await feedOf(w, "ar", { bases: paths.bases, origin: undefined }))
    ).toBe(arabic);
  });

  test("holds the incidents and windows on the page's components, the most recently changed first", async () => {
    const w = await world();
    const ids = entries(await feedOf(w)).map((entry) => textOf(entry, "id"));
    // The window to come was written half an hour ago, the open incident two hours ago, and the completed window last moved at its end.
    expect(ids).toEqual(
      [w.coming, w.open, w.done, w.resolved].map((id) => `urn:uuid:${id}`)
    );
  });

  test("the feed's updated time is its newest entry's", async () => {
    const w = await world();
    const feed = await feedOf(w);
    const head = feed.slice(0, feed.indexOf("<entry>"));
    expect(textOf(head, "updated")).toBe(
      textOf(entries(feed)[0] ?? "", "updated")
    );
  });

  test("an incident's entry links its view in the locale and carries its times, impact and every update newest first", async () => {
    const w = await world();
    const entry =
      entries(await feedOf(w)).find((each) => each.includes(w.resolved)) ?? "";
    expect(textOf(entry, "title")).toBe("توقف الدفع");
    expect(linkOf(entry, "alternate")).toBe(
      `${testAddress}/status/main/incidents/${w.resolved}`
    );
    expect(textOf(entry, "published")).toBe(iso(now - 4 * day));
    expect(textOf(entry, "updated")).toBe(iso(now - 4 * day + hour));
    expect(entry).toContain('<category term="incident"/>');
    expect(entry).toContain("التأثير: طفيف");
    expect(entry).toContain("المكوّنات المتأثرة");
    expect(entry).toContain("الدفع");
    const solved = entry.indexOf("توقف الدفع: حُلّت.");
    const first = entry.indexOf("توقف الدفع: نحقق.");
    expect(solved).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(solved);
    expect(entry.indexOf("تم الحل")).toBeLessThan(entry.indexOf("قيد التحرّي"));
    expect(entry).toContain("الفقرة الثانية.");
  });

  test("an entry's paragraphs are each their own paragraph, direction by their own text", async () => {
    const w = await world();
    const entry =
      entries(await feedOf(w)).find((each) => each.includes(w.open)) ?? "";
    expect(entry).toContain('<content type="xhtml">');
    expect(entry).toContain('<p dir="auto">بطء: نحقق.</p>');
    expect(entry).toContain('<p dir="auto">الفقرة الثانية.</p>');
  });

  test("a window's entry links its view and carries its stage and times in the tense of its stage", async () => {
    const w = await world();
    const feed = await feedOf(w, "en");
    const done = entries(feed).find((each) => each.includes(w.done)) ?? "";
    expect(linkOf(done, "alternate")).toBe(
      `${testAddress}/en/status/main/maintenance/${w.done}`
    );
    expect(done).toContain('<category term="maintenance"/>');
    expect(done).toContain("Completed");
    expect(done).toContain("Started");
    expect(done).toContain("Ended");
    expect(done).toContain("ترقية.");
    const coming = entries(feed).find((each) => each.includes(w.coming)) ?? "";
    expect(coming).toContain("Scheduled");
    expect(coming).toContain("Starts");
    expect(coming).toContain("Ends");
  });

  test("its times stay Gregorian whatever the install's calendar, since a feed is a machine surface", async () => {
    const w = await world();
    await w.s.storage.settings.set(calendar, "hijri_gregorian");
    const entry =
      entries(await feedOf(w, "en")).find((each) =>
        each.includes(w.resolved)
      ) ?? "";
    expect(entry).toContain("Sep 7, 2026");
    expect(entry).not.toContain(" AH");
  });

  test("the English feed has English words and the operator's text as written", async () => {
    const w = await world();
    const entry =
      entries(await feedOf(w, "en")).find((each) =>
        each.includes(w.resolved)
      ) ?? "";
    expect(entry).toContain("Impact: Minor");
    expect(entry).toContain("Resolved");
    expect(entry).toContain("توقف الدفع: حُلّت.");
  });

  test("escapes the page's and the operator's text", async () => {
    scratch = await scratchPages(d0);
    const web = await component(scratch, "A & <B>");
    const pageId = await page(scratch, [web], "Tom & Jerry <status>");
    await incident(
      scratch,
      "<script>alert(1)</script> & co",
      [web],
      now - hour
    );
    scratch.at(now);
    const result = await readFeed(scratch.storage, pageId, "en", paths);
    const feed = result.ok ? result.document : "";
    expect(feed).not.toContain("<script>");
    expect(feed).not.toContain("<B>");
    expect(feed).not.toContain("<status>");
    expect(textOf(feed, "title")).toBe("Tom &amp; Jerry &lt;status&gt;");
    expect(feed).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(feed).toContain("A &amp; &lt;B&gt;");
  });

  test(`holds the ${feedEntries} entries changed last`, async () => {
    scratch = await scratchPages(d0);
    const web = await component(scratch, "الموقع");
    const pageId = await page(scratch, [web]);
    const ids: string[] = [];
    for (let n = 0; n <= feedEntries; n += 1) {
      const at = now - (100 - n) * hour;
      // biome-ignore lint/performance/noAwaitInLoops: each incident at its own time
      ids.push(await incident(scratch, `حادثة ${n}`, [web], at));
    }
    scratch.at(now);
    const result = await readFeed(scratch.storage, pageId, "ar", paths);
    const held = entries(result.ok ? result.document : "").map((entry) =>
      textOf(entry, "id")
    );
    expect(held).toHaveLength(feedEntries);
    expect(held[0]).toBe(`urn:uuid:${ids.at(-1)}`);
    expect(held).not.toContain(`urn:uuid:${ids[0]}`);
  });

  test("a page with nothing to tell is an empty feed updated when the page was", async () => {
    scratch = await scratchPages(d0);
    const web = await component(scratch, "الموقع");
    const pageId = await page(scratch, [web]);
    const result = await readFeed(scratch.storage, pageId, "ar", paths);
    const feed = result.ok ? result.document : "";
    expect(entries(feed)).toEqual([]);
    expect(textOf(feed, "updated")).toBe(iso(d0));
  });

  test("a single line break inside a paragraph stays a break", async () => {
    scratch = await scratchPages(d0);
    const web = await component(scratch, "الموقع");
    const pageId = await page(scratch, [web]);
    scratch.at(now);
    await createWindow(
      scratch.storage,
      {
        componentIds: [web],
        endsAt: now + 2 * hour,
        message: { ar: "السطر الأول\nالسطر الثاني" },
        startsAt: now + hour,
        title: { ar: "صيانة" },
      },
      now
    );
    const result = await readFeed(scratch.storage, pageId, "ar", paths);
    expect(result.ok && result.document).toContain(
      '<p dir="auto">السطر الأول<br/>السطر الثاني</p>'
    );
  });

  test("an incident whose components all left the page leaves its feed", async () => {
    const w = await world();
    await savePage(w.s.storage, w.pageId, {
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      layout: [{ componentId: w.pay, kind: "component" }],
      locale: "ar",
      slug: "main",
      title: { ar: "حالة المتجر" },
    });
    const ids = entries(await feedOf(w)).map((entry) => textOf(entry, "id"));
    expect(ids).not.toContain(`urn:uuid:${w.open}`);
    expect(ids).not.toContain(`urn:uuid:${w.done}`);
    expect(ids).toContain(`urn:uuid:${w.resolved}`);
  });

  test("a control character XML forbids in the operator's text is left out, so the feed stays well-formed", async () => {
    scratch = await scratchPages(d0);
    const web = await component(scratch, "الموقع\u0001");
    const pageId = await page(scratch, [web], "حالة\u000Cالمتجر");
    await incident(scratch, "قاعدة\u000Bالبيانات", [web], now - hour);
    scratch.at(now);
    const result = await readFeed(scratch.storage, pageId, "ar", paths);
    const feed = result.ok ? result.document : "";
    expect(feed).toContain("قاعدةالبيانات");
    expect(forbiddenInXml(feed)).toBe(false);
  });

  test("an unknown page is not found", async () => {
    scratch = await scratchPages(d0);
    expect(
      await readFeed(scratch.storage, "no-such-page", "ar", paths)
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const w = await world();
    const broken: FeedStorage = {
      ...w.s.storage,
      incidents: {
        ...w.s.storage.incidents,
        list: () => Promise.reject(new Error("the database went away")),
      },
    };
    expect(await readFeed(broken, w.pageId, "ar", paths)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("the feed's public answer", () => {
  test("is Atom the memo keeps", async () => {
    const response = feedResponse({ document: "<feed/>", ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/atom+xml; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe(publicPolicy);
    expect(await response.text()).toBe("<feed/>");
  });

  test("is 404 for no page and 503 with no database, neither kept", () => {
    const missing = feedResponse({ ok: false, reason: "not_found" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(feedResponse(undefined).status).toBe(503);
  });
});

describe("the feed's content", () => {
  test("each locale's feed shows the text written in it, an empty translation falling back to the page language's", async () => {
    scratch = await scratchPages(d0);
    const s = scratch;
    const created = await createComponent(s.storage, {
      description: undefined,
      monitorIds: [],
      name: { ar: "الموقع", en: "Website" },
      status: "operational",
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const web = created.component.id;
    const pageId = await page(s, [web]);
    s.at(now - hour);
    const opened = await createIncident(
      s.storage,
      {
        impact: "minor",
        message: { ar: "نحقق." },
        stage: "investigating",
        statuses: [{ componentId: web, status: "partial_outage" }],
        title: { ar: "بطء", en: "Slow pages" },
      },
      author
    );
    expect(opened.ok).toBe(true);
    s.at(now);
    const w = { pageId, s };
    const english = await feedOf(w, "en");
    const [entry] = entries(english);
    expect(textOf(english, "title")).toBe("حالة المتجر");
    expect(textOf(english, "subtitle")).toBe("كل خدماتنا");
    expect(textOf(entry ?? "", "title")).toBe("Slow pages");
    expect(entry).toContain("Website");
    expect(entry).toContain('<p dir="auto">نحقق.</p>');
    const arabic = entries(await feedOf(w, "ar"))[0] ?? "";
    expect(textOf(arabic, "title")).toBe("بطء");
    expect(arabic).toContain("الموقع");
  });
});

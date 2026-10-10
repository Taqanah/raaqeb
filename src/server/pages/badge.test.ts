import { afterEach, describe, expect, test } from "bun:test";
import { createIncident } from "@/server/incidents/incidents.ts";
import { publicPolicy } from "@/shared/schemas/overview.ts";
import {
  defaultCustomization,
  type PageCustomization,
} from "@/shared/schemas/page.ts";
import { type BadgeStorage, badgeResponse, readBadge } from "./badge.ts";
import { createComponent } from "./components.ts";
import {
  d0,
  forbiddenInXml,
  type PagesScratch,
  scratchPages,
} from "./fixture.ts";
import { createPage, savePage } from "./pages.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** A page titled `title` showing one component set by hand, with the customization given. */
async function world(
  title = "حالة المتجر",
  customization: Partial<PageCustomization> = {}
) {
  scratch = await scratchPages(d0);
  const s = scratch;
  const created = await createComponent(s.storage, {
    description: undefined,
    monitorIds: [],
    name: { ar: "الموقع" },
    status: "operational",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const web = created.component.id;
  const made = await createPage(s.storage, {
    locale: "ar",
    slug: "main",
    title,
  });
  if (!made.ok) {
    throw new Error(made.reason);
  }
  const saved = await savePage(s.storage, made.page.id, {
    customDomain: undefined,
    customization: { ...defaultCustomization, ...customization },
    isDefault: true,
    published: true,
    layout: [{ componentId: web, kind: "component" }],
    locale: "ar",
    slug: "main",
    title: { ar: title },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return { pageId: made.page.id, s, web };
}

async function badgeOf(
  w: Awaited<ReturnType<typeof world>>,
  locale: "ar" | "en"
): Promise<string> {
  const result = await readBadge(w.s.storage, w.pageId, locale);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.document;
}

/** The value of an attribute on the first element with that name. */
function attribute(svg: string, element: string, name: string) {
  const tag = svg.match(new RegExp(`<${element}\\b[^>]*>`))?.[0] ?? "";
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** The text of the first element with that name. */
function textOf(svg: string, element: string) {
  return svg.match(new RegExp(`<${element}\\b[^>]*>([^<]*)</${element}>`))?.[1];
}

describe("a status page's badge", () => {
  test("is an SVG image named by the page's title and its level, in the page language", async () => {
    const w = await world();
    const svg = await badgeOf(w, "ar");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(attribute(svg, "svg", "xmlns")).toBe("http://www.w3.org/2000/svg");
    expect(attribute(svg, "svg", "role")).toBe("img");
    expect(attribute(svg, "svg", "aria-label")).toBe("حالة المتجر: يعمل");
    expect(textOf(svg, "title")).toBe("حالة المتجر: يعمل");
    expect(textOf(svg, "text")).toBe("يعمل");
  });

  test("reads right to left in Arabic and left to right in English", async () => {
    const w = await world();
    expect(attribute(await badgeOf(w, "ar"), "text", "direction")).toBe("rtl");
    const english = await badgeOf(w, "en");
    expect(textOf(english, "text")).toBe("Operational");
    expect(attribute(english, "text", "direction")).toBe("ltr");
  });

  test("the dot sits on the reading direction's start side", async () => {
    const w = await world();
    const width = (svg: string) => Number(attribute(svg, "svg", "width"));
    const dotX = (svg: string) => Number(attribute(svg, "circle", "cx"));
    const arabic = await badgeOf(w, "ar");
    const english = await badgeOf(w, "en");
    expect(dotX(arabic)).toBeGreaterThan(width(arabic) / 2);
    expect(dotX(english)).toBeLessThan(width(english) / 2);
  });

  test("the dot is the level's colour and the ground and ink are neutral", async () => {
    const w = await world();
    const svg = await badgeOf(w, "ar");
    expect(attribute(svg, "circle", "fill")).toBe("#16a34a");
    expect(attribute(svg, "text", "fill")).not.toBe("#16a34a");
  });

  test("follows the page's level: an incident's major outage turns it red", async () => {
    const w = await world();
    const opened = await createIncident(
      w.s.storage,
      {
        impact: "critical",
        message: { ar: "توقف" },
        stage: "investigating",
        statuses: [{ componentId: w.web, status: "major_outage" }],
        title: { ar: "توقف" },
      },
      "owner@example.com"
    );
    expect(opened.ok).toBe(true);
    const svg = await badgeOf(w, "en");
    expect(textOf(svg, "text")).toBe("Major outage");
    expect(attribute(svg, "circle", "fill")).toBe("#dc2626");
  });

  test("a page's own colour for the level replaces the default, in both locales", async () => {
    const w = await world("حالة المتجر", {
      statusColours: { operational: "#0f766e" },
    });
    for (const locale of ["ar", "en"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one badge at a time
      const svg = await badgeOf(w, locale);
      expect(attribute(svg, "circle", "fill")).toBe("#0f766e");
    }
  });

  test("a page's own name for the level shows in its page language, and the other locale keeps the default", async () => {
    const w = await world("حالة المتجر", {
      labels: { operational: { ar: "كل شيء بخير" } },
    });
    expect(textOf(await badgeOf(w, "ar"), "text")).toBe("كل شيء بخير");
    expect(textOf(await badgeOf(w, "en"), "text")).toBe("Operational");
  });

  test("a longer name makes a wider badge, and the text is fitted to its box", async () => {
    const short = await world("حالة", {
      labels: { operational: { ar: "جيد" } },
    });
    const narrow = Number(
      attribute(await badgeOf(short, "ar"), "svg", "width")
    );
    await scratch?.cleanup();
    const long = await world("حالة", {
      labels: { operational: { ar: "كل الأنظمة تعمل بلا أي مشكلة" } },
    });
    const wideSvg = await badgeOf(long, "ar");
    expect(Number(attribute(wideSvg, "svg", "width"))).toBeGreaterThan(narrow);
    expect(Number(attribute(wideSvg, "text", "textLength"))).toBeGreaterThan(0);
    expect(attribute(wideSvg, "text", "lengthAdjust")).toBe("spacingAndGlyphs");
  });

  test("escapes the page's own text", async () => {
    const w = await world('A & B <script>"x"</script>', {
      labels: { operational: { ar: "<b>&ok</b>" } },
    });
    const svg = await badgeOf(w, "ar");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<b>");
    expect(textOf(svg, "text")).toBe("&lt;b&gt;&amp;ok&lt;/b&gt;");
    expect(attribute(svg, "svg", "aria-label")).toBe(
      "A &amp; B &lt;script&gt;&quot;x&quot;&lt;/script&gt;: &lt;b&gt;&amp;ok&lt;/b&gt;"
    );
  });

  test("a page that shows no component reads operational", async () => {
    scratch = await scratchPages(d0);
    const made = await createPage(scratch.storage, {
      locale: "ar",
      slug: "empty",
      title: "فارغة",
    });
    if (!made.ok) {
      throw new Error(made.reason);
    }
    const result = await readBadge(scratch.storage, made.page.id, "en");
    expect(result.ok && textOf(result.document, "text")).toBe("Operational");
  });

  test("a control character XML forbids in the page's title or label is left out", async () => {
    const w = await world("حالة\u000BالمتجرX", {
      labels: { operational: { ar: "بخير\u0001" } },
    });
    const svg = await badgeOf(w, "ar");
    expect(textOf(svg, "text")).toBe("بخير");
    expect(forbiddenInXml(svg)).toBe(false);
  });

  test("an unknown page is not found", async () => {
    scratch = await scratchPages(d0);
    expect(
      await readBadge(scratch.storage, "no-such-page", "ar")
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const w = await world();
    const broken: BadgeStorage = {
      ...w.s.storage,
      components: {
        ...w.s.storage.components,
        list: () => Promise.reject(new Error("the database went away")),
      },
    };
    expect(await readBadge(broken, w.pageId, "ar")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("the badge's public answer", () => {
  test("is SVG the memo keeps, under a sandbox policy", async () => {
    const response = badgeResponse({ document: "<svg/>", ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "image/svg+xml; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe(publicPolicy);
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox"
    );
    expect(await response.text()).toBe("<svg/>");
  });

  test("is 404 for no page and 503 with no database, neither kept", () => {
    const missing = badgeResponse({ ok: false, reason: "not_found" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(badgeResponse(undefined).status).toBe(503);
    expect(badgeResponse({ ok: false, reason: "unavailable" }).status).toBe(
      503
    );
  });
});

describe("the badge's content", () => {
  test("names the page by its title in the badge's locale, else the page language's, with a status name written in that locale", async () => {
    const w = await world("حالة المتجر", {
      labels: { operational: { en: "All good" } },
    });
    expect(textOf(await badgeOf(w, "en"), "title")).toBe(
      "حالة المتجر: All good"
    );
    // The Arabic badge has no Arabic status name, so it shows the catalog's.
    expect(textOf(await badgeOf(w, "ar"), "text")).toBe("يعمل");
    const page = await w.s.storage.pages.find(w.pageId);
    if (!page) {
      throw new Error("no page");
    }
    await w.s.storage.pages.save(
      w.pageId,
      { ...page, title: { ar: "حالة المتجر", en: "Shop status" } },
      await w.s.storage.pages.layout(w.pageId)
    );
    expect(textOf(await badgeOf(w, "en"), "title")).toBe(
      "Shop status: All good"
    );
    expect(textOf(await badgeOf(w, "ar"), "title")).toBe("حالة المتجر: يعمل");
  });
});

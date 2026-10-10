// The public API on the built entry: every
// path the OpenAPI document names answers on the English server with a
// status and a type the document lists; the summary, the badge and the feed
// go through the memo; the document itself is served. Nothing here changes
// that install.

import type { APIRequestContext, Page } from "@playwright/test";
import { openApiDocument } from "@/shared/api/openapi.ts";
import { expect, test } from "./support/fixtures.ts";
import { englishOrigin, publicPage } from "./support/servers.ts";

interface Operation {
  readonly responses: Readonly<
    Record<string, { readonly content?: Readonly<Record<string, unknown>> }>
  >;
}

/** The English page's id and the ids of its open incident and scheduled window, read from its overview document. */
async function ids(request: APIRequestContext, page: Page) {
  await page.goto(`${englishOrigin}/`);
  const pageId =
    (await page.locator("[data-slot=status-page]").getAttribute("data-page")) ??
    "";
  const overview = await (
    await request.get(`${englishOrigin}/api/pages/${pageId}/overview`)
  ).json();
  return {
    incidentId: overview.incidents[0].id as string,
    pageId,
    windowId: overview.maintenance[0].id as string,
  };
}

/** A documented path with its parameters filled from the English install. */
function filled(path: string, values: Readonly<Record<string, string>>) {
  return path.replaceAll(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
}

const heldEtag = async (request: APIRequestContext, url: string) => {
  const first = await request.get(url);
  const again = await request.get(url, {
    headers: { "if-none-match": first.headers().etag ?? "" },
  });
  return again.status();
};

test("every path in the OpenAPI document answers with a status and a type the document lists", async ({
  page,
  request,
}) => {
  const { incidentId, pageId, windowId } = await ids(request, page);
  const values = {
    id: pageId,
    incidentId,
    kind: "logo",
    // The English page's other locale.
    locale: "ar",
    month: new Date().toISOString().slice(0, 7),
    slug: publicPage.slug,
    // No heartbeat monitor and no subscription has it: the documented 404, or a subscription's 303 to its page.
    token: "0".repeat(32),
    windowId,
  };
  const paths = Object.entries(openApiDocument().paths) as [
    string,
    Readonly<Record<string, Operation>>,
  ][];
  for (const [path, item] of paths) {
    for (const [method, operation] of Object.entries(item)) {
      const url = `${englishOrigin}${filled(path, values)}`;
      // The document lists each operation's own answer, a redirect included, so none is followed.
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const response = await request.fetch(url, {
        maxRedirects: 0,
        method: method.toUpperCase(),
      });
      const status = String(response.status());
      const documented = operation.responses[status];
      expect(documented, `${method} ${path} answered ${status}`).toBeDefined();
      const types = Object.keys(documented?.content ?? {});
      if (types.length > 0) {
        const type = response.headers()["content-type"] ?? "";
        expect(
          types.some((each) => type.startsWith(each)),
          `${method} ${path}: ${type}`
        ).toBe(true);
      }
    }
  }
});

test("the summary, the badge and the feed of every address are answered and kept by the memo", async ({
  page,
  request,
}) => {
  await ids(request, page);
  for (const path of [
    "/api/v2/summary.json",
    `/status/${publicPage.slug}/api/v2/summary.json`,
    "/badge.svg",
    "/ar/badge.svg",
    `/ar/status/${publicPage.slug}/badge.svg`,
    "/feed.atom",
    "/ar/feed.atom",
    `/status/${publicPage.slug}/feed.atom`,
  ]) {
    const url = `${englishOrigin}${path}`;
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    const first = await request.get(url);
    expect(first.status(), path).toBe(200);
    expect(first.headers()["cache-control"], path).toBe(
      "public, max-age=0, must-revalidate"
    );
    await expect
      .poll(() => heldEtag(request, url), { message: path })
      .toBe(304);
  }
});

test("the page's own prefix and a locale prefix on the summary are no address", async ({
  request,
}) => {
  for (const path of [
    "/en/badge.svg",
    "/en/feed.atom",
    "/ar/api/v2/summary.json",
    "/en/api/v2/summary.json",
    "/status/nope/feed.atom",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time
    const response = await request.get(`${englishOrigin}${path}`);
    expect(response.status(), path).toBe(404);
  }
});

test("the summary names the English page, its open incident and its scheduled window", async ({
  page,
  request,
}) => {
  const { incidentId, pageId, windowId } = await ids(request, page);
  const summary = await (
    await request.get(`${englishOrigin}/api/v2/summary.json`)
  ).json();
  expect(summary.page).toMatchObject({ id: pageId, name: publicPage.title });
  expect(summary.incidents.map((each: { id: string }) => each.id)).toEqual([
    incidentId,
  ]);
  expect(
    summary.scheduled_maintenances.map((each: { id: string }) => each.id)
  ).toEqual([windowId]);
  expect(["none", "maintenance", "minor", "major", "critical"]).toContain(
    summary.status.indicator
  );
});

test("the badge and the feed are well-formed XML", async ({ page }) => {
  await page.goto(`${englishOrigin}/`);
  for (const [path, type] of [
    ["/badge.svg", "image/svg+xml"],
    ["/ar/badge.svg", "image/svg+xml"],
    ["/feed.atom", "application/xml"],
    ["/ar/feed.atom", "application/xml"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one document at a time
    const problem = await page.evaluate(
      async ([url, mime]) => {
        const text = await (await fetch(url)).text();
        const parsed = new DOMParser().parseFromString(text, mime);
        return parsed.querySelector("parsererror")?.textContent ?? null;
      },
      [path, type] as const
    );
    expect(problem, path).toBe(null);
  }
});

test("the OpenAPI document is served at /api/openapi.json", async ({
  request,
}) => {
  const response = await request.get(`${englishOrigin}/api/openapi.json`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual(
    JSON.parse(JSON.stringify(openApiDocument()))
  );
});

test("every view's head links the page's feed in its locale", async ({
  page,
}) => {
  for (const [path, feed] of [
    ["/", "/feed.atom"],
    ["/ar", "/ar/feed.atom"],
    ["/history", "/feed.atom"],
    [`/ar/status/${publicPage.slug}/history`, "/ar/feed.atom"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one page at a time
    await page.goto(`${englishOrigin}${path}`);
    const href =
      (await page
        .locator('link[rel=alternate][type="application/atom+xml"]')
        .getAttribute("href")) ?? "";
    // Another spec stores this install's own origin as its public address, which makes the link absolute on it and on nothing else.
    expect(
      href.startsWith(englishOrigin) ? href.slice(englishOrigin.length) : href,
      path
    ).toBe(feed);
  }
});

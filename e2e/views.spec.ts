// A status page's history, incident and maintenance views on the built entry, on the English server, whose
// default page holds an open incident, a scheduled window, and a resolved
// incident and a completed window in this month's history
// (e2e/support/serve-en.ts). Nothing here changes that install.

import type { APIRequestContext, Page } from "@playwright/test";
import { reasons } from "@/shared/schemas/reason.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  arabicOrigin,
  englishOrigin,
  operatorEmail,
  publicPage,
} from "./support/servers.ts";

/** A message id of the admin's own areas, as the minifier quotes it: the admin's screens. A reason's name (`auth_failed`) is a machine token, not a message id, so it is left out. */
const adminWords = new RegExp(
  `[\`"'](?!(?:${Object.keys(reasons).join("|")})[\`"'])(?:monitor|channel|auth|onboarding)_[a-z0-9_]+[\`"']`
);
/** A server function behind the operator's session check: every admin server function carries one, no public code does. */
const sessionChecked = /\.middleware\(\[/g;

interface Ids {
  readonly completed: string;
  readonly open: string;
  readonly pageId: string;
  readonly resolved: string;
  readonly scheduled: string;
}

/** The page's id, and the ids of its incidents and windows, read from its documents. */
async function ids(request: APIRequestContext, page: Page): Promise<Ids> {
  await page.goto(`${englishOrigin}/`);
  const pageId =
    (await page.locator("[data-slot=status-page]").getAttribute("data-page")) ??
    "";
  const overview = await (
    await request.get(`${englishOrigin}/api/pages/${pageId}/overview`)
  ).json();
  const history = await (
    await request.get(`${englishOrigin}/api/pages/${pageId}/history`)
  ).json();
  const entry = (kind: string) =>
    history.entries.find((each: { kind: string }) => each.kind === kind)?.id;
  return {
    completed: entry("maintenance"),
    open: overview.incidents[0].id,
    pageId,
    resolved: entry("incident"),
    scheduled: overview.maintenance[0].id,
  };
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** A head link's address as a path: other specs store this install's own origin as its public address, which makes the link absolute on it and on nothing else. */
async function linkPath(page: Page, selector: string): Promise<string> {
  const href = (await page.locator(selector).getAttribute("href")) ?? "";
  return href.startsWith(englishOrigin)
    ? href.slice(englishOrigin.length)
    : href;
}

test("the history shows this month's resolved incident and completed window, and nothing still open", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/history`);
  await expectPath(page, "/history");
  await expect(
    page.locator(`[data-slot=history][data-month="${thisMonth()}"]`)
  ).toBeVisible();
  await expect(
    page.locator("[data-slot=history-entry][data-kind=incident]")
  ).toContainText(publicPage.resolvedIncident);
  await expect(
    page.locator("[data-slot=history-entry][data-kind=maintenance]")
  ).toContainText(publicPage.completedWindow);
  await expect(page.locator("[data-slot=history]")).not.toContainText(
    "Slow API responses"
  );
  // Minutes old: after mount the entry's start is relative, with no zone label.
  await expect(
    page.locator("[data-slot=history-entry][data-kind=incident] time")
  ).not.toContainText("(");
  // The history reaches back to the day bar's first day, before this install's oldest entry.
  const lastMonth = new Date();
  lastMonth.setUTCDate(1);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  await expect(page.locator("[data-slot=history-previous]")).toHaveAttribute(
    "href",
    `/history/${lastMonth.toISOString().slice(0, 7)}`
  );
  await expect(page.locator("[data-slot=history-next]")).toHaveCount(0);
  await expect
    .poll(() => linkPath(page, "link[rel=canonical]"))
    .toBe(`/history/${thisMonth()}`);
});

test("a navigation between views is one fetch of the view's document through the memo, never a page load", async ({
  page,
  request,
}) => {
  const { completed, open, pageId } = await ids(request, page);
  await page.goto(`${englishOrigin}/`);
  const loads: string[] = [];
  const documents: { etag: string | undefined; url: string }[] = [];
  page.on("request", (sent) => {
    if (sent.isNavigationRequest()) {
      loads.push(sent.url());
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/pages/")) {
      documents.push({ etag: response.headers().etag, url: response.url() });
    }
  });
  await page.click("[data-slot=incident-card] [data-slot=incident-link]");
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();
  await expectPath(page, `/incidents/${open}`);
  await page.click("[data-slot=view-history]");
  await expect(page.locator("[data-slot=history]")).toBeVisible();
  await expectPath(page, "/history");
  await page.click("[data-slot=history-entry][data-kind=maintenance] a");
  await expect(page.locator("[data-slot=maintenance-view]")).toBeVisible();
  await page.click("[data-slot=view-overview]");
  await expectPath(page, "/");
  await expect(page.locator("[data-slot=page-banner]")).toBeVisible();
  // Back on a view it read before, the router shows that first and fetches its document just after.
  await expect.poll(() => documents.length).toBe(4);

  expect(loads).toEqual([]);
  expect(documents.map((each) => new URL(each.url).pathname)).toEqual([
    `/api/pages/${pageId}/incidents/${open}`,
    `/api/pages/${pageId}/history`,
    `/api/pages/${pageId}/maintenance/${completed}`,
    `/api/pages/${pageId}/overview`,
  ]);
  // The memo gives every answer it keeps an ETag; the route alone gives none.
  for (const each of documents) {
    expect(each.etag, each.url).toBeTruthy();
  }
});

test("an incident's view shows its impact, stage and every update newest first, never its author", async ({
  page,
  request,
}) => {
  const { open, resolved } = await ids(request, page);
  await page.goto(`${englishOrigin}/incidents/${resolved}`);
  await expect(
    page.locator("[data-slot=incident-view] [data-impact=major]")
  ).toBeVisible();
  await expect(
    page.locator("[data-slot=incident-view] [data-slot=incident-stage]")
  ).toHaveAttribute("data-stage", "resolved");
  const updates = page.locator("[data-slot=incident-update]");
  await expect(updates).toHaveCount(2);
  await expect(updates.first()).toHaveAttribute("data-stage", "resolved");
  await expect(updates.last()).toHaveAttribute("data-stage", "investigating");
  await expect(page.locator("body")).not.toContainText(operatorEmail);
  await expect(page).toHaveTitle(
    `${publicPage.resolvedIncident} · ${publicPage.title}`
  );

  await page.goto(`${englishOrigin}/incidents/${open}`);
  await expect(page.locator("[data-slot=incident-update]")).toHaveCount(1);
  // Minutes old: after mount its start is relative, with no zone label, as every time under a day is.
  await expect(
    page.locator("[data-slot=incident-started] time")
  ).not.toContainText("(");
  await expect(
    page.locator("[data-slot=incident-view] [data-slot=incident-stage]")
  ).toHaveAttribute("data-stage", "investigating");
});

test("a maintenance window's view shows its stage, completed or still to come", async ({
  page,
  request,
}) => {
  const { completed, scheduled } = await ids(request, page);
  await page.goto(`${englishOrigin}/maintenance/${completed}`);
  await expect(
    page.locator("[data-slot=maintenance-view] [data-slot=window-stage]")
  ).toHaveAttribute("data-stage", "completed");
  await expect(page.locator("[data-slot=maintenance-view] h2")).toHaveText(
    publicPage.completedWindow
  );
  await page.goto(
    `${englishOrigin}/status/${publicPage.slug}/maintenance/${scheduled}`
  );
  await expect(
    page.locator("[data-slot=maintenance-view] [data-slot=window-stage]")
  ).toHaveAttribute("data-stage", "scheduled");
  await expect
    .poll(() => linkPath(page, "link[rel=canonical]"))
    .toBe(`/maintenance/${scheduled}`);
});

test("the language switch on a view is a full load of the same view in the other locale", async ({
  page,
  request,
}) => {
  const { resolved } = await ids(request, page);
  await page.goto(`${englishOrigin}/incidents/${resolved}`);
  await page.click("[data-slot=page-locale]");
  await expectPath(page, `/ar/incidents/${resolved}`);
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();
  await expect
    .poll(() => linkPath(page, "link[rel=alternate][hreflang=en]"))
    .toBe(`/incidents/${resolved}`);
});

test("an address on the page with nothing at it is not found inside the page's frame", async ({
  page,
}) => {
  for (const path of [
    "/incidents/nope",
    "/maintenance/nope",
    "/history/2000-01",
    `/status/${publicPage.slug}/incidents/nope`,
    "/ar/history/2000-01",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    const response = await page.goto(`${englishOrigin}${path}`);
    expect(response?.status(), path).toBe(404);
    await expect(page.locator("[data-slot=view-missing]"), path).toBeVisible();
    // Under the Arabic prefix the frame shows the page's Arabic title.
    await expect(page.locator("[data-slot=page-title]"), path).toHaveText(
      path.startsWith("/ar/") ? publicPage.titleArabic : publicPage.title
    );
  }
  for (const path of ["/en/history", "/history/2026-13", "/history/sept"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    const response = await page.request.get(`${englishOrigin}${path}`);
    expect(response.status(), path).toBe(404);
  }
});

test("an address that names no view is not found inside the default page's frame, never the router's default", async ({
  page,
}) => {
  for (const path of [
    "/history/2026-13",
    "/history/sept",
    "/status/nope",
    "/en/status/nope",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    const response = await page.goto(`${englishOrigin}${path}`);
    expect(response?.status(), path).toBe(404);
    await expect(page.locator("[data-slot=view-missing]"), path).toBeVisible();
    await expect(page.locator("[data-slot=page-title]"), path).toHaveText(
      publicPage.title
    );
    // The address names no view, so the switch leads to the page's overview in the other locale.
    await expect(page.locator("[data-slot=page-locale]"), path).toHaveAttribute(
      "href",
      "/ar"
    );
  }
});

test("a framed not-found's links load the page in a new document, never the admin", async ({
  page,
}) => {
  for (const [path, link] of [
    ["/status/nope", "[data-slot=view-overview]"],
    ["/history/2026-13", "[data-slot=page-title] a"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    await page.goto(`${englishOrigin}${path}`);
    await page.waitForFunction(() => window.__reactCommitted === true);
    await page.click(link);
    await expectPath(page, "/");
    await expect(page.locator("[data-slot=page-banner]"), path).toBeVisible();
  }
});

test("a framed not-found keeps its frame when the live refresh would have run", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`${englishOrigin}/status/nope`);
  await page.waitForFunction(() => window.__reactCommitted === true);
  await page.clock.fastForward(60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // Nothing to wait on when nothing refreshes: give a refresh time to land.
  await page.waitForTimeout(1000);
  await expect(page.locator("[data-slot=page-title]")).toHaveText(
    publicPage.title
  );
});

test("a framed not-found takes the document's locale: under the other locale's prefix the frame is the install language's", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/ar/status/nope`);
  await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
  const switcher = page.locator("[data-slot=page-locale]");
  await expect(switcher).toHaveAttribute("lang", "ar");
  await expect(switcher).toHaveAttribute("href", "/ar");
});

test("on an install with no status page an unknown slug is the plain not-found in the install language", async ({
  page,
}) => {
  const response = await page.goto(`${arabicOrigin}/status/missing`);
  expect(response?.status()).toBe(404);
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  await expect(page.locator("[data-slot=view-missing]")).toBeVisible();
  await expect(page.locator("[data-slot=page-title]")).toHaveCount(0);
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0);
});

/** The dir of the nearest element that names one, for every place each text shows on the status page. */
function proseDirections(
  page: Page,
  texts: readonly string[]
): Promise<Record<string, (string | null)[]>> {
  return page.evaluate((wanted) => {
    const found: Record<string, (string | null)[]> = {};
    const root = document.querySelector("[data-slot=status-page]");
    if (!root) {
      return found;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      if (wanted.includes(text)) {
        found[text] = [
          ...(found[text] ?? []),
          node.parentElement?.closest("[dir]")?.getAttribute("dir") ?? null,
        ];
      }
    }
    return found;
  }, texts);
}

test("each locale's view shows the content written in it and the rest in the page language, each in its own locale's direction", async ({
  page,
}) => {
  // Written in English alone, so both views show it, left to right.
  const english = [
    "Live status of the example services",
    publicPage.linkedComponent,
    "The public docs site",
    "Platform",
  ];
  const history = [publicPage.resolvedIncident, publicPage.completedWindow];
  for (const [path, ltr, rtl, absent] of [
    [
      "/ar",
      english,
      [publicPage.titleArabic, publicPage.handComponentArabic],
      [publicPage.title, publicPage.handComponent],
    ],
    [
      "/",
      [...english, publicPage.title, publicPage.handComponent],
      [],
      [publicPage.titleArabic, publicPage.handComponentArabic],
    ],
    ["/ar/history", history, [], []],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    await page.goto(`${englishOrigin}${path}`);
    const directions = await proseDirections(page, [...ltr, ...rtl, ...absent]);
    for (const [texts, wanted] of [
      [ltr, "ltr"],
      [rtl, "rtl"],
    ] as const) {
      for (const text of texts) {
        expect(directions[text], `${text} on ${path}`).toBeDefined();
        for (const dir of directions[text] ?? []) {
          expect(dir, `${text} on ${path}`).toBe(wanted);
        }
      }
    }
    for (const text of absent) {
      expect(directions[text], `${text} on ${path}`).toBeUndefined();
    }
  }
});

test("a malformed escape in a view's address is a bad request, never kept", async ({
  page,
}) => {
  const response = await page.request.get(`${englishOrigin}/incidents/%E0`);
  expect(response.status()).toBe(400);
  expect(response.headers().etag).toBeUndefined();
});

test("the language switch on a not-found keeps the address, in the other locale", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/incidents/nope`);
  await page.click("[data-slot=page-locale]");
  await expectPath(page, "/ar/incidents/nope");
  await expect(page.locator("[data-slot=view-missing]")).toBeVisible();
});

/** A GET, then the same GET holding the ETag the first got: its status. Other specs move this install's counter, so a pair may straddle a change; the poll asks again until one does not. */
async function heldStatus(
  request: APIRequestContext,
  url: string
): Promise<number> {
  const first = await request.get(url);
  const again = await request.get(url, {
    headers: { "if-none-match": first.headers().etag ?? "" },
  });
  return again.status();
}

test("each view and its document are a 304 from the memo on a second visit with no change", async ({
  page,
  request,
}) => {
  const { completed, pageId, resolved } = await ids(request, page);
  for (const path of [
    "/history",
    `/incidents/${resolved}`,
    `/api/pages/${pageId}/history/${thisMonth()}`,
    `/api/pages/${pageId}/incidents/${resolved}`,
    `/api/pages/${pageId}/maintenance/${completed}`,
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    const first = await request.get(`${englishOrigin}${path}`);
    expect(first.status(), path).toBe(200);
    expect(first.headers()["cache-control"], path).toBe(
      "public, max-age=0, must-revalidate"
    );
    await expect
      .poll(() => heldStatus(request, `${englishOrigin}${path}`))
      .toBe(304);
  }
});

test("a view reads its document again every 60 seconds and on focus, never while hidden, holding the ETag", async ({
  page,
  request,
}) => {
  const { pageId, resolved } = await ids(request, page);
  const url = `/api/pages/${pageId}/incidents/${resolved}`;
  const asked: { held: boolean; status: number }[] = [];
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === url) {
      const headers = await response.request().allHeaders();
      asked.push({
        held: "if-none-match" in headers,
        status: response.status(),
      });
    }
  });
  await page.clock.install();
  await page.goto(`${englishOrigin}/incidents/${resolved}`);
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();
  expect(asked).toEqual([]);

  await page.clock.fastForward(60_000);
  await expect.poll(() => asked.length).toBe(1);
  await page.clock.fastForward(60_000);
  await expect.poll(() => asked.length).toBe(2);
  // The first ask after the server's render fills the browser's cache; from then on it holds the ETag.
  expect(asked[1]?.held).toBe(true);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(180_000);
  await page.waitForTimeout(500);
  expect(asked).toHaveLength(2);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => asked.length).toBe(3);
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();
});

test("a failed refresh keeps the view it showed, and the next one mends it", async ({
  page,
  request,
}) => {
  const { pageId, resolved } = await ids(request, page);
  const url = `**/api/pages/${pageId}/incidents/${resolved}`;
  let failed = 0;
  let served = 0;
  page.on("response", (response) => {
    if (response.url().endsWith(`/incidents/${resolved}`)) {
      served += 1;
    }
  });
  await page.clock.install();
  await page.goto(`${englishOrigin}/incidents/${resolved}`);
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();

  // The network drops, then the server answers 503: the page keeps what it showed.
  await page.route(url, async (route) => {
    failed += 1;
    await (failed === 1
      ? route.abort()
      : route.fulfill({ body: "Service Unavailable", status: 503 }));
  });
  await page.clock.fastForward(60_000);
  await expect.poll(() => failed).toBe(1);
  await page.clock.fastForward(60_000);
  await expect.poll(() => failed).toBe(2);
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();
  await expect(page.locator("[data-slot=page-title]")).toHaveText(
    publicPage.title
  );

  await page.unroute(url);
  const before = served;
  await page.clock.fastForward(60_000);
  await expect.poll(() => served).toBeGreaterThan(before);
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();
});

test("the public page and its views load no admin code", async ({ page }) => {
  const scripts: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") {
      scripts.push(response.text());
    }
  });
  await page.goto(`${englishOrigin}/`);
  await page.click("[data-slot=page-history-link]");
  await expect(page.locator("[data-slot=history]")).toBeVisible();
  await page.click("[data-slot=history-entry][data-kind=incident] a");
  await expect(page.locator("[data-slot=incident-view]")).toBeVisible();
  const bodies = await Promise.all(scripts);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.filter((body) => adminWords.test(body))).toEqual([]);
  // The one allowed is the admin guard's own check: TanStack keeps a route's beforeLoad in the client entry.
  const checked = bodies.flatMap((body) => body.match(sessionChecked) ?? []);
  expect(checked.length).toBeLessThanOrEqual(1);
});

test("every view hydrates with no error in the console", async ({
  page,
  request,
}) => {
  const { completed, resolved } = await ids(request, page);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  for (const path of [
    "/history",
    `/incidents/${resolved}`,
    `/maintenance/${completed}`,
    `/ar/incidents/${resolved}`,
    "/incidents/nope",
    "/status/nope",
    "/history/2026-13",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one view at a time
    await page.goto(`${englishOrigin}${path}`);
  }
  expect(errors.filter((each) => !each.includes("404"))).toEqual([]);
});

test("a hover on a link between views reads nothing; only the click fetches the view's document", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/`);
  const histories: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname.endsWith("/history")) {
      histories.push(sent.url());
    }
  });
  await page.hover("[data-slot=page-history-link]");
  // Well past the router's 50 ms hover delay: a preload would have been sent by now.
  await page.waitForTimeout(500);
  expect(histories).toHaveLength(0);
  await page.click("[data-slot=page-history-link]");
  await expect(page.locator("[data-slot=history]")).toBeVisible();
  expect(histories).toHaveLength(1);
});

// The public overview on the built entry, on the
// English server, whose default status page is seeded in English with a
// group, an open incident and a scheduled window (e2e/support/serve-en.ts).
// Nothing here changes that install.

import type { APIRequestContext } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { englishOrigin, publicPage } from "./support/servers.ts";

/** The first time element of a served document and its text. */
const servedTime = /<time dateTime="[^"]+" title="[^"]+">([^<]+)<\/time>/;

test("the bare host shows the default page's overview in its language, with its banner, cards, components and bars", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/`);
  await expectPath(page, "/");
  await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
  await expect(page).toHaveTitle(publicPage.title);
  await expect(page.locator("[data-slot=page-title]")).toHaveText(
    publicPage.title
  );
  await expect(
    page.locator("[data-slot=page-banner][data-level=degraded_performance]")
  ).toBeVisible();
  await expect(
    page.locator("[data-slot=incident-card] [data-impact=minor]")
  ).toBeVisible();
  await expect(
    page.locator("[data-slot=maintenance-card] [data-stage=scheduled]")
  ).toBeVisible();
  await expect(page.locator("[data-slot=page-group]")).toHaveCount(1);
  await expect(page.locator("[data-slot=page-component]")).toHaveCount(2);
  const bar = page.locator("[data-slot=uptime-bar]").first();
  await expect(bar.locator("button")).toHaveCount(90);
});

test("a status colour the page picked fills its level's marks beside words in ink; a level it left keeps its own colours", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/`);
  const picked = "rgb(234, 179, 8)";
  const ink = "oklch(0.19 0.012 178)";
  const components = page.locator("[data-slot=page-component]");
  await expect(
    components.locator(
      "[data-slot=level-icon][data-level=degraded_performance]"
    )
  ).toHaveCSS("color", picked);
  await expect(
    components.locator(
      "[data-slot=component-status][data-level=degraded_performance]"
    )
  ).toHaveCSS("color", ink);
  // The open incident's minor impact shares the degraded colour.
  const minor = page.locator("[data-slot=incident-card] [data-impact=minor]");
  await expect(minor.locator("[data-slot=badge-mark]")).toHaveCSS(
    "color",
    picked
  );
  await expect(minor).toHaveCSS("color", ink);
  await expect(
    components.locator("[data-slot=level-icon][data-level=operational]")
  ).toHaveCSS("color", "rgb(22, 163, 74)");
  await expect(
    components.locator("[data-slot=component-status][data-level=operational]")
  ).toHaveCSS("color", "rgb(22, 101, 52)");
});

test("the other locale sits under its prefix: the chrome changes, and so does the content written in it, the rest in the page language", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/ar`);
  await expectPath(page, "/ar");
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  await expect(page.locator("[data-slot=page-title]")).toHaveText(
    publicPage.titleArabic
  );
  const components = page.locator("[data-slot=page-components]");
  await expect(components).toContainText(publicPage.handComponentArabic);
  await expect(components).not.toContainText(publicPage.handComponent);
  // The linked component has no Arabic name, so the Arabic view shows its English one.
  await expect(components).toContainText(publicPage.linkedComponent);
  await expect(page.locator("[data-slot=page-components] h2")).not.toHaveText(
    "Components"
  );
  // Today is at the left edge in Arabic, the right in English: the bar is a pure mirror.
  const firstCell = await page
    .locator("[data-slot=uptime-bar] button")
    .first()
    .boundingBox();
  const lastCell = await page
    .locator("[data-slot=uptime-bar] button")
    .nth(89)
    .boundingBox();
  expect((lastCell?.x ?? 0) < (firstCell?.x ?? 0)).toBe(true);
});

test("the page's own status names show in its page language only; the other locale keeps the default names", async ({
  page,
}) => {
  const operational = "[data-slot=component-status][data-level=operational]";
  await page.goto(`${englishOrigin}/`);
  await expect(page.locator(operational)).toHaveText(
    publicPage.operationalName
  );
  await page.goto(`${englishOrigin}/ar`);
  await expect(page.locator(operational)).toHaveCount(1);
  await expect(page.locator(operational)).not.toHaveText(
    publicPage.operationalName
  );
});

test("the language switch is a full document load to the other locale's address", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/`);
  await page.click("[data-slot=page-locale]");
  await expectPath(page, "/ar");
  await expect(page.locator("html[lang=ar]")).toHaveCount(1);
});

test("the page's head carries its alternates, its canonical address and its description", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/ar`);
  // Another spec stores this install's own origin as its public address, which makes the links absolute on it and on nothing else.
  const path = async (selector: string) => {
    const href = (await page.locator(selector).getAttribute("href")) ?? "";
    return href.startsWith(englishOrigin)
      ? href.slice(englishOrigin.length)
      : href;
  };
  await expect.poll(() => path("link[rel=canonical]")).toBe("/ar");
  await expect.poll(() => path("link[rel=alternate][hreflang=en]")).toBe("/");
  await expect.poll(() => path("link[rel=alternate][hreflang=ar]")).toBe("/ar");
  await expect(page.locator("meta[name=description]")).toHaveAttribute(
    "content",
    "Live status of the example services"
  );
});

test("/status/<slug> serves the page too; an unknown slug and the page's own prefix are not found", async ({
  page,
}) => {
  const ok = await page.request.get(
    `${englishOrigin}/status/${publicPage.slug}`
  );
  expect(ok.status()).toBe(200);
  for (const path of ["/status/nope", "/en", "/en/status/example", "/fr"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time
    const missing = await page.request.get(`${englishOrigin}${path}`);
    expect(missing.status(), path).toBe(404);
  }
});

/** A GET, then the same GET holding the ETag the first got: its status. Other specs write to this install and its down monitors move the counter, so a pair may straddle a change; the poll asks again until one does not. */
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

test("a second visit with no change is a 304 from the memo, for the page and its document", async ({
  page,
}) => {
  const first = await page.request.get(`${englishOrigin}/`);
  expect(first.status()).toBe(200);
  expect(first.headers()["cache-control"]).toBe(
    "public, max-age=0, must-revalidate"
  );
  expect(first.headers().etag ?? "").not.toBe("");
  await expect
    .poll(() => heldStatus(page.request, `${englishOrigin}/`))
    .toBe(304);

  await page.goto(`${englishOrigin}/`);
  const pageId = await page
    .locator("[data-slot=status-page]")
    .getAttribute("data-page");
  const url = `${englishOrigin}/api/pages/${pageId}/overview`;
  const document = await page.request.get(url);
  expect(document.status()).toBe(200);
  expect((await document.json()).page.title).toEqual({
    ar: publicPage.titleArabic,
    en: publicPage.title,
  });
  await expect.poll(() => heldStatus(page.request, url)).toBe(304);
});

test("times are absolute with their zone in the server's markup and relative after mount", async ({
  page,
}) => {
  const html = await (await page.request.get(`${englishOrigin}/`)).text();
  const served = servedTime.exec(html);
  expect(served?.[1]).toContain("(");
  await page.goto(`${englishOrigin}/`);
  // The update is minutes old: its relative form ("now", "2 minutes ago") has no zone label.
  await expect(
    page.locator("[data-slot=incident-card] time").first()
  ).not.toContainText("(");
});

test("the theme is the page's default with nothing stored, the stored one otherwise, and the switch changes it", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/`);
  await expect(page.locator("html[data-theme=light]")).toHaveCount(1);
  await page.evaluate(() => localStorage.setItem("raaqeb-theme", "dark"));
  await page.reload();
  await expect(page.locator("html[data-theme=dark]")).toHaveCount(1);
  await page
    .locator("[data-slot=page-theme] label:has(input[value=system])")
    .click();
  await expect(page.locator("html[data-theme=system]")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("raaqeb-theme"))).toBe(
    "system"
  );
});

test("the page hydrates with no error in the console", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${englishOrigin}/`);
  await page.goto(`${englishOrigin}/ar`);
  expect(errors).toEqual([]);
});

test("a day's card links the history of the UTC month the day belongs to", async ({
  page,
}) => {
  const monthAgo = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 7);
  await page.goto(`${englishOrigin}/`);
  const cells = page
    .locator("[data-slot=uptime-bar]")
    .first()
    .locator("button");
  const link = page.locator("[data-slot=day-card] [data-slot=day-month]");
  // The bar sits below the fold; a scroll closes an open card, so the scroll lands before the click.
  await cells.last().scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve))
  );
  await cells.last().click();
  await expect(link).toHaveAttribute("href", `/history/${monthAgo(0)}`);
  // The oldest day's month comes before the page's first entry, and is still a history month.
  await cells.first().click();
  await expect(link).toHaveAttribute("href", `/history/${monthAgo(89)}`);
  await link.click();
  await expectPath(page, `/history/${monthAgo(89)}`);
  await expect(
    page.locator(`[data-slot=history][data-month="${monthAgo(89)}"]`)
  ).toBeVisible();
});

test("a day's card opened low on a phone's screen sits above the bar, not at the top of the screen", async ({
  page,
}) => {
  await page.setViewportSize({ height: 700, width: 390 });
  await page.goto(`${englishOrigin}/`);
  const bar = page.locator("[data-slot=uptime-bar]").first();
  // The bar in the screen's lower part, where its card opens upward.
  await bar.evaluate((element) =>
    window.scrollBy(
      0,
      element.getBoundingClientRect().bottom - window.innerHeight + 40
    )
  );
  // A scroll closes an open card, so the scroll lands before the click.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve))
  );
  await bar.locator("button").last().click();
  await expect(page.locator("[data-slot=day-card]")).toBeVisible();
  const card = await page.locator("[data-slot=day-card]").boundingBox();
  const cells = await bar.boundingBox();
  expect(card && cells && card.y + card.height).toBeCloseTo(cells?.y ?? 0, 0);
});

// The status page editor, on the built entry, on the English install: each
// test makes a page of its own, changes it through the editor's controls,
// and reads the result from a browser with no session, as a visitor would.
// The seeded pages other specs read are never touched, and no page here is
// made the default.

import type { Browser, Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { englishOrigin } from "./support/servers.ts";
import {
  handComponent,
  idOf,
  publishedPage,
  runId,
  savePage,
  signIn,
} from "./support/status-page.ts";

const pagePath = /^\/admin\/pages\/[0-9a-f-]{36}$/;

/** A 1 by 1 transparent PNG a browser decodes. */
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** A page in a browser with no session and no theme of its own: a visitor's. */
async function visitorOf(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return await context.newPage();
}

test("every customization the operator saves shows on the public page", async ({
  browser,
  page,
}) => {
  const run = runId();
  const slug = `look-${run}`;
  await signIn(page);
  const componentId = await handComponent(
    page,
    `Look ${run}`,
    "degraded_performance"
  );
  await publishedPage(page, slug, [componentId]);

  await page.click("[data-name=theme] [role=radio][data-value=dark]");
  await page.fill("input[name=brandColour]", "#0055aa");
  await page.fill("input[name=colour-degraded_performance]", "#123456");
  await page.fill("input[name=label-degraded_performance-en]", `Slow ${run}`);
  await page.fill("textarea[name=description-en]", `About ${run}`);
  await page.click("[data-name=barDays] [role=radio][data-value='30']");
  await page.click("label[for=percentages]");
  await page.click("[data-slot=add-footer-link]");
  await page.fill("input[name=footer-0-label-en]", "Docs");
  await page.fill("input[name=footer-0-url]", "https://docs.example.com/");
  await page.click("[data-slot=add-footer-link]");
  await page.fill("input[name=footer-1-label-en]", "Blog");
  await page.fill("input[name=footer-1-url]", "https://blog.example.com/");
  await page.fill("input[name=contactUrl]", "mailto:help@example.com");
  await page.click("label[for=noindex]");
  await page.click("label[for=poweredBy]");
  await page.fill(
    "textarea[name=customCss]",
    "[data-slot=page-title]{letter-spacing:3px}"
  );
  await savePage(page);

  const visitor = await visitorOf(browser);
  await visitor.goto(`${englishOrigin}/status/${slug}`);
  await expect(visitor.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await visitor.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--brand")
        .trim()
    )
  ).toBe("#0055aa");
  const status = visitor.locator(
    `[data-component="${componentId}"] [data-slot=component-status]`
  );
  await expect(status).toHaveText(`Slow ${run}`);
  await expect(
    visitor.locator(
      `[data-slot=page-component][data-component="${componentId}"] [data-slot=level-icon]`
    )
  ).toHaveCSS("color", "rgb(18, 52, 86)");
  await expect(visitor.locator("meta[name=description]")).toHaveAttribute(
    "content",
    `About ${run}`
  );
  await expect(
    visitor.locator("[data-slot=uptime-bar]").first().locator("button")
  ).toHaveCount(30);
  await expect(visitor.locator("[data-slot=uptime-figure]")).toHaveCount(0);
  const links = visitor.locator("[data-slot=page-links]");
  await expect(links.locator("a[href='https://docs.example.com/']")).toHaveText(
    "Docs"
  );
  await expect(links.locator("a[href='https://blog.example.com/']")).toHaveText(
    "Blog"
  );
  await expect(visitor.locator("[data-slot=page-contact]")).toHaveAttribute(
    "href",
    "mailto:help@example.com"
  );
  await expect(visitor.locator("[data-slot=powered-by]")).toHaveCount(0);
  await expect(visitor.locator("meta[name=robots]")).toHaveAttribute(
    "content",
    "noindex"
  );
  await expect(visitor.locator("[data-slot=page-title]")).toHaveCSS(
    "letter-spacing",
    "3px"
  );

  // With the day bar off, no bar shows at all.
  await page.click("label[for=bars]");
  await savePage(page);
  await visitor.reload();
  await expect(visitor.locator("[data-slot=status-page]")).toBeVisible();
  await expect(visitor.locator("[data-slot=uptime-bar]")).toHaveCount(0);
  await visitor.context().close();
});

test("a renamed slug moves the page's address, and a deleted page is gone from the list and from its address", async ({
  page,
  request,
}) => {
  const run = runId();
  const before = `before-${run}`;
  const after = `after-${run}`;
  const statusOf = async (slug: string) =>
    (await request.get(`${englishOrigin}/status/${slug}`)).status();
  await signIn(page);
  const pageId = await publishedPage(page, before, []);
  expect(await statusOf(before)).toBe(200);

  await page.fill("input[name=slug]", after);
  await savePage(page);
  expect([await statusOf(before), await statusOf(after)]).toEqual([404, 200]);

  await page.click("[data-slot=delete-page]");
  await page.click("[data-slot=alert-dialog-cancel]");
  await expect(page.locator("[data-slot=confirm-delete]")).toHaveCount(0);
  await expectPath(page, `/admin/pages/${pageId}`);
  expect(await statusOf(after)).toBe(200);

  await page.click("[data-slot=delete-page]");
  await page.click("[data-slot=confirm-delete]");
  await expectPath(page, "/admin/pages");
  await expect(page.locator("[data-page]").first()).toBeVisible();
  await expect(page.locator(`[data-page="${pageId}"]`)).toHaveCount(0);
  expect(await statusOf(after)).toBe(404);
});

test("the layout's components move up and down, leave the page, and a removed group leaves its components where it was", async ({
  browser,
  page,
}) => {
  const run = runId();
  const slug = `layout-${run}`;
  await signIn(page);
  const first = await handComponent(page, `First ${run}`);
  const second = await handComponent(page, `Second ${run}`);
  const third = await handComponent(page, `Third ${run}`);
  await publishedPage(page, slug, [first, second, third]);
  const layout = () =>
    page
      .locator("[data-slot=page-layout] > [data-component]")
      .evaluateAll((items) => items.map((item) => item.dataset.component));
  const row = (id: string) =>
    page.locator(`[data-slot=page-item][data-component="${id}"]`);

  await row(third).locator("[data-slot=move-up]").click();
  await expect.poll(layout).toEqual([first, third, second]);
  await row(first).locator("[data-slot=move-down]").click();
  await expect.poll(layout).toEqual([third, first, second]);
  await row(second).locator("[data-slot=remove-component]").click();
  await expect.poll(layout).toEqual([third, first]);
  // A component taken off the page can be added again.
  await expect(
    page.locator(`select[name=add-component] option[value="${second}"]`)
  ).toHaveCount(1);

  await page.click("[data-slot=add-page-group]");
  await page.fill("[data-slot=page-group] input[lang=en]", `Group ${run}`);
  await row(third)
    .locator("select[data-slot=move-to]")
    .selectOption({ label: `Group ${run}` });
  await expect(
    page.locator(`[data-slot=page-group] [data-component="${third}"]`)
  ).toBeVisible();
  await page.click("[data-slot=page-group] [data-slot=remove-group]");
  await expect(page.locator("[data-slot=page-group]")).toHaveCount(0);
  await savePage(page);

  await page.reload();
  await expect.poll(layout).toEqual([first, third]);
  const visitor = await visitorOf(browser);
  await visitor.goto(`${englishOrigin}/status/${slug}`);
  await expect(visitor.locator("[data-slot=page-group]")).toHaveCount(0);
  expect(
    await visitor
      .locator("[data-slot=page-component]")
      .evaluateAll((rows) => rows.map((each) => each.dataset.component))
  ).toEqual([first, third]);
  await visitor.context().close();
});

test("a favicon and a cover reach the public page's head, and a removed logo leaves the editor and the page", async ({
  browser,
  page,
}) => {
  const run = runId();
  const slug = `images-${run}`;
  await signIn(page);
  const pageId = await publishedPage(page, slug, []);
  for (const kind of ["logo", "favicon", "cover"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one upload at a time, as an operator picks files
    await page.setInputFiles(`input[name=image-${kind}]`, {
      buffer: png,
      mimeType: "image/png",
      name: `${kind}.png`,
    });
    await expect(
      page.locator(`[data-image=${kind}] [data-slot=page-image-preview]`)
    ).toBeVisible();
  }

  const visitor = await visitorOf(browser);
  await visitor.goto(`${englishOrigin}/status/${slug}`);
  await expect(visitor.locator("link[rel=icon]")).toHaveAttribute(
    "href",
    new RegExp(`^/api/pages/${pageId}/favicon`)
  );
  await expect(visitor.locator("meta[property='og:image']")).toHaveAttribute(
    "content",
    new RegExp(`/api/pages/${pageId}/cover`)
  );
  await expect(
    visitor.locator("[data-slot=status-page] header img")
  ).toHaveCount(1);

  await page.click("[data-image=logo] [data-slot=remove-image]");
  await expect(
    page.locator("[data-image=logo] [data-slot=page-image-preview]")
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.locator("[data-image=logo] [data-slot=page-image-preview]")
  ).toHaveCount(0);
  await expect(
    page.locator("[data-image=favicon] [data-slot=page-image-preview]")
  ).toBeVisible();
  await visitor.reload();
  await expect(visitor.locator("[data-slot=status-page]")).toBeVisible();
  await expect(
    visitor.locator("[data-slot=status-page] header img")
  ).toHaveCount(0);
  await visitor.context().close();
});

test("a bad slug, a script contact link and a footer link that is not web or mail are refused on their fields and not stored; a page no one subscribed to says so", async ({
  page,
}) => {
  const run = runId();
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/pages/new`);
  await page.fill("input[name=title]", `Refusals ${run}`);
  await page.fill("input[name=slug]", "Bad Slug!");
  await page.click("[data-slot=new-page-form] button[type=submit]");
  await expect(page.locator("input[name=slug]")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  await expectPath(page, "/admin/pages/new");
  await page.fill("input[name=slug]", `refusals-${run}`);
  await page.click("[data-slot=new-page-form] button[type=submit]");
  const pageId = await idOf(page, pagePath);

  await page.fill("input[name=slug]", "Bad Slug!");
  await page.fill("input[name=contactUrl]", "javascript:alert(1)");
  await page.click("[data-slot=add-footer-link]");
  await page.fill("input[name=footer-0-label-en]", "Files");
  await page.fill("input[name=footer-0-url]", "ftp://files.example.com");
  await page.click("[data-slot=save-page]");
  await expect(
    page.locator("[data-slot=save-outcome][data-reason=invalid]")
  ).toBeVisible();
  await expect(page.locator("input[name=slug]")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  await expect(
    page.locator("[data-error-for='customization.contactUrl']")
  ).toBeVisible();
  await expect(page.locator("input[name=contactUrl]")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  await expect(
    page.locator("[data-error-for='customization.footerLinks.0.url']")
  ).toBeVisible();

  await page.goto(`${englishOrigin}/admin/pages/${pageId}`);
  await expect(page.locator("input[name=slug]")).toHaveValue(`refusals-${run}`);
  await expect(page.locator("input[name=contactUrl]")).toHaveValue("");
  await expect(page.locator("[data-slot=footer-link]")).toHaveCount(0);

  await page.click("[data-slot=page-subscribers-link]");
  await expectPath(page, `/admin/pages/${pageId}/subscribers`);
  await expect(page.locator("[data-slot=subscribers-empty]")).toBeVisible();
  await expect(page.locator("[data-slot=subscriber]")).toHaveCount(0);
});

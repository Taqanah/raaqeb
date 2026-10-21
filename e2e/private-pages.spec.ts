// Private pages, on the built entry, on the English install: each test
// makes a page of its own, sets its access through the editor, and opens it
// from a browser with no session, as a visitor would.

import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { englishOrigin } from "./support/servers.ts";
import {
  handComponent,
  publishedPage,
  runId,
  savePage,
  signIn,
} from "./support/status-page.ts";

/** Where the visitor's page is; a visitor's context has no hydration hook, so the path alone is read. */
function pathOf(visitor: Page): string {
  return new URL(visitor.url()).pathname;
}

/** A visitor's page: no session, its own client address. */
async function visitorOf(browser: Browser, address: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": address },
  });
  return await context.newPage();
}

test("a visitor enters the page password to see a private page, a wrong one says so, and a new password asks again", async ({
  address,
  browser,
  page,
}) => {
  const run = runId();
  const slug = `private-${run}`;
  const component = `Vault ${run}`;
  await signIn(page);
  const componentId = await handComponent(page, component);
  await publishedPage(page, slug, [componentId]);
  await page.click("[data-name=accessMode] [role=radio][data-value=password]");
  await page.fill("input[name=accessPassword]", "correct horse");
  await savePage(page);

  const visitor = await visitorOf(browser, address);
  const first = await visitor.goto(`${englishOrigin}/status/${slug}`);
  expect(first?.status()).toBe(403);
  expect(first?.headers()["cache-control"]).toBe("private, no-store");
  await expect(visitor.locator("[data-slot=access-page]")).toBeVisible();
  await expect(visitor.getByText(component)).toHaveCount(0);
  await expect(visitor.locator("meta[name=robots]")).toHaveAttribute(
    "content",
    "noindex"
  );

  await visitor.fill("input[name=password]", "wrong horse");
  await visitor.click("[data-slot=access-open]");
  await expect(visitor.locator("[data-slot=access-wrong]")).toBeVisible();
  await expect(visitor.getByText(component)).toHaveCount(0);

  await visitor.fill("input[name=password]", "correct horse");
  await visitor.click("[data-slot=access-open]");
  await expect.poll(() => pathOf(visitor)).toBe(`/status/${slug}`);
  await expect(visitor.getByText(component)).toBeVisible();
  // The pass holds across the page's views.
  await visitor.click("[data-slot=page-history-link]");
  await expect.poll(() => pathOf(visitor)).toBe(`/status/${slug}/history`);
  await expect(visitor.locator("[data-slot=access-page]")).toHaveCount(0);

  await page.fill("input[name=accessPassword]", "battery staple");
  await savePage(page);
  await visitor.goto(`${englishOrigin}/status/${slug}`);
  await expect(visitor.locator("[data-slot=access-page]")).toBeVisible();
  await visitor.context().close();
});

test("a page for signed-in users shows itself to the operator and the way to sign in to a visitor", async ({
  address,
  browser,
  page,
}) => {
  const run = runId();
  const slug = `team-${run}`;
  const component = `Team ${run}`;
  await signIn(page);
  const componentId = await handComponent(page, component);
  await publishedPage(page, slug, [componentId]);
  await page.click("[data-name=accessMode] [role=radio][data-value=signed_in]");
  await savePage(page);

  await page.goto(`${englishOrigin}/status/${slug}`);
  await expect(page.getByText(component)).toBeVisible();

  const visitor = await visitorOf(browser, address);
  await visitor.goto(`${englishOrigin}/status/${slug}`);
  await expect(visitor.locator("[data-slot=access-page]")).toBeVisible();
  await expect(visitor.locator("[data-slot=access-sign-in]")).toBeVisible();
  await expect(visitor.locator("input[name=password]")).toHaveCount(0);
  await expect(visitor.getByText(component)).toHaveCount(0);
  await visitor.context().close();
});

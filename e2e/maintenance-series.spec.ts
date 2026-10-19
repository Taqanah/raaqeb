// A maintenance series on the built entry, signed in on the English
// server: created with the recurrence picker, its occurrences listed as
// ordinary windows, one cancelled on its own while the series and its
// others stay, then the series ended. On a component of its own.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";

const run = Date.now().toString(36);
const componentPath = /^\/admin\/components\/[0-9a-f-]{36}$/;
const seriesPath = /^\/admin\/maintenance\/series\/[0-9a-f-]{36}$/;

async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

async function pathOf(page: Page, pattern: RegExp): Promise<string> {
  await expect.poll(() => new URL(page.url()).pathname).toMatch(pattern);
  return new URL(page.url()).pathname;
}

test("a weekly series schedules its week as windows; one cancelled on its own leaves the series and the others, and ending the series cancels the rest", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/components/new`);
  await page.fill("input[name=name-en]", `Backups ${run}`);
  await page.click("[data-slot=save-component]");
  const componentId = (await pathOf(page, componentPath)).split("/").at(-1);

  await page.goto(`${englishOrigin}/admin/maintenance/new`);
  await page.fill("input[name=title-en]", `Nightly upkeep ${run}`);
  await page.fill("textarea[name=message-en]", "We rotate the backups.");
  await page.click("[data-slot=repeat] [data-value=weekly]");
  // Every day, so the coming week holds seven occurrences whenever the test runs.
  for (const weekday of ["0", "1", "2", "3", "4", "5", "6"]) {
    const box = page.locator(
      `[data-slot=weekday][data-weekday="${weekday}"] [role=checkbox]`
    );
    // biome-ignore lint/performance/noAwaitInLoops: one click after another, as the operator ticks them
    if ((await box.getAttribute("aria-checked")) !== "true") {
      await box.click();
    }
  }
  await page
    .locator(
      `[data-slot=window-component][data-component="${componentId}"] label`
    )
    .click();
  await page.click("[data-slot=create-window]");
  const series = await pathOf(page, seriesPath);

  const occurrences = page.locator("[data-slot=series-occurrence]");
  await expect(occurrences).toHaveCount(7);
  const first = occurrences.first().locator("a");
  const firstPath = (await first.getAttribute("href")) ?? "";
  const secondPath =
    (await occurrences.nth(1).locator("a").getAttribute("href")) ?? "";

  // The occurrence is an ordinary window, which says which series it is of.
  await first.click();
  await expectPath(page, firstPath);
  await expect(
    page.locator(`[data-slot=window-series] a[href="${series}"]`)
  ).toBeVisible();
  await page.click("[data-slot=cancel-window]");
  await page.click("[data-slot=confirm-cancel]");
  await expectPath(page, "/admin/maintenance");

  await page.goto(`${englishOrigin}${series}`);
  await expect(occurrences).toHaveCount(6);
  await expect(occurrences.first().locator("a")).toHaveAttribute(
    "href",
    secondPath
  );

  await page.click("[data-slot=end-series]");
  await page.click("[data-slot=confirm-end-series]");
  await expectPath(page, "/admin/maintenance");
  await expect(page.locator(`a[href="${series}"]`)).toHaveCount(0);
  await expect(page.locator(`a[href="${secondPath}"]`)).toHaveCount(0);
});

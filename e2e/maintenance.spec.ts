// The maintenance screens, on the built entry, signed in on the
// English server, whose scheduler ticks every second. The two windows on
// one component run in order; the refusals need no window.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";
import { startingNow, wallTime } from "./support/status-page.ts";

const run = Date.now().toString(36);
const componentName = `Payments ${run}`;
const componentPath = /^\/admin\/components\/[0-9a-f-]{36}$/;
const windowPath = /^\/admin\/maintenance\/[0-9a-f-]{36}$/;

async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

async function idOf(page: Page, pattern: RegExp): Promise<string> {
  await expect.poll(() => new URL(page.url()).pathname).toMatch(pattern);
  return new URL(page.url()).pathname.split("/").at(-1) ?? "";
}

/** Reads the window's page until its stage is the one given; the scheduler moves it at its next tick. */
async function stageBecomes(
  page: Page,
  path: string,
  stage: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(`${englishOrigin}${path}`);
        return await page
          .locator("[data-slot=window-summary] [data-slot=window-stage]")
          .getAttribute("data-stage");
      },
      { timeout: 20_000 }
    )
    .toBe(stage);
}

let componentId = "";
let monitorId = "";

test.describe("two windows on one component", () => {
  test.describe.configure({ mode: "serial" });

  test("a window scheduled for later lists as scheduled, takes every field, and may be cancelled", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/components/new`);
    await page.fill("input[name=name-en]", componentName);
    const website = page.locator("[data-slot=component-monitor]", {
      hasText: "Website",
    });
    monitorId = (await website.getAttribute("data-monitor")) ?? "";
    await website.locator("label").click();
    await page.click("[data-slot=save-component]");
    componentId = await idOf(page, componentPath);

    await page.goto(`${englishOrigin}/admin/maintenance/new`);
    await page.fill("input[name=title-en]", `Database upgrade ${run}`);
    await page.fill("textarea[name=message-en]", "We move the database.");
    await page
      .locator(
        `[data-slot=window-component][data-component="${componentId}"] label`
      )
      .click();
    await page.click("[data-slot=create-window]");
    await idOf(page, windowPath);
    const path = new URL(page.url()).pathname;
    await expect(
      page.locator("[data-slot=window-summary] [data-slot=window-stage]")
    ).toHaveAttribute("data-stage", "scheduled");

    await page.fill("input[name=title-en]", `Database upgrade, renamed ${run}`);
    await page.click("[data-slot=save-window]");
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toBeVisible();

    await page.goto(`${englishOrigin}/admin/maintenance`);
    await expect(page.locator(`[data-window] a[href="${path}"]`)).toHaveText(
      `Database upgrade, renamed ${run}`
    );

    await page.goto(`${englishOrigin}${path}`);
    await page.click("[data-slot=cancel-window]");
    await page.click("[data-slot=confirm-cancel]");
    await expectPath(page, "/admin/maintenance");
    await expect(page.locator(`a[href="${path}"]`)).toHaveCount(0);
  });

  test("a window from now starts at the scheduler's next tick: its component is under maintenance and its monitor shows it; ending it now completes it", async ({
    page,
  }) => {
    // Two scheduler waits of up to 20 s each pass the default 30 s.
    test.setTimeout(60_000);
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/maintenance/new`);
    const zone =
      (await page
        .locator("[data-slot=window-zone]")
        .getAttribute("data-zone")) ?? "UTC";
    await page.fill("input[name=title-en]", `Network work ${run}`);
    await page.fill("textarea[name=message-en]", "We replace a switch.");
    await page.fill("input[name=starts]", startingNow(zone));
    await page.fill(
      "input[name=ends]",
      wallTime(Date.now() + 30 * 60_000, zone)
    );
    await page
      .locator(
        `[data-slot=window-component][data-component="${componentId}"] label`
      )
      .click();
    await page.click("[data-slot=create-window]");
    await idOf(page, windowPath);
    const path = new URL(page.url()).pathname;
    await stageBecomes(page, path, "in_progress");
    await expect(page.locator("[data-slot=window-locked]")).toBeVisible();
    // Started, the start is no longer a field; the summary above shows it.
    await expect(page.locator("input[name=starts]")).toHaveCount(0);
    await expect(page.locator("input[name=ends]")).toBeEnabled();

    await page.goto(`${englishOrigin}/admin/components/${componentId}`);
    await expect(
      page.locator("[data-slot=component-status][data-level=under_maintenance]")
    ).toBeVisible();
    await expect(
      page.locator(`[data-slot=component-maintenance] a[href="${path}"]`)
    ).toBeVisible();

    await page.goto(`${englishOrigin}/admin/monitors`);
    await expect(
      page.locator(
        `[data-monitor="${monitorId}"] [data-slot=monitor-maintenance]`
      )
    ).toBeVisible();

    await page.goto(`${englishOrigin}${path}`);
    await page.click("[data-slot=end-window]");
    await page.click("[data-slot=confirm-end]");
    await stageBecomes(page, path, "completed");
    await expect(page.locator("input[name=ends]")).toHaveCount(0);

    await page.goto(`${englishOrigin}/admin/monitors`);
    await expect(
      page.locator(
        `[data-monitor="${monitorId}"] [data-slot=monitor-maintenance]`
      )
    ).toHaveCount(0);
  });
});

test("a window that ends before it starts, or starts in the past, is refused on that field and not stored", async ({
  page,
}) => {
  const hour = 3_600_000;
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/maintenance/new`);
  const zone =
    (await page.locator("[data-slot=window-zone]").getAttribute("data-zone")) ??
    "UTC";
  const starts = page.locator("input[name=starts]");
  const ends = page.locator("input[name=ends]");
  await page.fill("input[name=title-en]", `Backwards ${run}`);
  await page.fill("textarea[name=message-en]", "Ends first.");
  await starts.fill(wallTime(Date.now() + 2 * hour, zone));
  await ends.fill(wallTime(Date.now() + hour, zone));
  await page.click("[data-slot=create-window]");
  await expect(ends).toHaveAttribute("aria-invalid", "true");
  await expect(starts).not.toHaveAttribute("aria-invalid", "true");

  await starts.fill(wallTime(Date.now() - 2 * hour, zone));
  await page.click("[data-slot=create-window]");
  await expect(starts).toHaveAttribute("aria-invalid", "true");
  await expect(ends).not.toHaveAttribute("aria-invalid", "true");
  await expectPath(page, "/admin/maintenance/new");
});

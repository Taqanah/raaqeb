// The admin with Arabic chrome, on an install of its own whose language is
// Arabic, the default: an operator's first records written in Arabic, on a
// desktop and on a phone. The English install's language stays as other specs read it.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
const uuid = "[0-9a-f-]{36}";
const monitorPath = new RegExp(`^/admin/monitors/${uuid}$`);
const componentPath = new RegExp(`^/admin/components/${uuid}$`);
const pagePath = new RegExp(`^/admin/pages/${uuid}$`);
const incidentPath = new RegExp(`^/admin/incidents/${uuid}$`);

let install: Install | undefined;
let origin = "";
let incident = "";

test.beforeAll(async () => {
  install = await spawnInstall({ account: true });
  ({ origin } = install);
});

test.afterAll(async () => {
  await install?.stop();
});

async function signIn(page: Page, at: string): Promise<void> {
  await page.goto(`${at}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

async function pathMatching(page: Page, pattern: RegExp): Promise<string> {
  await expect.poll(() => new URL(page.url()).pathname).toMatch(pattern);
  return new URL(page.url()).pathname;
}

/** Collects every console error and uncaught page error from now on. */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Whether the page is no wider than the screen, so nothing scrolls sideways. */
function fitsTheScreen(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
}

test("in Arabic the operator adds a monitor, a component, a status page and an incident, each written in Arabic, with no console error", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await signIn(page, origin);
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);

  await page.goto(`${origin}/admin/monitors/new`);
  await page.fill("input[name=name]", `واجهة الدفع ${run}`);
  await page.fill("input[name=url]", "http://127.0.0.1:1/");
  await page.click("[data-slot=save-monitor]");
  await pathMatching(page, monitorPath);

  await page.goto(`${origin}/admin/components/new`);
  // The install language's field comes first and writes right to left; the other is optional.
  await expect(page.locator("input[name=name-ar][dir=rtl]")).toHaveCount(1);
  await expect(page.locator("input[name=name-en][dir=ltr]")).toHaveCount(1);
  await page.fill("input[name=name-ar]", `الدفع ${run}`);
  await page.click("[data-slot=save-component]");
  const component = (await pathMatching(page, componentPath)).split("/").at(-1);

  await page.goto(`${origin}/admin/pages/new`);
  await page.fill("input[name=title]", `حالة المتجر ${run}`);
  await page.fill("input[name=slug]", `ar-${run}`);
  await page.click("[data-slot=new-page-form] button[type=submit]");
  await pathMatching(page, pagePath);
  await page.selectOption("select[name=add-component]", component ?? "");
  await page.click("[data-slot=save-page]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();

  await page.goto(`${origin}/admin/incidents/new`);
  await expect(page.locator("input[name=title-ar][dir=rtl]")).toHaveCount(1);
  await page.fill("input[name=title-ar]", `تعطل الدفع ${run}`);
  await page.fill("textarea[name=message-ar]", "نتحرى السبب.");
  await page.click(`[data-component="${component}"] [role=checkbox]`);
  await page.click("[data-slot=create-incident]");
  incident = await pathMatching(page, incidentPath);
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("the toast region is labelled in the admin's language", async ({
  page,
}) => {
  // The toast library's own label is English, so an Arabic admin must pass its own.
  await signIn(page, englishOrigin);
  const english = await page
    .locator("[data-slot=toasts]")
    .getAttribute("aria-label");
  await signIn(page, origin);
  await expect(page.locator("[data-slot=toasts]")).not.toHaveAttribute(
    "aria-label",
    english ?? ""
  );
});

test.describe("on a phone", () => {
  // A touch screen, so the pointer is coarse as on a real phone.
  test.use({ hasTouch: true, viewport: { height: 844, width: 390 } });

  test("in Arabic the sheet, the monitor form and the incident page fit the screen, Save is in reach, and no keyboard hint shows", async ({
    page,
  }) => {
    await signIn(page, origin);
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
    // A touch screen has no key to press.
    await expect(
      page.locator("[data-slot=new-monitor] [data-slot=kbd]")
    ).toBeHidden();
    await expect(
      page.locator("[data-slot=palette-trigger] [data-slot=kbd-group]")
    ).toBeHidden();

    await page.click("[data-slot=sidebar-trigger]");
    const sheet = page.locator("[data-slot=sidebar][data-mobile=true]");
    await expect(sheet).toBeVisible();
    await sheet.locator("a[data-nav=monitors]").click();
    await expect(sheet).toHaveCount(0);
    await page.click("[data-slot=new-monitor]");
    await expectPath(page, "/admin/monitors/new");
    expect(await fitsTheScreen(page)).toBe(true);
    await page.fill("input[name=name]", `فحص الهاتف ${run}`);
    await page.fill("input[name=url]", "http://127.0.0.1:1/");
    await page.locator("[data-slot=save-monitor]").tap();
    await pathMatching(page, monitorPath);
    expect(await fitsTheScreen(page)).toBe(true);

    await page.goto(`${origin}${incident}`);
    await expect(page.locator("[data-slot=incident-summary]")).toBeVisible();
    expect(await fitsTheScreen(page)).toBe(true);
  });
});

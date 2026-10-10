// The first run of an install of the test's own: onboarding in Arabic on a
// phone, and the empty state of every list a new install shows. Each test
// spawns its own install, so neither depends on the other or on the shared
// servers.

import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { spawnInstall } from "./support/spawn.ts";

const continueButton = "form button[type=submit]";
const rtl = "html[lang=ar][dir=rtl]";

test("a new install is onboarded in Arabic on a phone, the account screen refusing an empty form, a malformed email and a short password before it creates the account", async ({
  page,
}) => {
  const install = await spawnInstall();
  try {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto(`${install.origin}/`);
    await expectPath(page, "/onboarding");
    await expect(page.locator(rtl)).toHaveCount(1);
    await page.click(continueButton);
    await expectPath(page, "/onboarding/database");
    await expect(page.locator(rtl)).toHaveCount(1);
    await page.click(continueButton);
    await expectPath(page, "/onboarding/account");
    await expect(page.locator(rtl)).toHaveCount(1);

    // The browser refuses these before the form posts (no `noValidate`), so the install stays in onboarding.
    const email = page.locator("input[name=email]");
    const password = page.locator("input[name=password]");
    await page.click(continueButton);
    await expect(page.locator("input[name=email]:invalid")).toHaveCount(1);
    await expect(page.locator("input[name=password]:invalid")).toHaveCount(1);
    await email.fill("notanemail");
    await password.fill("12345");
    await page.click(continueButton);
    await expect(page.locator("input[name=email]:invalid")).toHaveCount(1);
    await expect(page.locator("input[name=password]:invalid")).toHaveCount(1);
    await expectPath(page, "/onboarding/account");
    expect(
      (await page.request.get(`${install.origin}/onboarding`)).status()
    ).toBe(200);

    await email.fill(operatorEmail);
    await password.fill(operatorPassword);
    await expect(page.locator("form :invalid")).toHaveCount(0);
    await page.click(continueButton);
    await expectPath(page, "/admin/monitors");
    await expect(page.locator(rtl)).toHaveCount(1);
    await expect(page.locator("main [data-slot=empty]")).toHaveCount(1);
    // Nothing on the phone runs wider than the screen.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  } finally {
    await install.stop();
  }
});

test("every list of a new install shows its empty state, and an incident or a window cannot be published before a component exists", async ({
  page,
}) => {
  const install = await spawnInstall({ account: true });
  try {
    await page.goto(`${install.origin}/sign-in`);
    await page.fill("input[name=email]", operatorEmail);
    await page.fill("input[name=password]", operatorPassword);
    await page.click(continueButton);
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("main [data-slot=empty]")).toHaveCount(1);

    for (const list of ["components", "pages", "channels"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one screen after the other
      await page.goto(`${install.origin}/admin/${list}`);
      await expect(page.locator("main [data-slot=empty]")).toHaveCount(1);
    }
    // An incident and a window each need a component, and the empty list says so before anything else.
    for (const list of ["incidents", "maintenance"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one screen after the other
      await page.goto(`${install.origin}/admin/${list}`);
      await expect(
        page.locator("main [data-slot=empty] [data-slot=needs-component]")
      ).toHaveCount(1);
      await expect(
        page.locator("main [data-slot=empty] a[href='/admin/components/new']")
      ).toHaveCount(1);
    }
    await page.goto(`${install.origin}/admin/incidents/new`);
    await expect(page.locator("[data-slot=needs-component]")).toHaveCount(1);
    await expect(page.locator("[data-slot=create-incident]")).toBeDisabled();
    await page.goto(`${install.origin}/admin/maintenance/new`);
    await expect(page.locator("[data-slot=needs-component]")).toHaveCount(1);
    await expect(page.locator("[data-slot=create-window]")).toBeDisabled();
  } finally {
    await install.stop();
  }
});

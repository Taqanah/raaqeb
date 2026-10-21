// The audit log on an install of its own: the owner's sign-in and a change
// made on a settings page are entries naming the owner, a refused sign-in is
// one naming the email typed, and the kind filter keeps the sign-ins alone.

import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

test.describe("the audit log", () => {
  let install: Install | undefined;
  test.beforeAll(async () => {
    install = await spawnInstall({ account: true, language: "en" });
  });
  test.afterAll(async () => {
    await install?.stop();
  });

  test("records the owner's sign-in and change and a refused sign-in, and filters by kind", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await page.goto(`${origin}/sign-in`);
    await page.fill("input[name=email]", "who@example.com");
    await page.fill("input[name=password]", "a wrong password");
    await page.click("form button[type=submit]");
    await expect(
      page.locator("[data-failure=invalid_credentials]")
    ).toBeVisible();
    await page.fill("input[name=email]", operatorEmail);
    await page.fill("input[name=password]", operatorPassword);
    await page.click("form button[type=submit]");
    await expectPath(page, "/admin/monitors");
    await page.goto(`${origin}/admin/settings/storage`);
    await page.fill("input[name=retentionDays]", "60");
    await page.click("[data-slot=storage-form] button[type=submit]");
    await expect(page.locator("[data-slot=save-outcome]")).toBeVisible();

    await page.click("a[data-nav=audit]");
    await expectPath(page, "/admin/audit");
    const entries = page.locator("[data-slot=audit-entry]");
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toHaveAttribute(
      "data-action",
      "storage.change"
    );
    await expect(entries.nth(0)).toContainText(operatorEmail);
    await expect(entries.nth(1)).toHaveAttribute(
      "data-action",
      "sign_in.succeed"
    );
    await expect(entries.nth(2)).toHaveAttribute(
      "data-action",
      "sign_in.refuse"
    );
    await expect(entries.nth(2)).toContainText("who@example.com");
    await expect(entries.nth(2)).not.toContainText("a wrong password");

    await page.selectOption("select[name=kind]", "sign_in");
    await expect(entries).toHaveCount(2);
  });
});

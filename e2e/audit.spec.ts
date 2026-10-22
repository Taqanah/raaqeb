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

test.describe("the audit log with a bulk change", () => {
  let install: Install | undefined;
  test.beforeAll(async () => {
    install = await spawnInstall({
      account: true,
      language: "en",
      records: async (storage) => {
        await storage.audit.append({
          action: "monitor.pause",
          actorEmail: operatorEmail,
          actorId: null,
          address: "203.0.113.7",
          at: Date.now(),
          detail: {},
          id: "01a160c1-0000-7000-8000-000000000001",
          targetId: Array.from(
            { length: 6 },
            (_, index) => `01a160c1-6b8e-757c-89dd-223cb29cae4${index}`
          ).join(","),
        });
      },
    });
  });
  test.afterAll(async () => {
    await install?.stop();
  });

  test("a bulk change's target ids wrap, so the address and time columns stay inside the table at 1280 px", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await page.goto(`${origin}/sign-in`);
    await page.fill("input[name=email]", operatorEmail);
    await page.fill("input[name=password]", operatorPassword);
    await page.click("form button[type=submit]");
    await expectPath(page, "/admin/monitors");
    await page.goto(`${origin}/admin/audit`);
    await expect(page.locator("[data-slot=audit-entry]")).toHaveCount(2);
    expect(
      await page
        .locator("[data-slot=audit-entries]")
        .evaluate(
          (table) =>
            table.scrollWidth <= (table.parentElement?.clientWidth ?? 0)
        )
    ).toBe(true);
  });
});

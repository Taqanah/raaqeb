// The API keys page on an install of its own: the operator makes a key,
// sees it once, calls the management API with it, and revokes it.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

let install: Install;

test.beforeAll(async () => {
  install = await spawnInstall({ account: true, language: "en" });
});

test.afterAll(async () => {
  await install.stop();
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`${install.origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

const list = (secret: string) =>
  fetch(`${install.origin}/api/v1/monitors`, {
    headers: { authorization: `Bearer ${secret}` },
  });

const secretShape = /^rqk_/;

test("an operator makes a key, sees it once, calls the API with it, and revokes it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${install.origin}/admin/settings/api-keys`);
  await page.fill("[data-slot=api-key-form] input[name=name]", "Deploy job");
  await page.selectOption("[data-slot=api-key-form] select[name=role]", {
    value: "viewer",
  });
  await page.selectOption(
    "[data-slot=api-key-form] select[name=expiresInDays]",
    { value: "30" }
  );
  await page.click("[data-slot=api-key-create]");
  const shown = page.locator("[data-slot=api-key-secret]");
  await expect(shown).toHaveCount(1);
  const secret = (await shown.textContent()) ?? "";
  expect(secret).toMatch(secretShape);

  const answered = await list(secret);
  expect(answered.status).toBe(200);
  expect(await answered.json()).toMatchObject({ items: [], total: 0 });

  await page.click("[data-slot=api-key-done]");
  await expect(page.locator("[data-slot=api-key-secret]")).toHaveCount(0);
  const row = page.locator("[data-slot=own-keys] [data-slot=api-key]");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Deploy job");
  await page.reload();
  await expect(page.locator("body")).not.toContainText(secret);
  // The call above is its last use, shown with the address it came from.
  await expect(row.locator("[data-slot=api-key-last-used]")).toHaveCount(1);

  await row.locator("[data-slot=api-key-revoke]").click();
  await page.click("[data-slot=api-key-revoke-confirm]");
  await expect(row).toHaveCount(0);
  expect((await list(secret)).status).toBe(401);
});

// A form sent before the page's scripts have run, as a quick hand on a slow
// network or a test driver does: the press waits for them, so nothing typed
// is lost and the first press after they run goes through. On an install of
// its own, so the account is this spec's.

import type { Page } from "@playwright/test";
import { expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

let install: Install | undefined;
let origin = "";

test.beforeAll(async () => {
  install = await spawnInstall({
    account: true,
    language: "en",
  });
  ({ origin } = install);
});

test.afterAll(async () => {
  await install?.stop();
});

/** Opens the address with its scripts held back; the returned function lets them load. */
async function openBeforeScripts(
  page: Page,
  address: string
): Promise<() => void> {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*.js", async (route) => {
    await held;
    await route.continue();
  });
  // The frame's own goto: the harness's page.goto waits for hydration, which the held scripts never allow.
  await page.mainFrame().goto(address, { waitUntil: "commit" });
  return release;
}

test("a sign-in sent before the page's scripts run keeps the email and password, and the first press after goes through", async ({
  page,
}) => {
  const release = await openBeforeScripts(page, `${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.press("input[name=password]", "Enter");
  release();
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
});

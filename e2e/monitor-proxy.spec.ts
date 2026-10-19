// An HTTP monitor's own proxy in the form, on an install of its own: "test now"
// reaches a target that has no address of its own through the recording proxy
// the spec runs, with the proxy's user name and password, and the edit form
// shows the proxy and its user name but never its password.

import type { Page } from "@playwright/test";
import { startProxy, type TestProxy } from "@/server/checks/proxy-fixture.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

const editPath = /^\/admin\/monitors\/[^/]+\/edit$/;
const anyText = /\S/;
const detailPath = /^\/admin\/monitors\/[0-9a-f-]{36}$/;

let install: Install;
let proxy: TestProxy;

test.beforeAll(async () => {
  install = await spawnInstall({ account: true, language: "en" });
  proxy = startProxy();
});

test.afterAll(async () => {
  proxy.stop();
  await install.stop();
});

async function signIn(page: Page, path: string): Promise<void> {
  await page.goto(`${install.origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
  await page.goto(`${install.origin}${path}`);
  await expect(page.locator("[data-slot=monitor-form]")).toBeVisible();
}

test("a monitor's own proxy carries its test and its check, and the edit form shows the address and the user name, never the password", async ({
  page,
}) => {
  await signIn(page, "/admin/monitors/new");
  await page.fill("input[name=name]", "Through a proxy");
  // A host that resolves nowhere: only the proxy can answer for it.
  await page.fill("input[name=url]", "http://web.proxied.test:8080/health");
  await expect(page.locator("input[name=proxyUser]")).toHaveCount(0);
  await page.fill("input[name=proxy]", proxy.url);
  await page.fill("input[name=proxyUser]", "ops");
  await page.fill("input[name=proxyPassword]", "proxy-secret-9");
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-result][data-result=up]")
  ).toBeVisible();
  const [request] = proxy.requests;
  expect(request?.line).toBe(
    "GET http://web.proxied.test:8080/health HTTP/1.1"
  );
  expect(request?.headers["proxy-authorization"]).toBe(
    `Basic ${btoa("ops:proxy-secret-9")}`
  );

  // A saved monitor is due at once, so the scheduler's first check comes through the proxy too, with the same credentials.
  const tested = proxy.requests.length;
  await page.click("[data-slot=save-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
  await expect.poll(() => proxy.requests.length).toBeGreaterThan(tested);
  const scheduled = proxy.requests.at(-1);
  expect(scheduled?.line).toBe(
    "GET http://web.proxied.test:8080/health HTTP/1.1"
  );
  expect(scheduled?.headers["proxy-authorization"]).toBe(
    `Basic ${btoa("ops:proxy-secret-9")}`
  );
  const detail = new URL(page.url()).pathname;
  await page.goto(`${install.origin}${detail}/edit`);
  await expect.poll(() => new URL(page.url()).pathname).toMatch(editPath);
  await expect(page.locator("input[name=proxy]")).toHaveValue(proxy.url);
  await expect(page.locator("input[name=proxyUser]")).toHaveValue("ops");
  const password = page.locator("input[name=proxyPassword]");
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("placeholder", anyText);
  await expect(page.locator("body")).not.toContainText("proxy-secret-9");

  // Emptying the address takes the user name and password fields away.
  await page.fill("input[name=proxy]", "");
  await expect(page.locator("input[name=proxyUser]")).toHaveCount(0);
  await expect(page.locator("input[name=proxyPassword]")).toHaveCount(0);
});

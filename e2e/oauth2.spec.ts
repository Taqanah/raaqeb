// An HTTP monitor's OAuth 2.0 client credentials in the form, on an install of
// its own: "test now" asks the spec's token endpoint for a token with the
// client ID and secret and calls the spec's API with it, a wrong secret is the
// token request failed with the endpoint's status, and the saved monitor shows
// the endpoint and the client ID but never the secret, which the edit keeps
// when its field stays empty.

import type { Page } from "@playwright/test";
import {
  type FakeApi,
  type FakeTokenServer,
  startApi,
  startTokenServer,
  tokenJson,
} from "@/server/checks/oauth-fixture.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

const anyText = /\S/;
const detailPath = /^\/admin\/monitors\/[0-9a-f-]{36}$/;

let install: Install;
let endpoint: FakeTokenServer;
let api: FakeApi;

test.beforeAll(async () => {
  install = await spawnInstall({ account: true, language: "en" });
  endpoint = startTokenServer([{ body: tokenJson("e2e-token") }]);
  api = startApi();
});

test.afterAll(async () => {
  endpoint.stop();
  api.stop();
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

test("OAuth 2.0 client credentials carry the test and the check, a refused secret is the token request failed, and the edit shows the endpoint and the client ID, never the secret", async ({
  page,
}) => {
  await signIn(page, "/admin/monitors/new");
  await page.fill("input[name=name]", "Partner API");
  await page.fill("input[name=url]", api.url);
  await expect(page.locator("input[name=oauthTokenUrl]")).toHaveCount(0);
  await page.click("[role=radio][data-value=oauth2]");
  await page.fill("input[name=oauthTokenUrl]", endpoint.url);
  await page.fill("input[name=oauthClientId]", "raaqeb");
  await page.fill("input[name=oauthClientSecret]", "oauth-secret-7");
  await page.fill("input[name=oauthScope]", "read write");
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-result][data-result=up]")
  ).toBeVisible();
  expect(api.authorizations.at(-1)).toBe("Bearer e2e-token");
  const asked = new URLSearchParams(endpoint.calls.at(-1)?.body);
  expect(asked.get("grant_type")).toBe("client_credentials");
  expect(asked.get("scope")).toBe("read write");
  expect(endpoint.calls.at(-1)?.headers.authorization).toBe(
    `Basic ${btoa("raaqeb:oauth-secret-7")}`
  );

  // The endpoint refuses: the reason is its own, with the status.
  endpoint.answers = [
    { body: JSON.stringify({ error: "invalid_client" }), status: 401 },
  ];
  await page.fill("input[name=oauthClientSecret]", "wrong-secret");
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-result][data-result=down]")
  ).toBeVisible();
  await expect(page.locator("[data-slot=test-panel]")).toContainText("401");

  endpoint.answers = [{ body: tokenJson("e2e-token") }];
  await page.fill("input[name=oauthClientSecret]", "oauth-secret-7");
  const tested = api.authorizations.length;
  await page.click("[data-slot=save-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
  // A saved monitor is due at once, so the scheduler's first check asks for a token and calls the API with it too.
  await expect.poll(() => api.authorizations.length).toBeGreaterThan(tested);
  expect(api.authorizations.at(-1)).toBe("Bearer e2e-token");
  expect(endpoint.calls.at(-1)?.headers.authorization).toBe(
    `Basic ${btoa("raaqeb:oauth-secret-7")}`
  );
  const detail = new URL(page.url()).pathname;
  await page.goto(`${install.origin}${detail}/edit`);
  await expect(page.locator("input[name=oauthTokenUrl]")).toHaveValue(
    endpoint.url
  );
  await expect(page.locator("input[name=oauthClientId]")).toHaveValue("raaqeb");
  const secret = page.locator("input[name=oauthClientSecret]");
  await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("placeholder", anyText);
  await expect(page.locator("body")).not.toContainText("oauth-secret-7");

  // Left empty, the stored secret is kept: the test still authenticates.
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-result][data-result=up]")
  ).toBeVisible();
  expect(endpoint.calls.at(-1)?.headers.authorization).toBe(
    `Basic ${btoa("raaqeb:oauth-secret-7")}`
  );
});

// The Prometheus metrics endpoint on an install of its own: off until the
// operator turns it on, answering only the token the settings page shows once.

import type { Page } from "@playwright/test";
import { reasons } from "@/shared/schemas/reason.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

const tokenShape = /^rqm_/;

// The monitor's id is a UUID the install made, so the series are matched by shape.
const series =
  'monitor="Metrics site",monitor_id="[0-9a-f-]{36}",group="Core",check_type="http"';
const pausedLine = new RegExp(`raaqeb_monitor_paused\\{${series}\\} 1`);
const checkedLine = new RegExp(
  `raaqeb_monitor_last_check_timestamp_seconds\\{${series}\\} \\d`
);

let install: Install;

test.beforeAll(async () => {
  install = await spawnInstall({
    account: true,
    language: "en",
    records: async (storage) => {
      const monitor = await storage.monitors.create({
        channels: [],
        config: {
          assertions: [{ codes: ["2xx"], kind: "status" }],
          captureMode: "off",
          followRedirects: true,
          ignoreTlsErrors: false,
          method: "GET",
          type: "http",
          url: "http://127.0.0.1:1/",
        },
        events: [],
        group: "Core",
        intervalMs: 3_600_000,
        name: "Metrics site",
        retries: 0,
        tags: [],
        timeoutMs: 10_000,
      });
      await storage.checks.record({
        capture: undefined,
        check: {
          attempts: 1,
          bytes: 0,
          monitorId: monitor.id,
          reason: reasons.ok,
          responseMs: 250,
          result: "up",
          startedAt: Date.now() - 1000,
          statusCode: 200,
        },
        detail: undefined,
      });
      await storage.monitors.pause([monitor.id]);
    },
  });
});

test.afterAll(async () => {
  await install.stop();
});

const scrape = (token?: string) =>
  fetch(`${install.origin}/metrics`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

test("metrics are off until the operator turns them on, then answer the shown token alone, and a new token replaces it", async ({
  page,
}) => {
  expect((await scrape()).status).toBe(404);
  expect((await scrape("rqm_anything")).status).toBe(404);

  await signIn(page, install.origin);
  await page.goto(`${install.origin}/admin/settings/metrics`);
  await expect(
    page.locator("[data-slot=metrics-form][data-on=false]")
  ).toHaveCount(1);
  await page.click("[data-slot=metrics-on]");
  const shown = page.locator("[data-slot=metrics-token-value]");
  await expect(shown).toHaveCount(1);
  const token = (await shown.textContent()) ?? "";
  expect(token).toMatch(tokenShape);
  await expect(page.locator("[data-slot=metrics-config]")).toContainText(token);

  const refused = await scrape();
  expect(refused.status).toBe(401);
  expect(refused.headers.get("www-authenticate")).toBe("Bearer");
  expect((await scrape("rqm_wrong")).status).toBe(401);
  const answered = await scrape(token);
  expect(answered.status).toBe(200);
  expect(answered.headers.get("content-type")).toBe(
    "text/plain; version=0.0.4; charset=utf-8"
  );
  const text = await answered.text();
  // Paused, so the scheduler never replaces the check the install was seeded with.
  expect(text).toMatch(pausedLine);
  expect(text).toMatch(checkedLine);
  expect(text).not.toContain("raaqeb_monitor_up{");

  // Done closes the one-time view; the token is not shown again, only the address.
  await page.click("[data-slot=metrics-token-done]");
  await expect(
    page.locator("[data-slot=metrics-form][data-on=true]")
  ).toHaveCount(1);
  await expect(page.locator("[data-slot=metrics-address]")).toHaveText(
    `${install.origin}/metrics`
  );
  await page.reload();
  await expect(page.locator("body")).not.toContainText(token);

  await page.click("[data-slot=metrics-new-token]");
  const fresh =
    (await page.locator("[data-slot=metrics-token-value]").textContent()) ?? "";
  expect(fresh).not.toBe(token);
  expect((await scrape(token)).status).toBe(401);
  expect((await scrape(fresh)).status).toBe(200);
  await page.click("[data-slot=metrics-token-done]");

  await page.click("[data-slot=metrics-off]");
  await expect(
    page.locator("[data-slot=metrics-form][data-on=false]")
  ).toHaveCount(1);
  expect((await scrape(fresh)).status).toBe(404);
});

// Remote probes on an install of its own: the operator makes a probe on the
// locations page, a real `raaqeb probe` process starts with the token shown
// once, the monitor form checks a monitor from it, and the monitor's page
// shows the probe's state beside the install's own.

import type { Page } from "@playwright/test";
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

const tokenShape = /^rqp_/;

let install: Install;
let monitorId = "";
let probe: ReturnType<typeof Bun.spawn> | undefined;
const target = Bun.serve({
  fetch: () => new Response("up"),
  hostname: "127.0.0.1",
  port: 0,
});

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
          url: `http://127.0.0.1:${target.port}/`,
        },
        events: [],
        intervalMs: 20_000,
        name: "Probe site",
        retries: 0,
        tags: [],
        timeoutMs: 5000,
      });
      monitorId = monitor.id;
    },
  });
});

test.afterAll(async () => {
  probe?.kill();
  await probe?.exited;
  await install.stop();
  await target.stop(true);
});

test.setTimeout(90_000);

test("a probe made on the locations page reports with its token, and the monitor page shows its state beside the main location's", async ({
  page,
}) => {
  await signIn(page, install.origin);
  await page.goto(`${install.origin}/admin/settings/locations`);
  await expect(page.locator("[data-probe=main]")).toHaveCount(1);
  await page.click("[data-slot=probe-add]");
  await expect(
    page.locator("[data-slot=add-probe] [aria-invalid=true]")
  ).toHaveCount(1);
  await page.fill("[data-slot=add-probe] input[name=name]", "Local");
  await page.click("[data-slot=probe-add]");
  const shown = page.locator("[data-slot=probe-token-value]");
  await expect(shown).toHaveCount(1);
  const token = (await shown.textContent()) ?? "";
  expect(token).toMatch(tokenShape);
  await expect(page.locator("[data-slot=probe-command]")).toContainText(
    `RAAQEB_PROBE_SERVER=${install.origin} RAAQEB_PROBE_TOKEN=${token} raaqeb probe`
  );
  await page.click("[data-slot=probe-token-done]");
  const row = page.locator("li[data-probe]:not([data-probe=main])");
  await expect(row).toHaveCount(1);
  const probeId = (await row.getAttribute("data-probe")) ?? "";
  await page.reload();
  await expect(page.locator("body")).not.toContainText(token);

  // The monitor is checked from the probe before it starts, so its first pull carries it.
  await page.goto(`${install.origin}/admin/monitors/${monitorId}/edit`);
  await page.click(`[data-location="${probeId}"]`);
  await page.selectOption("select[name=confirmations]", "2");
  await page.click("[data-slot=save-monitor]");
  await expectPath(page, `/admin/monitors/${monitorId}`);

  probe = Bun.spawn(["bun", "dist/server/server.js", "probe"], {
    env: {
      ...process.env,
      RAAQEB_PROBE_SERVER: install.origin,
      RAAQEB_PROBE_TOKEN: token,
    },
    stderr: "ignore",
    stdout: "ignore",
  });
  // The probe's first contact shows when the install heard from it.
  await page.goto(`${install.origin}/admin/settings/locations`);
  await expect
    .poll(
      async () => {
        await page.reload();
        return await row.locator("time").count();
      },
      { timeout: 30_000 }
    )
    .toBe(1);

  await page.goto(`${install.origin}/admin/monitors/${monitorId}`);
  const located = page.locator(
    `[data-slot=locations] [data-location="${probeId}"]`
  );
  await expect
    .poll(
      async () => {
        await page.reload();
        return await located.getAttribute("data-result");
      },
      { intervals: [1000], timeout: 60_000 }
    )
    .toBe("up");
  await expect(
    page.locator("[data-slot=locations] [data-location=main]")
  ).toHaveCount(1);
  await expect(page.locator("[data-slot=locations]")).toContainText("Local");
});

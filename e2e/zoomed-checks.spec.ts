// The checks list under a zoomed chart and unzoomed, on an install of its own seeded with
// one paused monitor and its checks, so no scheduler check lands among them.

import { type Cookie, type Page, request } from "@playwright/test";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

const minute = 60_000;
const day = 86_400_000;
/** The span's checks, one a minute, more than two pages of twenty. */
const spanChecks = 45;
const now = Date.now();
const first = Math.floor(now / minute) * minute - 2 * 60 * minute;
const span = { from: first - 10 * minute, to: first + 60 * minute };

let install: Install | undefined;
let origin = "";
let session: Cookie[] = [];
let monitorId = "";

test.beforeAll(async () => {
  install = await spawnInstall({
    account: true,
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
        events: [...monitorEventKinds],
        intervalMs: minute,
        name: "Zoomed",
        retries: 0,
        tags: [],
        timeoutMs: 10_000,
      });
      monitorId = monitor.id;
      await storage.monitors.pause([monitor.id]);
      for (let index = 0; index < spanChecks; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one write a check, as the scheduler makes them
        await storage.checks.record({
          capture: undefined,
          check: {
            attempts: 1,
            bytes: 10,
            monitorId: monitor.id,
            reason: reasons.ok,
            responseMs: 100,
            result: "up",
            startedAt: first + index * minute,
            statusCode: 200,
          },
          detail: undefined,
        });
      }
    },
  });
  ({ origin } = install);
  const api = await request.newContext();
  const signedIn = await api.post(`${origin}/api/auth/sign-in/email`, {
    data: { email: operatorEmail, password: operatorPassword },
    headers: { origin },
  });
  expect(signedIn.status()).toBe(200);
  session = (await api.storageState()).cookies;
  await api.dispose();
});

test.afterAll(async () => {
  await install?.stop();
});

async function open(
  page: Page,
  zoom: { from: number; to: number } | undefined
): Promise<void> {
  await page.context().addCookies(session);
  const search = zoom ? `?range=24h&from=${zoom.from}&to=${zoom.to}` : "";
  await page.goto(`${origin}/admin/monitors/${monitorId}${search}`);
  await expectPath(page, `/admin/monitors/${monitorId}`);
}

const rows = "[data-slot=recent-checks] [data-check]";
const showMore = "[data-slot=recent-checks] [data-slot=span-checks-more]";

test("a zoomed span lists its newest twenty checks and shows more, twenty older at a time, until the span holds no more", async ({
  page,
}) => {
  await open(page, span);
  await expect(page.locator(rows)).toHaveCount(20);
  await expect(page.locator(rows).first()).toHaveAttribute(
    "data-check",
    String(first + (spanChecks - 1) * minute)
  );
  await page.click(showMore);
  await expect(page.locator(rows)).toHaveCount(40);
  await page.click(showMore);
  await expect(page.locator(rows)).toHaveCount(spanChecks);
  await expect(page.locator(rows).last()).toHaveAttribute(
    "data-check",
    String(first)
  );
  await expect(page.locator(showMore)).toHaveCount(0);
});

test("unzoomed, the list holds the newest twenty checks and shows more back through the kept checks until none remain", async ({
  page,
}) => {
  await open(page, undefined);
  await expect(page.locator(rows)).toHaveCount(20);
  await page.click(showMore);
  await expect(page.locator(rows)).toHaveCount(40);
  await page.click(showMore);
  await expect(page.locator(rows)).toHaveCount(spanChecks);
  await expect(page.locator(rows).last()).toHaveAttribute(
    "data-check",
    String(first)
  );
  await expect(page.locator(showMore)).toHaveCount(0);
});

test("a span older than the kept checks says only summaries remain and lists none", async ({
  page,
}) => {
  await open(page, { from: now - 40 * day, to: now - 35 * day });
  await expect(
    page.locator("[data-slot=recent-checks] [data-slot=span-checks-gone]")
  ).toBeVisible();
  await expect(page.locator(rows)).toHaveCount(0);
  await expect(page.locator(showMore)).toHaveCount(0);
});

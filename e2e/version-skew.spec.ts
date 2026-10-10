// A tab left open across a deploy runs the old build's client, whose server
// function ids and chunks the new build may not have. Every server
// function's answer names the server's build; the client reloads once when
// an answer failed and its build is not the tab's own. The deploy is stood in
// for by rewriting that header, and the failure by rewriting the status.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";

declare global {
  interface Window {
    __sameDocument?: boolean;
  }
}

/** Runs the database screen's connection test, a server function a click submits, and answers the build its answer named. */
async function testConnection(page: Page): Promise<string | undefined> {
  await page.click(
    "[role=radiogroup][data-name=backend] [role=radio][data-value=postgres]"
  );
  await page.fill("input[name=url]", "postgres://u:p@127.0.0.1:1/raaqeb");
  const [answer] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/_serverFn/")),
    page.click("button[name=test]"),
  ]);
  return answer.headers()["x-raaqeb-build"];
}

test("a server function answer that failed on another build reloads the page once, a successful one reloads nothing, and the failed one after that reload reaches the page", async ({
  page,
}) => {
  await page.goto("/onboarding/database");
  await page.evaluate(() => {
    window.__sameDocument = true;
  });

  // This build's answer reaches the page and reloads nothing.
  const own = await testConnection(page);
  expect(own).toBeTruthy();
  await expect(page.locator("[data-verdict=unreachable]")).toHaveCount(1);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);

  // A deploy: every answer now names another build, and succeeds until told otherwise.
  let status = 200;
  await page.route("**/_serverFn/**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      headers: { ...response.headers(), "x-raaqeb-build": `${own}-next` },
      response,
      status,
    });
  });
  await page.reload();
  await page.evaluate(() => {
    window.__sameDocument = true;
  });
  await testConnection(page);
  await expect(page.locator("[data-verdict=unreachable]")).toHaveCount(1);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);

  status = 500;
  const reloaded = page.waitForEvent("load");
  await testConnection(page);
  await reloaded;
  await page.waitForFunction(() => window.__reactCommitted === true);
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();

  // The reload brought back the same build, so the next such answer reaches the page instead of looping.
  await testConnection(page);
  await expect(page.locator("[data-verdict=unreachable]")).toHaveCount(1);
});

test("the 500 for a server function id the build lacks names the build, and a page's answer names none", async ({
  page,
  request,
}) => {
  const document = await page.goto("/onboarding/database");
  expect(document?.headers()["x-raaqeb-build"]).toBeUndefined();
  const missing = await request.post("/_serverFn/not-a-registered-id", {
    data: {},
    headers: { "sec-fetch-site": "same-origin", "x-tsr-serverfn": "true" },
  });
  expect(missing.status()).toBe(500);
  expect(missing.headers()["x-raaqeb-build"]).toBeTruthy();
});

/** Signs in on the English server and waits for the monitor list's shell. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
  await expect(page.locator("[data-slot=palette-trigger]")).toBeVisible();
}

// The maintenance list's chunk holds its loader. Router reloads by itself only
// for a component's chunk; a loader's failure would show the error page.
test("a route chunk the server no longer has reloads the page", async ({
  page,
}) => {
  await signIn(page);
  await page.evaluate(() => {
    window.__sameDocument = true;
  });

  // A deploy: every chunk this page has not loaded yet is gone.
  const loaded = new Set(
    await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name)
    )
  );
  await page.route("**/assets/*.js", (route) =>
    loaded.has(route.request().url())
      ? route.continue()
      : route.fulfill({ status: 404 })
  );
  const reloaded = page.waitForEvent("load");
  await page.click("a[data-nav=maintenance]");
  await reloaded;
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
});

const dnsName = /^DNS$/;

/** Holds the page's clock from now on, so its timers move only when the test moves them. */
async function holdClock(page: Page): Promise<void> {
  await page.clock.pauseAt(Date.now() + 1000);
}

// A deploy's restart, or a network drop: for a moment no server answers at
// all, so no answer names a build. A read is tried again until one does.
test("a refresh that meets a dropped connection is read again once the server is back, and the page stays", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await holdClock(page);
  await page.locator("[data-slot=monitor-name]", { hasText: dnsName }).click();
  await expect(page.locator("[data-slot=monitor-summary]")).toBeVisible();
  await page.evaluate(() => {
    window.__sameDocument = true;
  });

  let dropped = 0;
  await page.route("**/_serverFn/**", async (route) => {
    dropped += 1;
    await route.abort("connectionfailed");
  });
  // The detail page reads itself again every 30 seconds; its retries then wait on the held clock.
  await page.clock.fastForward(30_000);
  await expect.poll(() => dropped).toBeGreaterThan(0);

  await page.unroute("**/_serverFn/**");
  const answered = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.ok()
  );
  await page.clock.fastForward(1000);
  await answered;
  await expect(page.locator("[data-slot=monitor-summary]")).toBeVisible();
  await expect(page.locator("[data-slot=page-error]")).toHaveCount(0);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
});

// The router aborts a load a later navigation replaced; its read stops there
// rather than retrying for 30 seconds beside the one the page now wants.
test("a read the page no longer wants after a click elsewhere is not tried again, while the wanted one is", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await holdClock(page);
  const asked = new Map<string, number>();
  await page.route("**/_serverFn/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    asked.set(path, (asked.get(path) ?? 0) + 1);
    await route.abort("connectionfailed");
  });
  // A dispatched click, with no hover before it, so no preload reads the page.
  await page.dispatchEvent("a[data-nav=channels]", "click");
  await expect.poll(() => asked.size).toBe(1);
  const [abandoned] = [...asked.keys()];
  await page.dispatchEvent("a[data-nav=maintenance]", "click");
  await expect.poll(() => asked.size).toBeGreaterThan(1);
  const wanted = () =>
    [...asked].reduce(
      (sum, [path, count]) => (path === abandoned ? sum : sum + count),
      0
    );
  const first = wanted();

  await page.clock.runFor(1000);
  await expect.poll(wanted).toBeGreaterThan(first);
  const second = wanted();
  await page.clock.runFor(2000);
  await expect.poll(wanted).toBeGreaterThan(second);
  expect(asked.get(abandoned ?? "")).toBe(1);
});

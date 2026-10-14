// Sign-in, sign-out and the admin guard on the built entry. The
// English server holds the operator account; the Arabic server stays in
// onboarding, where e2e/onboarding.spec.ts pins that sign-in goes there.

import { operatorLanguage } from "@/server/settings/operator.ts";
import {
  clientAddress,
  expect,
  expectPath,
  expectRefused,
  test,
} from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

const emailField = "input[name=email]";
const passwordField = "input[name=password]";
const submit = "form button[type=submit]";
const failure = "form [role=alert]";

test("the operator signs in and lands in the admin area; the session cookie is set", async ({
  context,
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  await expect(page.locator(emailField)).toBeFocused();
  await page.fill(emailField, operatorEmail);
  await page.fill(passwordField, operatorPassword);
  await page.click(submit);
  await expectPath(page, "/admin/monitors");
  await expect(page.locator("[data-slot=sidebar-footer] bdi")).toHaveText(
    operatorEmail
  );
  const cookies = await context.cookies(englishOrigin);
  expect(cookies.some((c) => c.name === "raaqeb.session_token")).toBe(true);
});

test("a wrong password shows one failure line and stays on the page, with no cookie", async ({
  context,
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill(emailField, operatorEmail);
  await page.fill(passwordField, "not the password");
  await page.click(submit);
  await expect(page.locator(failure)).toHaveCount(1);
  // Only the origin check's refusal points at set-address: a wrong password is not an address problem.
  await expect(page.locator("[data-slot=set-address-command]")).toHaveCount(0);
  await expectPath(page, "/sign-in");
  const cookies = await context.cookies(englishOrigin);
  expect(cookies.some((c) => c.name === "raaqeb.session_token")).toBe(false);
});

test("an email that is not one and an empty password are refused beside their fields, and nothing is sent", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  const sent: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/auth/")) {
      sent.push(request.url());
    }
  });
  await page.fill(emailField, "not an email");
  await page.click(submit);
  await expectRefused(page, "form", ["email", "password"]);
  expect(sent).toHaveLength(0);
  await expectPath(page, "/sign-in");
});

test("on a phone in Arabic a wrong password shows one failure line in a right-to-left page that fits the screen", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${englishOrigin}/sign-in?locale=ar`);
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  await page.fill(emailField, operatorEmail);
  await page.fill(passwordField, "not the password");
  await page.press(passwordField, "Enter");
  await expect(page.locator(failure)).toHaveCount(1);
  await expectPath(page, "/sign-in");
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("a sign-in the origin check refuses says the page is not at the public address, not that the password is wrong", async ({
  page,
}) => {
  // The page's own POST, sent again with a foreign Origin: Chromium keeps its own Origin on a continued request.
  await page.route(`${englishOrigin}/api/auth/sign-in/email`, async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: "https://evil.example" },
    });
    await route.fulfill({ response });
  });
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill(emailField, operatorEmail);
  await page.fill(passwordField, operatorPassword);
  await page.click(submit);
  await expect(page.locator(failure)).toHaveText(
    "This address is not the install's public address. Open Raaqeb at its public address."
  );
  // The way back in from the server, for an operator who means this address.
  await expect(page.locator("[data-slot=set-address-command]")).toHaveText(
    `raaqeb set-address ${englishOrigin}`
  );
  await expectPath(page, "/sign-in");
});

test("a sign-out the origin check refuses says the page is not at the public address, and the session stays", async ({
  context,
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill(emailField, operatorEmail);
  await page.fill(passwordField, operatorPassword);
  await page.click(submit);
  await expectPath(page, "/admin/monitors");
  await page.route(`${englishOrigin}/api/auth/sign-out`, async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin: "https://evil.example" },
    });
    await route.fulfill({ response });
  });
  await page.goto(`${englishOrigin}/sign-out`);
  await page.click(submit);
  await expect(page.locator(failure)).toHaveText(
    "This address is not the install's public address. Open Raaqeb at its public address."
  );
  await expect(page.locator("[data-slot=set-address-command]")).toHaveText(
    `raaqeb set-address ${englishOrigin}`
  );
  await expectPath(page, "/sign-out");
  const cookies = await context.cookies(englishOrigin);
  expect(cookies.some((c) => c.name === "raaqeb.session_token")).toBe(true);
});

test("the admin area sends a visitor without a session to the sign-in page", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/admin`);
  await expectPath(page, "/sign-in");
});

test("the sign-out page ends the session with one button and the admin area is closed again", async ({
  context,
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill(emailField, operatorEmail);
  await page.fill(passwordField, operatorPassword);
  await page.click(submit);
  await expectPath(page, "/admin/monitors");
  // A GET of the sign-out page ends nothing by itself.
  await page.goto(`${englishOrigin}/sign-out`);
  await expectPath(page, "/sign-out");
  const before = await context.cookies(englishOrigin);
  expect(before.some((c) => c.name === "raaqeb.session_token")).toBe(true);
  await page.click(submit);
  await expectPath(page, "/sign-in");
  await page.goto(`${englishOrigin}/admin`);
  await expectPath(page, "/sign-in");
});

test("the sign-in page always shows forgot password and the language switcher", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  await expect(page.locator('a[href="/forgot-password"]')).toHaveCount(1);
  await expect(page.locator('a[href="?locale=ar"]')).toHaveCount(1);
  await expect(page.locator('a[href="?locale=en"]')).toHaveCount(1);
});

test("the switcher renders the sign-in page in the other locale as a full document, and the admin area ignores the parameter", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
  await page.click('a[href="?locale=ar"]');
  await expectPath(page, "/sign-in");
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  await page.fill(emailField, operatorEmail);
  await page.fill(passwordField, operatorPassword);
  await page.click(submit);
  await expectPath(page, "/admin/monitors");
  await page.goto(`${englishOrigin}/admin?locale=ar`);
  await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
});

test("a locale the install does not ship is ignored: the page renders in the install language", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in?locale=ar-SA`);
  await expectPath(page, "/sign-in");
  await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
  await expect(page.locator(emailField)).toHaveCount(1);
});

test("over the wire: a disabled endpoint is Not Found, a foreign origin is refused, the fourth attempt is rate limited", async ({
  request,
}, testInfo) => {
  const address = clientAddress(testInfo.parallelIndex);
  const session = await request.get(`${englishOrigin}/api/auth/get-session`, {
    headers: { "x-forwarded-for": address },
  });
  expect(session.status()).toBe(404);
  expect(await session.text()).toBe("Not Found");

  // Its own address: the limiter runs before the origin check, so a refused origin spends budget too.
  const foreign = await request.post(
    `${englishOrigin}/api/auth/sign-in/email`,
    {
      data: { email: operatorEmail, password: operatorPassword },
      headers: {
        origin: "https://evil.example",
        "x-forwarded-for": clientAddress(testInfo.parallelIndex),
      },
    }
  );
  expect(foreign.status()).toBe(403);

  // One address for all four: the limit is per client, and this client spends its own budget.
  const bad = { email: operatorEmail, password: "not the password" };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the limiter counts requests in order
    const response = await request.post(
      `${englishOrigin}/api/auth/sign-in/email`,
      {
        data: bad,
        headers: { origin: englishOrigin, "x-forwarded-for": address },
      }
    );
    expect(response.status(), `attempt ${attempt}`).toBe(401);
  }
  const fourth = await request.post(`${englishOrigin}/api/auth/sign-in/email`, {
    data: bad,
    headers: { origin: englishOrigin, "x-forwarded-for": address },
  });
  expect(fourth.status()).toBe(429);
});

test("on the install with no database yet, the auth endpoints answer 503 before Better Auth runs", async ({
  request,
}) => {
  const response = await request.get("/api/auth/get-session");
  expect(response.status()).toBe(503);
  expect(await response.text()).toBe("");
});

test("a hover on the sign-in page's links sends nothing; only the click reads the next page", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  const calls: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname.startsWith("/_serverFn/")) {
      calls.push(sent.url());
    }
  });
  await page.hover("a[href='/forgot-password']");
  // Well past the router's 50 ms hover delay: a preload would have been sent by now.
  await page.waitForTimeout(500);
  expect(calls).toHaveLength(0);
  await page.click("a[href='/forgot-password']");
  await expectPath(page, "/forgot-password");
  expect(calls.length).toBeGreaterThan(0);
});

test("a page outside the admin whose read failed shows the error in the catalog's words, never its text, and try again reads it again", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/sign-in`);
  // The server answers each read with a failure naming its own build, so nothing retries or reloads.
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      body: "a private failure",
      contentType: "text/plain",
      headers: { "x-raaqeb-build": response.headers()["x-raaqeb-build"] ?? "" },
      status: 500,
    });
  });
  await page.click("a[href='/forgot-password']");
  await expect(page.locator("[data-slot=page-error]")).toBeVisible();
  await expect(
    page.locator("[data-slot=page-error] [data-slot=empty-title]")
  ).not.toBeEmpty();
  await expect(page.getByText("a private failure")).toHaveCount(0);

  await page.unroute("**/_serverFn/**");
  await page.click("[data-slot=page-error] button[name=retry]");
  await expectPath(page, "/forgot-password");
  // The English install has no email channel: its forgot page leads back to sign-in.
  await expect(page.locator("a[href='/sign-in']")).toBeVisible();
  await expect(page.locator("[data-slot=page-error]")).toHaveCount(0);
});

test.describe("the language either side of signing in", () => {
  // An Arabic install whose operator reads English: the signed-out pages are Arabic, the admin English.
  let install: Install | undefined;
  test.beforeAll(async () => {
    install = await spawnInstall({
      account: true,
      records: (storage) => storage.settings.set(operatorLanguage, "en"),
    });
  });
  test.afterAll(async () => {
    await install?.stop();
  });

  test("the first admin page after sign-in is in the operator's language, and the sign-in page after sign-out in the install's", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await page.goto(`${origin}/sign-in`);
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
    await page.fill(emailField, operatorEmail);
    await page.fill(passwordField, operatorPassword);
    await page.click(submit);
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
    await page.click("[data-slot=sidebar-footer] a[href='/sign-out']");
    await expectPath(page, "/sign-out");
    await page.click(submit);
    await expectPath(page, "/sign-in");
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  });
});

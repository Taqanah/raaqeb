import { expect, expectPath, test } from "./support/fixtures.ts";
import { englishOrigin } from "./support/servers.ts";

const hashedWoff2 = /^\/assets\/.*\.woff2$/;

test("the root document is Arabic and right-to-left by default, with the catalog inlined", async ({
  page,
}) => {
  // The root goes to onboarding on this server, which never leaves it.
  await page.goto("/");
  await expectPath(page, "/onboarding");
  await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  await expect(page).toHaveTitle("راقب");
  await expect(page.locator("form button[type=submit]")).toHaveText("متابعة");
});

test("the root document follows the install language", async ({ page }) => {
  // The bare host shows this server's default status page; the admin area goes to sign-in without a session.
  await page.goto(`${englishOrigin}/admin`);
  await expectPath(page, "/sign-in");
  await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
  await expect(page).toHaveTitle("Raaqeb");
  await expect(page.locator("form button[type=submit]")).toHaveText("Sign in");
});

test("the other locale stays out of the document and the browser bundle", async ({
  page,
}) => {
  const html = await (
    await page.request.get(`${englishOrigin}/sign-in`)
  ).text();
  expect(html).not.toContain("تسجيل الدخول");
  const glob = new Bun.Glob("**/*.js");
  for await (const file of glob.scan({ cwd: "dist/client" })) {
    const text = await Bun.file(`dist/client/${file}`).text();
    expect(text, file).not.toContain("تسجيل الدخول");
    expect(text, file).not.toContain("Sign in");
  }
});

test("the document carries the appearance settings as data attributes, the defaults on a fresh install", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.locator(
      "html[data-theme=system][data-font-size=medium][data-density=comfortable][data-radius=medium]"
    )
  ).toHaveCount(1);
});

test("the document follows the stored appearance settings", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/admin`);
  await expect(
    page.locator(
      "html[data-theme=dark][data-font-size=large][data-density=compact][data-radius=none]"
    )
  ).toHaveCount(1);
});

test("Rubik and IBM Plex Mono are served from this install and used by the document", async ({
  page,
}) => {
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") {
      fontRequests.push(request.url());
    }
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) {
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    expect(new URL(url).pathname).toMatch(hashedWoff2);
  }
  // A face loads when first used; the skeleton page shows no token yet, so
  // load asks for both faces and check answers whether each arrived.
  const fonts = await page.evaluate(async () => {
    await document.fonts.load("14px Rubik");
    await document.fonts.load('14px "IBM Plex Mono"');
    return {
      mono: document.fonts.check('14px "IBM Plex Mono"'),
      sans: document.fonts.check("14px Rubik"),
      bodyFamily: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(fonts.sans).toBe(true);
  expect(fonts.mono).toBe(true);
  expect(fonts.bodyFamily).toContain("Rubik");
});

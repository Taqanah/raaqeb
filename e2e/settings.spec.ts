// The settings pages on the built entry. On the English install the tests
// only read, or save what the page refuses, since most specs read its
// settings; what changes an install-wide setting runs on an install of its own.

import { type Cookie, type Page, request } from "@playwright/test";
import {
  expect,
  expectPath,
  expectRefused,
  expectSaidOnce,
  test,
} from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

test("the setup check lists what the server can judge, each passed or not: a trusted proxy's request passes, and no email channel needs a fix", async ({
  page,
}) => {
  await signIn(page, englishOrigin);
  await page.goto(`${englishOrigin}/admin/settings`);
  await page.click("a[href='/admin/settings/setup-check']");
  await expectPath(page, "/admin/settings/setup-check");
  const check = (selector: string) =>
    page.locator(`[data-slot=setup-check] ${selector}`);
  // The English server trusts 127.0.0.1, and every request of the test carries a forwarded address.
  await expect(check("[data-check=forwarded][data-passed=true]")).toHaveCount(
    1
  );
  await expect(
    check("[data-check=email_channel][data-passed=false]")
  ).toHaveCount(1);
  // Whether these pass depends on the run (the address another spec saves, the directory's mode), not on this page.
  await expect(check("[data-check=public_address][data-passed]")).toHaveCount(
    1
  );
  await expect(
    check("[data-check=data_directory_mode][data-passed]")
  ).toHaveCount(1);
  // The email check's fix leads to the channels.
  await page.click("[data-check=email_channel] a[href='/admin/channels']");
  await expectPath(page, "/admin/channels");
});

test("a public address with a path is refused and nothing is stored", async ({
  page,
}) => {
  await signIn(page, englishOrigin);
  await page.goto(`${englishOrigin}/admin/settings`);
  const address = page.locator("input#publicAddress");
  const stored = await address.inputValue();
  await address.fill("https://status.example.com/path");
  await page.click("[data-slot=general-form] button[type=submit]");
  await expect(
    page.locator(
      "[data-slot=general-form] [data-slot=save-outcome][data-state=failed][data-reason=invalid]"
    )
  ).toHaveCount(1);
  await page.reload();
  await expect(address).toHaveValue(stored);
});

test("a new public address other than the page's own warns before the save that sign-in and sign-out move with it", async ({
  page,
}) => {
  await signIn(page, englishOrigin);
  await page.goto(`${englishOrigin}/admin/settings`);
  const address = page.locator("input#publicAddress");
  const warning = page.locator(
    "[data-slot=general-form] [data-slot=address-elsewhere]"
  );
  await expect(warning).toHaveCount(0);
  await address.fill("https://status.example.com");
  await expect(warning).toBeVisible();
  // The address the page is open at keeps sign-in working here.
  await address.fill(englishOrigin);
  await expect(warning).toHaveCount(0);
});

test("a public address the page refuses is marked on its own field, in the page's language", async ({
  page,
}) => {
  // A bare host is the page's to refuse, never the browser's bubble; a path is marked on the field, not only in the footer.
  await signIn(page, englishOrigin);
  await page.goto(`${englishOrigin}/admin/settings`);
  const address = page.locator("input#publicAddress");
  for (const refused of [
    "status.example.com/path",
    "https://status.example.com/path",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one refusal after another on the same form
    await address.fill(refused);
    await page.click("[data-slot=general-form] button[type=submit]");
    await expectRefused(page, "[data-slot=general-form]", ["publicAddress"]);
    await expectSaidOnce(page, "[data-slot=general-form]", "publicAddress");
  }
});

test.describe("on an install of its own", () => {
  test.describe.configure({ mode: "serial" });

  let install: Install | undefined;
  let origin = "";
  let session: Cookie[] = [];

  // Started without the proxy flag, so the trusted proxies are the page's to edit; every sign-in then shares one limit, so the tests share one session.
  test.beforeAll(async () => {
    install = await spawnInstall({ account: true, proxyFlag: false });
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

  async function open(page: Page, path: string): Promise<void> {
    await page.context().addCookies(session);
    await page.goto(`${origin}${path}`);
  }

  const general = "[data-slot=general-form]";
  const saveGeneral = `${general} button[type=submit]`;
  const savedGeneral = `${general} [data-slot=save-outcome][data-state=saved]`;

  test("the install language the general page saves is the admin's language, and back", async ({
    page,
  }) => {
    await open(page, "/admin/settings");
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
    await page.click("[data-name=installLanguage] [role=radio][data-value=en]");
    await page.click(saveGeneral);
    await expect(page.locator(savedGeneral)).toHaveCount(1);
    await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
    await page.click("a[data-nav=monitors]");
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
    await page.goto(`${origin}/admin/settings`);
    await page.click("[data-name=installLanguage] [role=radio][data-value=ar]");
    await page.click(saveGeneral);
    await expect(page.locator(savedGeneral)).toHaveCount(1);
    await page.reload();
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
  });

  test("the time zone field follows the language the general page is shown in", async ({
    page,
  }) => {
    // Picking a language changes the page without a reload, so the field must reword its zone on the spot.
    await open(page, "/admin/settings");
    const zone = page.locator(`${general} [data-slot=time-zone-picker]`);
    const before = (await zone.textContent()) ?? "";
    await page.click("[data-name=installLanguage] [role=radio][data-value=en]");
    await expect(page.locator("html[lang=en]")).toHaveCount(1);
    await expect(zone).not.toHaveText(before);
  });

  test("the time zone and the calendar the general page saves are the ones a maintenance window is written in", async ({
    page,
  }) => {
    await open(page, "/admin/settings");
    await page.click(`${general} [data-slot=time-zone-picker]`);
    await page.fill("[data-slot=time-zone-search]", "Tokyo");
    await page.press("[data-slot=time-zone-search]", "Enter");
    await expect(page.locator(`${general} input[name=timeZone]`)).toHaveValue(
      "Asia/Tokyo"
    );
    await page.click(
      "[data-name=calendar] [role=radio][data-value=hijri_gregorian]"
    );
    await page.click(saveGeneral);
    await expect(page.locator(savedGeneral)).toHaveCount(1);
    // The install has no component, so the list offers no window; the form still shows how its times are written.
    await page.goto(`${origin}/admin/maintenance/new`);
    await expect(page.locator("[data-slot=window-zone]")).toHaveAttribute(
      "data-zone",
      "Asia/Tokyo"
    );
    // The start and the end, each in Hijri parts with its Gregorian date under it.
    await expect(page.locator("[data-slot=hijri-time]")).toHaveCount(2);
    await expect(page.locator("[data-slot=gregorian-date]")).toHaveCount(2);
  });

  test("the release check switch and the operator's own time zone, clock and calendar survive a reload", async ({
    page,
  }) => {
    await open(page, "/admin/settings");
    const releaseCheck = page.locator(
      `${general} [role=switch][aria-labelledby=releaseCheck-label]`
    );
    await expect(releaseCheck).toHaveAttribute("aria-checked", "true");
    await releaseCheck.click();
    await page.click(saveGeneral);
    await expect(page.locator(savedGeneral)).toHaveCount(1);
    await page.reload();
    await expect(releaseCheck).toHaveAttribute("aria-checked", "false");

    await page.click("a[href='/admin/settings/account']");
    await expectPath(page, "/admin/settings/account");
    const overrides = "[data-slot=overrides-form]";
    await page.click(`${overrides} [data-slot=time-zone-picker]`);
    await page.fill("[data-slot=time-zone-search]", "Cairo");
    await page.press("[data-slot=time-zone-search]", "Enter");
    await page.click(
      `${overrides} [data-name=clock] [role=radio][data-value='24h']`
    );
    await page.click(
      `${overrides} [data-name=calendar] [role=radio][data-value=hijri]`
    );
    await page.click(`${overrides} button[type=submit]`);
    await expect(
      page.locator(`${overrides} [data-slot=save-outcome][data-state=saved]`)
    ).toHaveCount(1);
    await page.reload();
    await expect(page.locator(`${overrides} input[name=timeZone]`)).toHaveValue(
      "Africa/Cairo"
    );
    await expect(
      page.locator(
        `${overrides} [data-name=clock] [role=radio][data-value='24h']`
      )
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      page.locator(
        `${overrides} [data-name=calendar] [role=radio][data-value=hijri]`
      )
    ).toHaveAttribute("aria-checked", "true");
  });

  test("the request log switch is off on a new install, and turned on it stays on after a reload", async ({
    page,
  }) => {
    await open(page, "/admin/settings");
    const requestLog = page.locator(
      `${general} [role=switch][aria-labelledby=requestLog-label]`
    );
    await expect(requestLog).toHaveAttribute("aria-checked", "false");
    await requestLog.click();
    await page.click(saveGeneral);
    await expect(page.locator(savedGeneral)).toHaveCount(1);
    await page.reload();
    await expectPath(page, "/admin/settings");
    await expect(requestLog).toHaveAttribute("aria-checked", "true");
  });

  test("trusted proxies that are not addresses are refused and nothing is stored", async ({
    page,
  }) => {
    await open(page, "/admin/settings");
    await page.fill("input#trustedProxies", "not-an-ip");
    await page.click(saveGeneral);
    await expect(
      page.locator(
        `${general} [data-slot=save-outcome][data-state=failed][data-reason=trusted_proxy_invalid]`
      )
    ).toHaveCount(1);
    await page.reload();
    await expect(page.locator("input#trustedProxies")).toHaveValue("");
  });

  test("trusted proxies the page refuses are marked on their own field", async ({
    page,
  }) => {
    // The server's refusal is said beside the field as well as in the footer, as the storage page marks its own.
    await open(page, "/admin/settings");
    await page.fill("input#trustedProxies", "not-an-ip");
    await page.click(saveGeneral);
    await expectRefused(page, general, ["trustedProxies"]);
    await expectSaidOnce(page, general, "trustedProxies");
  });
});

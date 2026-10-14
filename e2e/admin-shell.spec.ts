// The admin shell and the settings area on the built entry, signed in on
// the English server. What changes install-wide state that other specs
// assert (appearance, the operator language, the account) runs on the fresh
// server at the end of the onboarding walk; the general and storage saves run
// on an install of their own.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
  sinkOrigin,
} from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

/** A field described by the name field's refusal, among its other lines. */
const describedByError = /name-error/;

async function signIn(page: Page, origin = englishOrigin): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
  // The shell shows over the list's skeleton before the sign-in's navigation ends, and a click then would enter the admin again; wait for the list itself.
  await expect(page.locator("[data-slot=new-monitor]")).toBeVisible();
}

test("the shell renders around an admin page: the grouped navigation, the header row, the title and the primary action", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.locator("html[lang=en][dir=ltr][data-theme=dark]")
  ).toHaveCount(1);
  await expect(page.locator("nav a[data-nav]")).toHaveCount(7);
  await expect(
    page.locator("a[data-nav=monitors][aria-current=page]")
  ).toHaveCount(1);
  await expect(
    page.locator("[data-slot=sidebar][data-state=expanded]")
  ).toHaveCount(1);
  await expect(page.locator("[data-slot=palette-trigger]")).toHaveCount(1);
  await expect(page.locator("[data-slot=page] h1")).toHaveCount(1);
  await expect(page.locator("[data-slot=new-monitor]")).toHaveCount(1);
  await expect(page.locator("[data-slot=sidebar-footer] bdi")).toHaveText(
    operatorEmail
  );
});

test("controls are named without their shortcut letters, the list's menu column is named, and the whole sidebar is navigation", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("link", { exact: true, name: "Add monitor" })
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { exact: true, name: "Search" })
  ).toHaveCount(1);
  await expect(
    page.locator("[data-slot=monitor-list] thead th").last()
  ).not.toHaveText("");
  // The brand, the search, the email and sign out sit inside the navigation landmark, so nothing of the sidebar is outside a landmark.
  const navigation = page.getByRole("navigation");
  await expect(navigation).toHaveCount(1);
  await expect(navigation.locator("[data-slot=palette-trigger]")).toHaveCount(
    1
  );
  await expect(navigation.locator("[data-slot=sidebar-footer]")).toHaveCount(1);
});

test("Ctrl+K opens the command palette; typing filters the pages and Enter opens the highlighted one", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await expect(page.locator("[data-slot=palette]")).toBeVisible();
  await expect(page.locator("[data-palette-item=monitors]")).toHaveCount(1);
  await page.locator("[data-slot=palette-input]").fill("sett");
  await expect(page.locator("[data-palette-item=settings]")).toHaveCount(1);
  await expect(page.locator("[data-palette-item=monitors]")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expectPath(page, "/admin/settings");
  await expect(page.locator("[data-slot=palette]")).toHaveCount(0);
});

test("the arrow keys move the palette's highlight, Enter opens the highlighted page, and on the monitor list N opens a new monitor on an Arabic keyboard too", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  const highlighted = page.locator("[data-palette-item][data-highlighted]");
  await expect(highlighted).toHaveAttribute("data-palette-item", "monitors");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(highlighted).toHaveAttribute("data-palette-item", "pages");
  await page.keyboard.press("Enter");
  await expectPath(page, "/admin/pages");
  await expect(page.locator("[data-slot=palette]")).toHaveCount(0);
  // The key N types ى on an Arabic layout; the shortcut, taken on the monitor list alone, follows the physical key.
  await page.click("a[data-nav=monitors]");
  await expectPath(page, "/admin/monitors");
  await page.dispatchEvent("body", "keydown", { code: "KeyN", key: "ى" });
  await expectPath(page, "/admin/monitors/new");
});

test("an admin address nothing matches shows the shell with a title and a way back to the monitors", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/no-such-page`);
  await expect(page.locator("[data-slot=page] h1")).toHaveCount(1);
  await page.click("[data-slot=missing-back]");
  await expectPath(page, "/admin/monitors");
});

test("the question mark opens the shortcut sheet and Escape closes it", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Shift+Slash");
  await expect(page.locator("[data-slot=shortcut-sheet]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-slot=shortcut-sheet]")).toHaveCount(0);
});

test("Ctrl+B collapses the sidebar and the choice survives a reload", async ({
  page,
}) => {
  await signIn(page);
  await page.keyboard.press("Control+b");
  await expect(
    page.locator("[data-slot=sidebar][data-state=collapsed]")
  ).toHaveCount(1);
  await page.reload();
  await expect(
    page.locator("[data-slot=sidebar][data-state=collapsed]")
  ).toHaveCount(1);
  await page.keyboard.press("Control+b");
  await expect(
    page.locator("[data-slot=sidebar][data-state=expanded]")
  ).toHaveCount(1);
});

test("a collapsed sidebar keeps its links out of the tab order, and Ctrl+B with the focus inside it hands the focus to the toggle", async ({
  page,
}) => {
  await signIn(page);
  await page.locator("a[data-nav=monitors]").focus();
  await page.keyboard.press("Control+b");
  await expect(
    page.locator("[data-slot=sidebar][data-state=collapsed]")
  ).toHaveCount(1);
  await expect(page.locator("[data-slot=sidebar-trigger]")).toBeFocused();
  await expect
    .poll(() =>
      page.locator("a[data-nav]").evaluateAll(
        (links) =>
          links.filter((link) => {
            link.focus();
            return document.activeElement === link;
          }).length
      )
    )
    .toBe(0);
  await page.keyboard.press("Control+b");
  await expect(
    page.locator("[data-slot=sidebar][data-state=expanded]")
  ).toHaveCount(1);
  await page.locator("a[data-nav=monitors]").focus();
  await expect(page.locator("a[data-nav=monitors]")).toBeFocused();
});

/** The phone's sheet open on the monitor list; the shell is waited for at desktop width first, since the palette button lives in the sheet there. */
async function openPhoneSheet(page: Page) {
  await signIn(page);
  await page.setViewportSize({ height: 844, width: 390 });
  // The desktop panel unmounts once the media query matches; a click before would collapse it instead.
  await expect(page.locator("[data-slot=sidebar][data-state]")).toHaveCount(0);
  await page.click("[data-slot=sidebar-trigger]");
  const sheet = page.locator("[data-slot=sidebar][data-mobile=true]");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("on a phone the sidebar sheet closes when a link in it is followed", async ({
  page,
}) => {
  const sheet = await openPhoneSheet(page);
  await sheet.locator("a[data-nav=settings]").click();
  await expectPath(page, "/admin/settings");
  await expect(sheet).toHaveCount(0);
});

test("on a phone the sidebar sheet closes when the link to the current page is tapped", async ({
  page,
}) => {
  const sheet = await openPhoneSheet(page);
  await sheet.locator("a[data-nav=monitors]").click();
  await expectPath(page, "/admin/monitors");
  await expect(sheet).toHaveCount(0);
});

test("on a phone the sidebar sheet closes when the palette searches the monitor list", async ({
  page,
}) => {
  const sheet = await openPhoneSheet(page);
  await page.keyboard.press("Control+k");
  await expect(page.locator("[data-slot=palette]")).toBeVisible();
  await page.locator("[data-slot=palette-input]").fill("zzz");
  await page.locator("[data-palette-item=search_monitors]").click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("zzz");
  await expect(sheet).toHaveCount(0);
});

test("on a phone a refresh of the page behind the sheet leaves it open", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await page
    .locator("[data-slot=monitor-list] a[href^='/admin/monitors/']")
    .first()
    .click();
  await expect(page.locator("[data-slot=monitor-summary]")).toBeVisible();
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.locator("[data-slot=sidebar][data-state]")).toHaveCount(0);
  await page.click("[data-slot=sidebar-trigger]");
  const sheet = page.locator("[data-slot=sidebar][data-mobile=true]");
  await expect(sheet).toBeVisible();
  // The detail page re-reads itself every 30 seconds through the router's invalidate.
  const refreshed = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith("/_serverFn/")
  );
  await page.clock.fastForward(31_000);
  await refreshed;
  await expect(sheet).toBeVisible();
});

test("a form's Save rests until something changes, Ctrl+S presses it, and a create lands on the new record with a toast", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/components/new`);
  const save = page.locator("[data-slot=save-component]");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  // Resting, Enter in a field submits nothing: the page stays the new-component form.
  await page.fill("input[name=name-en]", "");
  await page.press("input[name=name-en]", "Enter");
  await expectPath(page, "/admin/components/new");

  await page.fill("input[name=name-en]", "Save flow");
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => new URL(page.url()).pathname)
    .not.toBe("/admin/components/new");
  await expect(page.locator("[data-slot=toast]")).toBeVisible();
  // The address changes before the record's page arrives, and the new form stays on screen until it does.
  await expect(page.locator("[data-slot=delete-component]")).toBeVisible();

  // On the stored component's page Save rests again, and a field changed back reads unchanged.
  const stored = page.locator("[data-slot=save-component]");
  await expect(stored).toHaveAttribute("aria-disabled", "true");
  await page.fill("input[name=name-en]", "Save flow 2");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=unsaved]")
  ).toBeVisible();
  await page.fill("input[name=name-en]", "Save flow");
  await expect(stored).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=none]")
  ).toHaveCount(1);
  await page.fill("input[name=name-en]", "Save flow 2");
  await page.press("input[name=name-en]", "Enter");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();
  await expect(stored).toHaveAttribute("aria-disabled", "true");

  await page.click("[data-slot=delete-component]");
  await page.click("[data-slot=confirm-delete]");
  await expectPath(page, "/admin/components");
  // The delete's own toast, not the save's before it.
  await expect(
    page.locator("[data-slot=toast]", { hasText: "deleted" })
  ).toBeVisible();
});

/** The server functions the page calls from now on, by path: each is one round trip. */
function serverCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/_serverFn/")) {
      calls.push(path);
    }
  });
  return calls;
}

test("a click between admin pages makes one round trip, the page's own read", async ({
  page,
}) => {
  await signIn(page);
  const calls = serverCalls(page);
  await page.click("a[data-nav=channels]");
  await expectPath(page, "/admin/channels");
  // The channel list's own action: the page has arrived, every blocking read is done.
  await expect(page.locator("[data-slot=add-channel]")).toBeVisible();
  expect(calls).toHaveLength(1);
});

test("a hover on an admin link reads its page, so the click that follows makes no round trip", async ({
  page,
}) => {
  await signIn(page);
  const calls = serverCalls(page);
  await page.hover("a[data-nav=channels]");
  await expect.poll(() => calls.length).toBe(1);
  await page.click("a[data-nav=channels]");
  await expect(page.locator("[data-slot=add-channel]")).toBeVisible();
  expect(calls).toHaveLength(1);
});

test("a click after the session ended lands on sign-in, never on the page", async ({
  context,
  page,
}) => {
  await signIn(page);
  await context.clearCookies();
  await page.click("a[data-nav=channels]");
  await expectPath(page, "/sign-in");
});

test("a page slower than the pending time shows the skeleton, with its loading label, until it arrives", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/_serverFn/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.click("a[data-nav=channels]");
  await expect(
    page.locator("[data-slot=page-skeleton][role=status]")
  ).toBeVisible();
  await expect(
    page.locator("[data-slot=page-skeleton] .sr-only")
  ).not.toBeEmpty();
  await expectPath(page, "/admin/channels");
  await expect(page.locator("[data-slot=page-skeleton]")).toHaveCount(0);
  // The channel list's own action: the page has arrived, every blocking read is done.
  await expect(page.locator("[data-slot=add-channel]")).toBeVisible();
});

/** Holds every request of the page from now on for 1.5 seconds, the page's code as well as its reads: a slow network. */
async function slowNetwork(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
}

/** Records, on every frame from now on, what the screen lacked: the shell, or any page (the one left, the skeleton or the one arrived); and whether the skeleton showed. */
async function watchNavigation(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const record = window as unknown as { frames: Set<string> };
    record.frames = new Set();
    const shown = (selector: string) =>
      document.querySelector(selector)?.checkVisibility() === true;
    const frame = () => {
      if (!shown("[data-slot=sidebar]")) {
        record.frames.add("no shell");
      }
      if (!(shown("[data-slot=page]") || shown("[data-slot=page-skeleton]"))) {
        record.frames.add("no page");
      }
      if (shown("[data-slot=page-skeleton]")) {
        record.frames.add("skeleton");
      }
      requestAnimationFrame(frame);
    };
    frame();
  });
  return () =>
    page.evaluate(() => [
      ...(window as unknown as { frames: Set<string> }).frames,
    ]);
}

test("a click on a slow network, before the shell has loaded the pages' skeletons, keeps the shell on screen", async ({
  page,
}) => {
  await signIn(page);
  await slowNetwork(page);
  await page.goto(`${englishOrigin}/admin/monitors`);
  const frames = await watchNavigation(page);
  await page.click("a[data-nav=incidents]");
  await expectPath(page, "/admin/incidents");
  // The incident list's own action: the page has arrived.
  await expect(page.locator("[data-slot=add-incident]")).toBeVisible();
  expect(await frames()).not.toContain("no shell");
});

test("a click between settings pages on a slow network, before their skeletons have loaded, keeps the settings title and its row of pages on screen", async ({
  page,
}) => {
  await signIn(page);
  await slowNetwork(page);
  await page.goto(`${englishOrigin}/admin/settings`);
  const frames = await watchNavigation(page);
  await page.click("a[href='/admin/settings/storage']");
  await expectPath(page, "/admin/settings/storage");
  await expect(page.locator("[data-slot=used-size]")).toBeVisible();
  expect(await frames()).not.toContain("no page");
});

test("once the shell has settled, a click on a slow network shows the page's skeleton in the shell until the page arrives, never an empty frame", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/monitors`);
  // The shell has loaded what it loads after it mounts.
  await page.waitForLoadState("networkidle");
  await slowNetwork(page);
  const frames = await watchNavigation(page);
  await page.click("a[data-nav=maintenance]");
  await expectPath(page, "/admin/maintenance");
  // The maintenance list's own action: the page has arrived.
  await expect(page.locator("[data-slot=add-window]")).toBeVisible();
  expect(await frames()).toEqual(["skeleton"]);
});

test("a page whose read failed shows the error inside the shell, never its text, and try again reads it again", async ({
  page,
}) => {
  await signIn(page);
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
  await page.click("a[data-nav=channels]");
  await expect(page.locator("[data-slot=page-error]")).toBeVisible();
  await expect(page.locator("[data-slot=sidebar]")).toBeVisible();
  await expect(page.locator("nav a[data-nav]")).toHaveCount(7);
  await expect(page.locator("[data-slot=page] h1")).toHaveCount(1);
  await expect(page.getByText("a private failure")).toHaveCount(0);

  await page.unroute("**/_serverFn/**");
  await page.click("[data-slot=page-error] button[name=retry]");
  await expect(page.locator("[data-slot=add-channel]")).toBeVisible();
  await expect(page.locator("[data-slot=page-error]")).toHaveCount(0);
});

/** Creates a webhook channel and stays on its page, which shows the generated signing secret. */
async function openChannelWithSecret(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/admin/channels/new`);
  await page.fill(
    "[data-slot=channel-form] input[name=name]",
    `Back ${Date.now()}`
  );
  await page.fill(
    "[data-slot=channel-form] input[name=url]",
    `${sinkOrigin}/ok/back`
  );
  await page.click("[data-slot=channel-form] button[type=submit]");
  await expect(page.locator("[data-slot=signing-secret]")).toBeVisible();
}

/** Records, from now on and in every document the tab loads, whether the admin shell or a signing secret is ever on screen, even for one frame. */
async function watchAdminData(page: Page): Promise<() => Promise<boolean>> {
  // Signing out and Back each load a new document; the tab's session storage outlives them.
  const watch = () => {
    const record = () => {
      if (
        document.querySelector(
          "[data-slot=signing-secret], [data-slot=sidebar]"
        ) !== null
      ) {
        sessionStorage.setItem("sawAdmin", "yes");
      }
    };
    record();
    new MutationObserver(record).observe(document, {
      childList: true,
      subtree: true,
    });
  };
  await page.addInitScript(watch);
  await page.evaluate(watch);
  return async () =>
    (await page.evaluate(() => sessionStorage.getItem("sawAdmin"))) === "yes";
}

test("cancelling a sign-out goes back to the page it was asked from", async ({
  page,
}) => {
  await signIn(page);
  await page.click("a[data-nav=channels]");
  await expectPath(page, "/admin/channels");
  await page.click("[data-slot=sidebar-footer] a");
  await expectPath(page, "/sign-out");
  await page.click("[data-slot=sign-out-cancel]");
  await expectPath(page, "/admin/channels");
});

test("Back after signing out lands on sign-in and never shows the admin page it left", async ({
  page,
}) => {
  await signIn(page);
  await openChannelWithSecret(page);
  await page.click("[data-slot=sidebar-footer] a");
  await expectPath(page, "/sign-out");
  await page.click("form button[type=submit]");
  await expectPath(page, "/sign-in");
  const sawAdmin = await watchAdminData(page);
  await page.goBack();
  await expectPath(page, "/sign-out");
  await page.goBack();
  await expectPath(page, "/sign-in");
  expect(await sawAdmin()).toBe(false);
});

test("Back into the admin after the session ended lands on sign-in and never shows the page it left", async ({
  context,
  page,
}) => {
  await signIn(page);
  await openChannelWithSecret(page);
  await page.click("[data-slot=sidebar-footer] a");
  await expectPath(page, "/sign-out");
  // The address changes before the sign-out page renders; the watch starts once the admin page is gone.
  await expect(page.locator("[data-slot=sidebar]")).toHaveCount(0);
  await context.clearCookies();
  const sawAdmin = await watchAdminData(page);
  await page.goBack();
  await expectPath(page, "/sign-in");
  expect(await sawAdmin()).toBe(false);
});

test("a click to the export page after the session ended lands on sign-in", async ({
  context,
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/settings`);
  await context.clearCookies();
  await page.click("a[href='/admin/settings/export']");
  await expectPath(page, "/sign-in");
});

// The settings saves run on an install of their own: the English install's public address, clock and retention are read by other specs.
// Each worker starts its own install, so no two of these tests save at once, and each puts back what it changes.
test.describe("the settings saves, on an install of their own", () => {
  let install: Install | undefined;
  let origin = "";

  test.beforeAll(async () => {
    install = await spawnInstall({ account: true });
    ({ origin } = install);
  });

  test.afterAll(async () => {
    await install?.stop();
  });

  test("a settings save without a session is refused and sent to sign-in; nothing is stored", async ({
    context,
    page,
  }) => {
    await signIn(page, origin);
    await page.goto(`${origin}/admin/settings`);
    await context.clearCookies();
    await page.click("[role=radio][data-value='24h']");
    await page.click("[data-slot=general-form] button[type=submit]");
    await expectPath(page, "/sign-in");
    await signIn(page, origin);
    await page.goto(`${origin}/admin/settings`);
    await expect(
      page.locator("[role=radio][data-value='12h']")
    ).toHaveAttribute("aria-checked", "true");
  });

  test("the general page round-trips the clock format, shows the database as the install's own choice and the trusted proxies as the environment's", async ({
    page,
  }) => {
    await signIn(page, origin);
    await page.goto(`${origin}/admin/settings`);
    await expect(page.locator("input#database")).toBeDisabled();
    await expect(
      page.locator("[data-managed]:has(input#database)")
    ).toHaveCount(0);
    // The install is started with --trusted-proxies, so that field alone is managed by environment.
    const proxies = page.locator(
      "[data-managed=environment]:has(input#trustedProxies)"
    );
    await expect(proxies.locator("input")).toBeDisabled();
    await expect(proxies.locator("input")).toHaveValue("127.0.0.1");
    await expect(page.locator("[data-slot=managed-note]")).toHaveCount(1);
    await page.click("[role=radio][data-value='24h']");
    await page.click("[data-slot=general-form] button[type=submit]");
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toHaveCount(1);
    await page.reload();
    await expect(
      page.locator("[role=radio][data-value='24h']")
    ).toHaveAttribute("aria-checked", "true");
    await page.click("[role=radio][data-value='12h']");
    await page.click("[data-slot=general-form] button[type=submit]");
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toHaveCount(1);
    await page.reload();
    await expect(
      page.locator("[role=radio][data-value='12h']")
    ).toHaveAttribute("aria-checked", "true");
  });

  test("the storage page round-trips the retention and the size budget, and shows the used size and the free disk", async ({
    page,
  }) => {
    await signIn(page, origin);
    await page.goto(`${origin}/admin/settings`);
    await page.click("a[href='/admin/settings/storage']");
    await expectPath(page, "/admin/settings/storage");
    await expect(page.locator("[data-slot=used-size]")).toHaveCount(1);
    await expect(page.locator("[data-slot=free-disk]")).toHaveCount(1);
    await page.fill("input#retentionDays", "45");
    await page.fill("input#sizeBudget", "1024");
    await page.click("[data-slot=storage-form] button[type=submit]");
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toHaveCount(1);
    await page.reload();
    await expect(page.locator("input#retentionDays")).toHaveValue("45");
    await expect(page.locator("input#sizeBudget")).toHaveValue("1024");
    // A budget under 64 MB is refused on the page and nothing is stored.
    await page.fill("input#sizeBudget", "10");
    await page.click("[data-slot=storage-form] button[type=submit]");
    await expect(page.locator("input#sizeBudget")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    // Back to the defaults: 90 days, unlimited.
    await page.fill("input#retentionDays", "90");
    await page.fill("input#sizeBudget", "");
    await page.click("[data-slot=storage-form] button[type=submit]");
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toHaveCount(1);
    await page.reload();
    await expect(page.locator("input#retentionDays")).toHaveValue("90");
    await expect(page.locator("input#sizeBudget")).toHaveValue("");
  });
});

test("a refused save hands the focus to the first refused field, and the refusal goes as soon as the field is fixed", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/components/new`);
  const name = page.locator("input[name=name-en]");
  await name.fill("x".repeat(101));
  await page.click("[data-slot=save-component]");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  const refusal = page.locator("#name-error");
  await expect(refusal).toBeVisible();
  await expect(name).toHaveAttribute("aria-describedby", describedByError);

  await name.press("Backspace");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await expect(refusal).toHaveCount(0);
  await expectPath(page, "/admin/components/new");
});

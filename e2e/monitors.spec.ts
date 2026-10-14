// The monitors list and the
// monitor form on the built entry, signed in on the English
// server, which is seeded with nine monitors. The tests that count the
// seeded rows or follow the monitor the form saves run in order in one
// worker, so a count never depends on another test's timing; the rest read
// or make records no ordered test counts. Other files add monitors of their
// own to the same install meanwhile, so every count here is of the rows this
// file knows by name.

import type { Page } from "@playwright/test";
import { gettingStartedClosed } from "@/server/settings/getting-started.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { seedLongMonitor, seedMonitors } from "./support/monitors.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";
import { spawnInstall } from "./support/spawn.ts";

// The created monitor's exact name: the seeded API monitor's target also ends in /health.
const healthName = /^Health$/;
const renamedName = /^Health check$/;
const editPath = /^\/admin\/monitors\/[^/]+\/edit$/;
// A monitor's detail page: its id is a UUID, so /admin/monitors/new never matches.
const detailPath = /^\/admin\/monitors\/[0-9a-f-]{36}$/;
const websiteName = /^Website$/;
const backupName = /^Nightly backup$/;
// The seeded monitors and the one this file saves under each of its names.
const knownName =
  /^(Website|API|Mail|DNS|Staging site|Database|Nightly backup|Docs|Zz deletable|Health|Health check)$/;

/** The list's rows this file knows by name; another spec's monitors never count. */
function knownRows(page: Page) {
  return page.locator("[data-monitor]", {
    has: page.locator("[data-slot=monitor-name]", { hasText: knownName }),
  });
}

async function signIn(page: Page, path = "/admin/monitors"): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
  if (path === "/admin/monitors") {
    await expect(page.locator("[data-slot=monitor-list]")).toBeVisible();
    return;
  }
  await page.goto(`${englishOrigin}${path}`);
  await expect(page.locator("[data-slot=monitor-form]")).toBeVisible();
}

/** Opens a monitor's detail page from the list by its name. */
async function openDetail(page: Page, name: RegExp): Promise<string> {
  await signIn(page);
  const link = page.locator("[data-slot=monitor-name]", { hasText: name });
  await link.click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
  await expect(page.locator("[data-slot=monitor-summary]")).toBeVisible();
  return new URL(page.url()).pathname;
}

/** The start time of the newest check the page shows, or null with none. */
function newestCheck(page: Page): Promise<string | null> {
  return page
    .locator("[data-slot=recent-checks] [data-check]")
    .evaluateAll((rows) => rows[0]?.getAttribute("data-check") ?? null);
}

// On an install of its own: another spec's long group or tag widens the list's filters, which then wrap and push the rows down.
test("eight monitors fit an 800 px screen, sorted by name, each with its target as a token", async ({
  page,
}) => {
  const install = await spawnInstall({
    account: true,
    language: "en",
    records: async (storage) => {
      // Past getting started, as on the English install: the list is measured as an operator who dismissed the checklist sees it.
      await storage.settings.set(gettingStartedClosed, true);
      await seedMonitors(storage);
    },
  });
  try {
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.goto(`${install.origin}/sign-in`);
    await page.fill("input[name=email]", operatorEmail);
    await page.fill("input[name=password]", operatorPassword);
    await page.click("form button[type=submit]");
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("[data-slot=monitor-list] table")).toHaveCount(1);
    await expect(knownRows(page)).toHaveCount(9);
    const names = page.locator("[data-monitor] [data-slot=monitor-name]");
    const texts = await names.allTextContents();
    expect(texts).toEqual([...texts].sort((a, b) => a.localeCompare(b, "en")));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        expect(page.locator("[data-monitor]").nth(index)).toBeInViewport({
          ratio: 1,
        })
      )
    );
    const website = page.locator("[data-monitor]", { hasText: "Website" });
    await expect(website.locator("[data-slot=token]")).toHaveText(
      "http://127.0.0.1:1/"
    );
    await expect(website.locator("[data-slot=monitor-group]")).toHaveText(
      "Production"
    );
    await expect(website.locator("[data-slot=monitor-tag]")).toHaveText([
      "public",
    ]);
  } finally {
    await install.stop();
  }
});

// Beside the open sidebar, the frame is 256 px narrower than the screen, so a layout keyed to the screen overflows it between a tablet and a laptop.
for (const language of ["en", "ar"] as const) {
  test(`the list fits its frame beside the open sidebar from a tablet to a wide screen, in ${language}`, async ({
    page,
  }) => {
    const install = await spawnInstall({
      account: true,
      language,
      records: async (storage) => {
        await storage.settings.set(gettingStartedClosed, true);
        await seedMonitors(storage);
        await seedLongMonitor(storage);
      },
    });
    try {
      await page.goto(`${install.origin}/sign-in`);
      await page.fill("input[name=email]", operatorEmail);
      await page.fill("input[name=password]", operatorPassword);
      await page.click("form button[type=submit]");
      await expectPath(page, "/admin/monitors");
      const frame = page.locator(
        "[data-slot=monitor-list] [data-slot=table-container]"
      );
      await expect(frame).toBeVisible();
      for (const width of [768, 1024, 1060, 1100, 1180, 1280, 1366, 1440]) {
        // biome-ignore lint/performance/noAwaitInLoops: one width at a time, each measured after its own layout
        await page.setViewportSize({ height: 800, width });
        await expect
          .poll(
            () =>
              frame.evaluate((element) => ({
                frame: element.scrollWidth - element.clientWidth,
                page:
                  (document.scrollingElement?.scrollWidth ?? 0) -
                  (document.scrollingElement?.clientWidth ?? 0),
              })),
            { message: `${width} px` }
          )
          .toEqual({ frame: 0, page: 0 });
      }
    } finally {
      await install.stop();
    }
  });
}

// In order: the counts read the seeded rows before and after the delete, and the later tests open the Health monitor the form saves and renames.
test.describe("the seeded list and the Health monitor, changed in order", () => {
  test.describe.configure({ mode: "serial" });

  test("the search, the group filter, the tag filter and the sort live in the URL, and `/` focuses the search", async ({
    page,
  }) => {
    await signIn(page);
    await page.keyboard.press("/");
    await expect(page.locator("input[name=q]")).toBeFocused();
    await page.keyboard.type("127.0.0.1:1/health");
    await expect(page.locator("[data-monitor]")).toHaveCount(1);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBe("127.0.0.1:1/health");

    await page.goto(`${englishOrigin}/admin/monitors?group=Staging`);
    await expect(page.locator("[data-monitor]")).toHaveCount(2);
    await page.selectOption("select[name=tag]", "critical");
    await expect(page.locator("[data-monitor]")).toHaveCount(1);
    await expect(
      page.locator("[data-monitor] [data-slot=monitor-name]")
    ).toHaveText("Database");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tag"))
      .toBe("critical");

    await page.goto(`${englishOrigin}/admin/monitors?q=nothing-matches`);
    await expect(page.locator("[data-slot=monitor-no-matches]")).toHaveCount(1);
    await page.click("[data-slot=monitor-no-matches] button");
    await expect(knownRows(page)).toHaveCount(9);
    await expect.poll(() => new URL(page.url()).search).toBe("");

    // A shared link naming a group no monitor carries: the select says so rather than "all groups".
    await page.goto(`${englishOrigin}/admin/monitors?group=Nowhere`);
    await expect(page.locator("select[name=group]")).toHaveValue("Nowhere");
    await expect(page.locator("[data-slot=monitor-no-matches]")).toHaveCount(1);

    await page.goto(`${englishOrigin}/admin/monitors?sort=newest`);
    await expect(
      knownRows(page).first().locator("[data-slot=monitor-name]")
    ).toHaveText("Zz deletable");
  });

  test("select all, pause and resume in bulk: paused monitors say so and pausing again is a no-op", async ({
    page,
  }) => {
    await signIn(page);
    // Select all takes the monitors shown; only the Staging group's, as other specs read the rest meanwhile, Website among them.
    await page.goto(`${englishOrigin}/admin/monitors?group=Staging`);
    await page.click("[data-slot=monitor-select-all]");
    await expect(page.locator("[data-slot=monitor-bulk]")).toContainText("2");
    await page.click("[data-slot=monitor-bulk] [data-action=pause]");
    await expect(page.locator("[data-slot=monitor-paused]")).toHaveCount(2);
    await expect(page.locator("[data-slot=monitor-bulk]")).toHaveCount(0);
    await page.click("[data-slot=monitor-select-all]");
    await page.click("[data-slot=monitor-bulk] [data-action=pause]");
    await expect(page.locator("[data-slot=monitor-bulk]")).toHaveCount(0);
    await expect(page.locator("[data-slot=monitor-paused]")).toHaveCount(2);
    await page.click("[data-slot=monitor-select-all]");
    await page.click("[data-slot=monitor-bulk] [data-action=resume]");
    await expect(page.locator("[data-slot=monitor-paused]")).toHaveCount(0);
  });

  test("with some monitors selected, select all reads as mixed, and deleting one selected names it", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/monitors?group=Staging`);
    const selectAll = page.locator("[data-slot=monitor-select-all]");
    await knownRows(page).first().locator("[role=checkbox]").click();
    await expect(selectAll).toHaveAttribute("aria-checked", "mixed");
    await page.click("[data-slot=monitor-bulk] [data-action=delete]");
    await expect(
      page.locator(
        "[data-slot=monitor-delete-dialog] [data-slot=monitor-delete-name]"
      )
    ).toHaveText(
      (await knownRows(page)
        .first()
        .locator("[data-slot=monitor-name]")
        .textContent()) ?? ""
    );
    await page.keyboard.press("Escape");
    await knownRows(page).nth(1).locator("[role=checkbox]").click();
    await expect(selectAll).toHaveAttribute("aria-checked", "true");
  });

  test("add a tag in bulk: a tag with a comma is refused, then every selected monitor carries the tag and a reload keeps it", async ({
    page,
  }) => {
    await signIn(page);
    // Only the Staging group's monitors, as in the bulk pause above.
    await page.goto(`${englishOrigin}/admin/monitors?group=Staging`);
    await page.click("[data-slot=monitor-select-all]");
    await page.click("[data-slot=monitor-bulk] [data-action=change]");
    await page.click("[data-change=add_tag]");
    const dialog = page.locator("[data-slot=monitor-change-dialog]");
    await dialog.locator("input[name=tag]").fill("on-call, nights");
    await dialog.locator("[data-slot=monitor-change-apply]").click();
    await expect(
      dialog.locator("[data-slot=monitor-change-refusal]")
    ).toBeVisible();
    await dialog.locator("input[name=tag]").fill("on-call");
    await dialog.locator("[data-slot=monitor-change-apply]").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-slot=monitor-bulk]")).toHaveCount(0);
    const tagged = page.locator("[data-monitor]", {
      has: page.locator("[data-slot=monitor-tag]", { hasText: "on-call" }),
    });
    await expect(tagged).toHaveCount(2);
    await page.reload();
    await expect(tagged).toHaveCount(2);
  });

  // The shared AlertDialog keeps focus in, as every delete and remove confirm
  // does. Base UI's focus guard moves focus a frame after Tab reaches
  // it, so each key waits for focus to land, as a person's
  // keys do; two keys inside one frame step past the guard.
  test("Tab past a confirm dialog's last button returns to its first, and Shift+Tab past the first to the last", async ({
    page,
  }) => {
    await signIn(page);
    const item = page.locator("[data-monitor]", { hasText: "Zz deletable" });
    await item.locator("[data-slot=monitor-menu]").click();
    await page.click(
      "[data-slot=dropdown-menu-item][data-variant=destructive]"
    );
    const cancel = page.locator("[data-slot=alert-dialog-cancel]");
    const confirm = page.locator("[data-slot=monitor-delete-confirm]");
    await expect(cancel).toBeFocused();
    for (const next of [confirm, cancel, confirm, cancel]) {
      // biome-ignore lint/performance/noAwaitInLoops: each key waits for focus to land before the next, in order
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();
    }
    for (const previous of [confirm, cancel, confirm, cancel]) {
      // biome-ignore lint/performance/noAwaitInLoops: each key waits for focus to land before the next, in order
      await page.keyboard.press("Shift+Tab");
      await expect(previous).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-slot=monitor-delete-dialog]")).toHaveCount(
      0
    );
  });

  test("deleting from the item menu asks first, then removes the monitor", async ({
    page,
  }) => {
    await signIn(page);
    const item = page.locator("[data-monitor]", { hasText: "Zz deletable" });
    await item.locator("[data-slot=monitor-menu]").click();
    await page.click(
      "[data-slot=dropdown-menu-item][data-variant=destructive]"
    );
    await expect(
      page.locator("[data-slot=monitor-delete-dialog]")
    ).toBeVisible();
    await expect(
      page.locator("[data-slot=monitor-delete-dialog] bdi")
    ).toHaveText("Zz deletable");
    await page.click("[data-slot=alert-dialog-cancel]");
    await expect(knownRows(page)).toHaveCount(9);
    await item.locator("[data-slot=monitor-menu]").click();
    await page.click(
      "[data-slot=dropdown-menu-item][data-variant=destructive]"
    );
    await page.click("[data-slot=monitor-delete-confirm]");
    await expect(knownRows(page)).toHaveCount(8);
    await page.reload();
    await expect(knownRows(page)).toHaveCount(8);
  });

  test("the form creates an HTTP monitor with an added assertion and a header, tests it against the server's own /health, and saves it, landing on its detail page", async ({
    page,
  }) => {
    await signIn(page, "/admin/monitors/new");
    await page.fill("input[name=name]", "Health");
    await page.fill("input[name=url]", `${englishOrigin}/health`);
    await page.click("[data-slot=add-assertion]");
    await page.selectOption(
      "select[name='assertions.1.kind']",
      "body_contains"
    );
    await page.fill("input[name='assertions.1.text']", "scheduler");
    await page.click("[data-slot=add-header]");
    await page.fill("input[name='headers.0.name']", "X-Probe");
    await page.fill("input[name='headers.0.value']", "secret-probe-value");
    await page.click("[data-slot=test-now]");
    await expect(
      page.locator("[data-slot=test-result][data-result=up]")
    ).toBeVisible();
    await expect(
      page.locator("[data-slot=assertion-state][data-state=passed]")
    ).toHaveCount(2);
    await page.click("[data-slot=save-monitor]");
    await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
    await expect(page.locator("h1")).toHaveText(healthName);
    await expect(page.locator("[data-slot=monitor-summary]")).toBeVisible();
  });

  test("the edit form shows a stored header by name only, never its value, and saves a rename, returning to the detail page", async ({
    page,
  }) => {
    await signIn(page);
    const item = page.locator("[data-monitor]", {
      has: page.locator("[data-slot=monitor-name]", { hasText: healthName }),
    });
    const id = await item.getAttribute("data-monitor");
    await page.goto(`${englishOrigin}/admin/monitors/${id}/edit`);
    await expect(page.locator("input[name='headers.0.name']")).toHaveValue(
      "X-Probe"
    );
    await expect(page.locator("input[name='headers.0.value']")).toHaveValue("");
    expect(await page.content()).not.toContain("secret-probe-value");
    await page.fill("input[name=name]", "Health check");
    await page.click("[data-slot=save-monitor]");
    await expectPath(page, `/admin/monitors/${id}`);
    await expect(page.locator("h1")).toHaveText(renamedName);
  });

  test("duplicate from the item menu opens the new-monitor form filled from the original, its header and value left out with a note, and from the detail page too", async ({
    page,
  }) => {
    await signIn(page);
    const item = page.locator("[data-monitor]", {
      has: page.locator("[data-slot=monitor-name]", { hasText: renamedName }),
    });
    const id = await item.getAttribute("data-monitor");
    await item.locator("[data-slot=monitor-menu]").click();
    await page.click("[data-action=duplicate]");
    await expectPath(page, "/admin/monitors/new");
    expect(new URL(page.url()).searchParams.get("copy")).toBe(id);
    await expect(page.locator("input[name=name]")).toHaveValue(
      "Copy of Health check"
    );
    await expect(page.locator("input[name=url]")).toHaveValue(
      `${englishOrigin}/health`
    );
    await expect(page.locator("select[name='assertions.1.kind']")).toHaveValue(
      "body_contains"
    );
    await expect(page.locator("input[name='headers.0.name']")).toHaveCount(0);
    await expect(
      page.locator("[data-slot=credentials-not-copied]")
    ).toBeVisible();
    expect(await page.content()).not.toContain("secret-probe-value");
    await page.goto(`${englishOrigin}/admin/monitors/${id}`);
    await page.click("[data-slot=duplicate-monitor]");
    await expectPath(page, "/admin/monitors/new");
    await expect(page.locator("input[name=name]")).toHaveValue(
      "Copy of Health check"
    );
    // Nothing was written: the list still holds the nine monitors it had.
    await page.goto(`${englishOrigin}/admin/monitors`);
    await expect(knownRows(page)).toHaveCount(9);
  });

  test("the detail page shows the state, the target as a token, uptime over four windows and the response-time chart; check now records a check, shown even after another check landed unread", async ({
    context,
    page,
  }) => {
    await openDetail(page, renamedName);
    await expect(page.locator("[data-slot=monitor-target]")).toHaveText(
      `${englishOrigin}/health`
    );
    await expect(page.locator("[data-slot=uptime]")).toHaveCount(4);
    await expect(page.locator("[data-slot=response-chart] svg")).toBeVisible();
    // The race forced: another check lands that this page has not read, then the one it asks for, and only then does it read again.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname.startsWith("/_serverFn/"),
      async (route) => {
        if (route.request().method() === "GET") {
          await held;
        }
        await route.continue();
      }
    );
    const other = await context.newPage();
    await other.goto(page.url());
    await other.waitForFunction(() => window.__reactCommitted === true);
    const unread = await newestCheck(other);
    await other.click("[data-slot=check-now]");
    await expect.poll(() => newestCheck(other)).not.toBe(unread);
    const landed = await newestCheck(other);
    await page.click("[data-slot=check-now]");
    await expect
      .poll(async () => {
        await other.reload();
        return newestCheck(other);
      })
      .not.toBe(landed);
    const asked = await newestCheck(other);
    release();
    // A row count passes over before + 1 when both checks arrive in one read, and stops at the list's 20 rows.
    await expect.poll(() => newestCheck(page), { timeout: 20_000 }).toBe(asked);
    await expect(
      page.locator("[data-slot=monitor-state][data-state=up]")
    ).toBeVisible();
    await expect(page.locator("[data-slot=check-now]")).toBeEnabled();
  });

  test("dragging across the response-time chart zooms into the span, which the address keeps, the download follows, Escape leaves and the back button returns to", async ({
    page,
  }) => {
    await openDetail(page, renamedName);
    const plot = page.locator("[data-slot=chart-plot]");
    const box = await plot.boundingBox();
    if (!box) {
      throw new Error("the chart has no box");
    }
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("from"))
      .toBe(true);
    const zoomed = new URL(page.url());
    expect(Number(zoomed.searchParams.get("to"))).toBeGreaterThan(
      Number(zoomed.searchParams.get("from"))
    );
    await expect(page.locator("[data-slot=chart-zoom-out]")).toBeVisible();
    await expect(page.locator("[data-slot=history-download]")).toHaveAttribute(
      "href",
      new RegExp(`from=${zoomed.searchParams.get("from")}`)
    );
    await plot.focus();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => new URL(page.url()).searchParams.has("from"))
      .toBe(false);
    await expect(page.locator("[data-slot=chart-zoom-out]")).toHaveCount(0);
    await page.goBack();
    await expect(page.locator("[data-slot=chart-zoom-out]")).toBeVisible();
  });

  test("a day's card on the day bar over the chart zooms the chart to that UTC day and closes", async ({
    page,
  }) => {
    await openDetail(page, renamedName);
    // Yesterday, a whole day at any time of day; today's button waits out the first minutes after midnight.
    const yesterday =
      Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
    await page
      .locator("[data-slot=monitor-days] [data-slot=uptime-bar] button")
      .nth(-2)
      .click();
    await page.click("[data-slot=day-card] [data-slot=day-zoom]");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("from"))
      .toBe(String(yesterday));
    expect(new URL(page.url()).searchParams.get("to")).toBe(
      String(yesterday + 86_400_000)
    );
    await expect(page.locator("[data-slot=chart-zoom-out]")).toBeVisible();
    await expect(page.locator("[data-slot=day-card]")).toHaveCount(0);
  });

  test("the chart's range lives in the URL", async ({ page }) => {
    const path = await openDetail(page, renamedName);
    await page.click("[data-range='7d']");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("range"))
      .toBe("7d");
    await expect(page.locator("[data-range='7d']")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await page.reload();
    await expect(page.locator("[data-range='7d']")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(new URL(page.url()).pathname).toBe(path);
  });

  test("pause and resume from the detail page: a paused monitor says so and offers no check now", async ({
    page,
  }) => {
    await openDetail(page, renamedName);
    await page.click("[data-slot=toggle-paused]");
    await expect(page.locator("[data-slot=monitor-paused]")).toBeVisible();
    // A paused monitor runs no checks, so it offers none.
    await expect(page.locator("[data-slot=check-now]")).toHaveCount(0);
    await page.click("[data-slot=toggle-paused]");
    await expect(page.locator("[data-slot=monitor-paused]")).toHaveCount(0);
    await expect(page.locator("[data-slot=check-now]")).toBeEnabled();
  });

  test("the notifications card switches an event off and a reminder on, the edit keeps both, and the reminder waits for the down event", async ({
    page,
  }) => {
    await signIn(page);
    const item = page.locator("[data-monitor]", {
      has: page.locator("[data-slot=monitor-name]", { hasText: renamedName }),
    });
    const id = await item.getAttribute("data-monitor");
    const editPage = `${englishOrigin}/admin/monitors/${id}/edit`;
    await page.goto(editPage);
    const event = (kind: string) =>
      page.locator(`[data-slot=monitor-events] [data-event=${kind}]`);
    const reminder = page.locator("[data-slot=monitor-reminder]");
    await expect(event("down")).toBeChecked();
    await expect(event("recovered")).toBeChecked();
    // The monitor has no degraded threshold, so the pair cannot happen yet.
    await expect(event("degraded_started")).toBeDisabled();
    // It shows off while it cannot happen, whatever is stored (the screenshots' finding).
    await expect(event("degraded_started")).not.toBeChecked();
    await expect(reminder).not.toBeChecked();
    await expect(page.locator("select[name=reminderMs]")).toHaveCount(0);

    await event("recovered").click();
    await reminder.click();
    await page.selectOption("select[name=reminderMs]", "900000");
    await page.click("[data-slot=save-monitor]");
    await expectPath(page, `/admin/monitors/${id}`);

    await page.goto(editPage);
    await expect(event("recovered")).not.toBeChecked();
    await expect(reminder).toBeChecked();
    await expect(page.locator("select[name=reminderMs]")).toHaveValue("900000");
    await event("down").click();
    await expect(reminder).toBeDisabled();
    await expect(reminder).not.toBeChecked();
  });
});

test("N opens the new-monitor form", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("n");
  await expectPath(page, "/admin/monitors/new");
});

test("a caller with no session cannot pause monitors through the server function", async ({
  context,
  page,
}) => {
  await signIn(page);
  await context.clearCookies();
  await page.click("[data-slot=monitor-select-all]");
  await page.click("[data-slot=monitor-bulk] [data-action=pause]");
  await expectPath(page, "/sign-in");
});

test("cancelling an edit returns to the monitor's page, and cancelling a new monitor to the list", async ({
  page,
}) => {
  await signIn(page);
  const id = await page
    .locator("[data-monitor]")
    .first()
    .getAttribute("data-monitor");
  await page.goto(`${englishOrigin}/admin/monitors/${id}/edit`);
  await page.click("[data-slot=cancel-monitor]");
  await expectPath(page, `/admin/monitors/${id}`);
  await page.goto(`${englishOrigin}/admin/monitors/new`);
  await page.click("[data-slot=cancel-monitor]");
  await expectPath(page, "/admin/monitors");
});

test("a down check opens to its failure detail, the raw error as a token", async ({
  page,
}) => {
  await openDetail(page, websiteName);
  const down = page.locator(
    "[data-slot=recent-checks] [data-check][data-result=down]"
  );
  if ((await down.count()) === 0) {
    await page.click("[data-slot=check-now]");
    await expect(down.first()).toBeVisible({ timeout: 60_000 });
  }
  await down.first().locator("[data-slot=check-details]").click();
  await expect(page.locator("[data-slot=check-record] bdi")).not.toHaveCount(0);
  await expect(page.locator("[data-slot=outages]")).toBeVisible();
});

test("a heartbeat monitor's detail page shows its URL in place of the chart, and no check now; the URL and the line a job runs copy with a click", async ({
  page,
}) => {
  await openDetail(page, backupName);
  await expect(page.locator("[data-slot=heartbeat-url]")).toBeVisible();
  await expect(page.locator("[data-slot=response-chart]")).toHaveCount(0);
  await expect(page.locator("[data-slot=check-now]")).toHaveCount(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const url =
    (await page.locator("[data-slot=heartbeat-url]").textContent()) ?? "";
  await page.click("[data-copy=heartbeat-url]");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(url);
  await page.click("[data-copy=heartbeat-command]");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`curl -fsS -m 10 --retry 3 -o /dev/null ${url}`);
});

test("a refused field shows its message beside it and nothing is saved", async ({
  page,
}) => {
  await signIn(page, "/admin/monitors/new");
  await page.fill("input[name=name]", "Refused");
  await page.fill("input[name=url]", "ftp://example.com/");
  await page.click("[data-slot=save-monitor]");
  await expect(page.locator("[data-error-for='config.url']")).toBeVisible();
  await expectPath(page, "/admin/monitors/new");
  await page.goto(`${englishOrigin}/admin/monitors`);
  await expect(
    page.locator("[data-monitor]", { hasText: "Refused" })
  ).toHaveCount(0);
});

test("test now on a TCP monitor shows the address it connected to as a token", async ({
  page,
}) => {
  await signIn(page, "/admin/monitors/new");
  await page.fill("input[name=name]", "Own port");
  await page.click("[role=radio][data-value=tcp]");
  await page.fill("input[name=host]", "127.0.0.1");
  await page.fill("input[name=port]", new URL(englishOrigin).port);
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-result][data-result=up]")
  ).toBeVisible();
  await expect(
    page.locator("[data-slot=test-address] [data-slot=token]")
  ).toHaveText("127.0.0.1");
});

test("the form creates a heartbeat monitor and opens its edit page, where the new URL shows", async ({
  page,
}) => {
  await signIn(page, "/admin/monitors/new");
  await page.fill("input[name=name]", "Hourly sync");
  await page.click("[role=radio][data-value=heartbeat]");
  await page.fill("input[name=every]", "2");
  await page.click(
    "[role=radiogroup][data-name=everyUnit] [role=radio][data-value=hours]"
  );
  await page.click("[data-slot=save-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(editPath);
  await expect(page.locator("[data-slot=heartbeat-url]")).toContainText(
    `${englishOrigin}/api/heartbeat/`
  );
  await expect(page.locator("input[name=every]")).toHaveValue("2");
});

test("a Docker monitor's form lists the daemon's containers until the endpoint changes, one click names the container and test now reaches it; with no session the list goes to sign-in", async ({
  context,
  page,
}) => {
  // A fake Engine API on a Unix socket: the shapes a real daemon answers, cut to what the form reads.
  const directory = (await Bun.$`mktemp -d`.text()).trim();
  const socket = `${directory}/docker.sock`;
  const daemon = Bun.serve({
    fetch: (request) =>
      new URL(request.url).pathname === "/containers/json"
        ? Response.json([
            { Image: "nginx:1.30.5-alpine", Names: ["/api"], State: "running" },
            { Image: "alpine:3.22", Names: ["/batch"], State: "exited" },
          ])
        : Response.json({
            Name: "/api",
            State: { ExitCode: 0, Status: "running" },
          }),
    unix: socket,
  });
  try {
    await signIn(page, "/admin/monitors/new");
    await page.fill("input[name=name]", "API container");
    await page.click("[role=radio][data-value=docker]");
    await expect(page.locator("input[name=dockerEndpoint]")).toHaveValue(
      "/var/run/docker.sock"
    );
    await page.fill("input[name=dockerEndpoint]", socket);
    await page.click("[data-slot=list-containers]");
    const choices = page.locator(
      "[data-slot=container-choices] [data-container]"
    );
    await expect(choices).toHaveCount(2);
    // Another endpoint is another daemon: the list read from the first one goes.
    await page.fill("input[name=dockerEndpoint]", `${directory}/other.sock`);
    await expect(choices).toHaveCount(0);
    await page.fill("input[name=dockerEndpoint]", socket);
    await page.click("[data-slot=list-containers]");
    await expect(choices).toHaveCount(2);
    await page.click("[data-slot=container-choices] [data-container=api]");
    await expect(page.locator("input[name=container]")).toHaveValue("api");
    await page.click("[data-slot=test-now]");
    await expect(
      page.locator("[data-slot=test-result][data-result=up]")
    ).toBeVisible();
    await context.clearCookies();
    await page.click("[data-slot=list-containers]");
    await expectPath(page, "/sign-in");
  } finally {
    await daemon.stop(true);
    await Bun.$`rm -rf ${directory}`.quiet();
  }
});

// In order: the first reads the seeded heartbeat monitor before any call reaches it, and the second's call to the renewed URL is a heartbeat too.
test.describe("the seeded heartbeat monitor's URL", () => {
  test.describe.configure({ mode: "serial" });

  test("a heartbeat monitor's edit page shows its URL; a call to it is answered OK and shows as the last heartbeat with its source address", async ({
    page,
    request,
  }) => {
    await signIn(page);
    const item = page.locator("[data-monitor]", {
      has: page.locator("[data-slot=monitor-name]", {
        hasText: "Nightly backup",
      }),
    });
    const id = await item.getAttribute("data-monitor");
    await page.goto(`${englishOrigin}/admin/monitors/${id}/edit`);
    await expect(page.locator("[data-slot=monitor-form]")).toBeVisible();
    const url =
      (await page.locator("[data-slot=heartbeat-url]").textContent()) ?? "";
    expect(url.startsWith(`${englishOrigin}/api/heartbeat/`)).toBe(true);
    await expect(page.locator("[data-slot=last-heartbeat]")).toHaveCount(0);
    // The HEAD first: the last heartbeat is the POST, sent from the forwarded address.
    expect((await request.head(url)).status()).toBe(200);
    const answer = await request.post(url, {
      headers: { "x-forwarded-for": "198.51.100.4" },
    });
    expect(answer.status()).toBe(200);
    expect(await answer.text()).toBe("OK");
    expect(answer.headers()["cache-control"]).toBe("no-store");
    expect(
      (
        await request.get(`${englishOrigin}/api/heartbeat/${"A".repeat(22)}`)
      ).status()
    ).toBe(404);
    await page.reload();
    await expect(page.locator("[data-slot=last-heartbeat]")).toContainText(
      "198.51.100.4"
    );
  });

  test("a new URL retires the old one on save", async ({ page, request }) => {
    await signIn(page);
    const item = page.locator("[data-monitor]", {
      has: page.locator("[data-slot=monitor-name]", {
        hasText: "Nightly backup",
      }),
    });
    const id = await item.getAttribute("data-monitor");
    await page.goto(`${englishOrigin}/admin/monitors/${id}/edit`);
    const before =
      (await page.locator("[data-slot=heartbeat-url]").textContent()) ?? "";
    await page.click("[data-slot=renew-heartbeat-url]");
    await page.click("[data-slot=save-monitor]");
    await expectPath(page, `/admin/monitors/${id}`);
    await page.goto(`${englishOrigin}/admin/monitors/${id}/edit`);
    const after =
      (await page.locator("[data-slot=heartbeat-url]").textContent()) ?? "";
    expect(after).not.toBe(before);
    expect((await request.get(before)).status()).toBe(404);
    expect((await request.get(after)).status()).toBe(200);
  });
});

// What a visitor sees of the operator's work, on the built entry, on the
// English install: each test publishes a page of its own with components
// set by hand, writes through the admin's screens, and reads the public page
// from a browser with no session, as a visitor would. The seeded pages
// other specs read are never touched.

import type { Browser, Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { englishOrigin } from "./support/servers.ts";
import {
  fillTime,
  handComponent,
  idOf,
  publishedPage,
  runId,
  savePage,
  signIn,
  startingNow,
  wallTime,
} from "./support/status-page.ts";

const incidentPath = /^\/admin\/incidents\/[0-9a-f-]{36}$/;
const windowPath = /^\/admin\/maintenance\/[0-9a-f-]{36}$/;

/** A page in a browser with no session: a visitor's. */
async function visitorOf(
  browser: Browser,
  viewport = { height: 720, width: 1280 }
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  return await context.newPage();
}

/** Publishes an incident on one component and opens its page; its id. */
async function publishIncident(
  page: Page,
  componentId: string,
  title: string
): Promise<string> {
  await page.goto(`${englishOrigin}/admin/incidents/new`);
  await page.fill("input[name=title-en]", title);
  await page.fill("textarea[name=message-en]", "Some calls fail.");
  await page.click(
    "[data-slot=incident-impact-choice] [role=radio][data-value=major]"
  );
  await page.click(`[data-component="${componentId}"] [role=checkbox]`);
  await page.click(
    `[data-component="${componentId}"] [data-slot=incident-component-status] [role=radio][data-value=partial_outage]`
  );
  await page.click("[data-slot=create-incident]");
  return await idOf(page, incidentPath);
}

/** Posts an update at the stage, on the incident's open page, and waits for it in the timeline. */
async function postUpdate(
  page: Page,
  stage: string,
  updates: number
): Promise<void> {
  await page.click(
    `[data-slot=incident-stage-choice] [role=radio][data-value=${stage}]`
  );
  await page.fill("textarea[name=message-en]", `Now ${stage}.`);
  await page.click("[data-slot=post-update]");
  await expect(page.locator("[data-slot=incident-update]")).toHaveCount(
    updates
  );
}

test("an incident's life as the visitor sees it: published, each stage, a new title and impact, then resolved into the history", async ({
  browser,
  page,
}) => {
  const run = runId();
  const slug = `life-${run}`;
  await signIn(page);
  const componentId = await handComponent(page, `Api ${run}`);
  await publishedPage(page, slug, [componentId]);

  // With no component ticked, publishing is refused on the components and nothing is stored.
  await page.goto(`${englishOrigin}/admin/incidents/new`);
  await page.fill("input[name=title-en]", `Unticked ${run}`);
  await page.fill("textarea[name=message-en]", "No component.");
  await page.click("[data-slot=create-incident]");
  await expect(
    page.locator("[data-slot=save-outcome][data-reason=invalid]")
  ).toBeVisible();
  await expect(page.locator("[data-slot=field-error]")).toHaveCount(1);
  await expectPath(page, "/admin/incidents/new");

  const incidentId = await publishIncident(page, componentId, `Down ${run}`);
  const visitor = await visitorOf(browser);
  const overview = `${englishOrigin}/status/${slug}`;
  await visitor.goto(overview);
  const card = visitor.locator(
    `[data-slot=incident-card][data-incident="${incidentId}"]`
  );
  const component = visitor.locator(
    `[data-slot=page-component][data-component="${componentId}"] [data-slot=component-status]`
  );
  await expect(card.locator("[data-slot=incident-impact]")).toHaveAttribute(
    "data-impact",
    "major"
  );
  await expect(card.locator("[data-slot=incident-stage]")).toHaveAttribute(
    "data-stage",
    "investigating"
  );
  await expect(component).toHaveAttribute("data-level", "partial_outage");
  await expect(visitor.locator("[data-slot=page-banner]")).toHaveAttribute(
    "data-level",
    "partial_outage"
  );

  for (const [stage, updates] of [
    ["identified", 2],
    ["monitoring", 3],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: the stages follow one another
    await postUpdate(page, stage, updates);
    await visitor.reload();
    await expect(card.locator("[data-slot=incident-stage]")).toHaveAttribute(
      "data-stage",
      stage
    );
  }

  await page.fill("input[name=title-en]", `Down, renamed ${run}`);
  await page.click(
    "[data-slot=incident-edit-form] [role=radio][data-value=critical]"
  );
  await page.click("[data-slot=save-incident]");
  // The update form above still says its update is posted; this is the edit form's own line.
  await expect(
    page.locator(
      "[data-slot=incident-edit-form] [data-slot=save-outcome][data-state=saved]"
    )
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator("[data-slot=incident-summary] [data-slot=incident-impact]")
  ).toHaveAttribute("data-impact", "critical");
  const view = `${overview}/incidents/${incidentId}`;
  await visitor.goto(view);
  await expect(visitor.locator("[data-slot=incident-view] h2")).toHaveText(
    `Down, renamed ${run}`
  );
  await expect(
    visitor.locator("[data-slot=incident-view] [data-slot=incident-impact]")
  ).toHaveAttribute("data-impact", "critical");

  await postUpdate(page, "resolved", 4);
  await expect(
    page.locator("[data-slot=incident-resolved-note]")
  ).toBeVisible();
  await visitor.goto(overview);
  await expect(card).toHaveCount(0);
  // The incident set the status; resolved, the component is back at the one set by hand.
  await expect(component).toHaveAttribute("data-level", "operational");
  await visitor.goto(view);
  await expect(
    visitor.locator("[data-slot=incident-view] [data-slot=incident-stage]")
  ).toHaveAttribute("data-stage", "resolved");
  await expect(visitor.locator("[data-slot=incident-update]")).toHaveCount(4);
  await visitor.goto(`${overview}/history`);
  await expect(
    visitor.locator(
      `[data-slot=history-entry][data-kind=incident][data-entry="${incidentId}"]`
    )
  ).toBeVisible();
  await visitor.context().close();
});

test("a window as the visitor sees it: scheduled, moved to start now and under maintenance, then ended into the history", async ({
  browser,
  page,
}) => {
  const run = runId();
  const slug = `window-${run}`;
  await signIn(page);
  const componentId = await handComponent(page, `Db ${run}`);
  await publishedPage(page, slug, [componentId]);

  await page.goto(`${englishOrigin}/admin/maintenance/new`);
  const zone =
    (await page.locator("[data-slot=window-zone]").getAttribute("data-zone")) ??
    "UTC";
  await page.fill("input[name=title-en]", `Db move ${run}`);
  await page.fill("textarea[name=message-en]", "We move the database.");
  await page
    .locator(
      `[data-slot=window-component][data-component="${componentId}"] label`
    )
    .click();
  await page.click("[data-slot=create-window]");
  const windowId = await idOf(page, windowPath);

  const visitor = await visitorOf(browser);
  const overview = `${englishOrigin}/status/${slug}`;
  await visitor.goto(overview);
  const stage = visitor.locator(
    `[data-slot=maintenance-card][data-window="${windowId}"] [data-slot=window-stage]`
  );
  const component = visitor.locator(
    `[data-slot=page-component][data-component="${componentId}"] [data-slot=component-status]`
  );
  await expect(stage).toHaveAttribute("data-stage", "scheduled");
  await expect(component).toHaveAttribute("data-level", "operational");

  await fillTime(page, "starts", startingNow(zone));
  await fillTime(page, "ends", wallTime(Date.now() + 30 * 60_000, zone));
  await page.click("[data-slot=save-window]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();
  // The scheduler starts it at its next tick in the start's minute.
  await expect
    .poll(
      async () => {
        await visitor.reload();
        return await stage.getAttribute("data-stage");
      },
      { timeout: 20_000 }
    )
    .toBe("in_progress");
  await expect(component).toHaveAttribute("data-level", "under_maintenance");

  await page.goto(`${englishOrigin}/admin/maintenance/${windowId}`);
  await page.click("[data-slot=end-window]");
  await page.click("[data-slot=confirm-end]");
  await expect
    .poll(
      async () => {
        await visitor.reload();
        return await stage.count();
      },
      { timeout: 20_000 }
    )
    .toBe(0);
  await expect(component).toHaveAttribute("data-level", "operational");
  await visitor.goto(`${overview}/maintenance/${windowId}`);
  await expect(
    visitor.locator("[data-slot=maintenance-view] [data-slot=window-stage]")
  ).toHaveAttribute("data-stage", "completed");
  await visitor.goto(`${overview}/history`);
  await expect(
    visitor.locator(
      `[data-slot=history-entry][data-kind=maintenance][data-entry="${windowId}"]`
    )
  ).toBeVisible();
  await visitor.context().close();
});

/** Opens a page of its own, percentages off, with an open incident on a phone, in the locale under the prefix, and asserts each view fits the screen with no sideways scroll. */
async function fitsAPhone(
  browser: Browser,
  page: Page,
  prefix: "" | "/ar"
): Promise<void> {
  const run = runId();
  const slug = `phone-${run}`;
  await signIn(page);
  const componentId = await handComponent(page, `Mobile api ${run}`);
  const otherId = await handComponent(page, `Mobile web ${run}`);
  await publishedPage(page, slug, [componentId, otherId]);
  // Without its figures, a component's row ends in its status word, which is hidden on a phone.
  await page.click("label[for=percentages]");
  await savePage(page);
  const incidentId = await publishIncident(
    page,
    componentId,
    `Phone outage with a long title that wraps on a narrow screen ${run}`
  );
  const visitor = await visitorOf(browser, { height: 844, width: 390 });
  const direction = prefix === "/ar" ? "rtl" : "ltr";
  for (const view of ["", `/incidents/${incidentId}`, "/history"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one view at a time in one tab
    await visitor.goto(`${englishOrigin}${prefix}/status/${slug}${view}`);
    await expect(visitor.locator("html")).toHaveAttribute("dir", direction);
    await expect(visitor.locator("[data-slot=status-page]")).toBeVisible();
    expect(
      await visitor.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      ),
      view || "overview"
    ).toBe(0);
  }
  await visitor.context().close();
}

test("in Arabic on a phone, the overview, an incident and the history are right to left and fit the screen", async ({
  browser,
  page,
}) => {
  await fitsAPhone(browser, page, "/ar");
});

test("in English on a phone, the overview, an incident and the history fit the screen", async ({
  browser,
  page,
}) => {
  await fitsAPhone(browser, page, "");
});

// The incident screens, on the built entry, signed in on the
// English server, whose seeded monitors point at loopback ports nothing
// listens on. The tests of one incident's life build on one another and run
// in order; the last makes records of its own.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";

const run = Date.now().toString(36);
const linkedName = `Checkout ${run}`;
const handName = `Mail ${run}`;
const componentPath = /^\/admin\/components\/[0-9a-f-]{36}$/;
const incidentPath = /^\/admin\/incidents\/[0-9a-f-]{36}$/;

async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

async function idOf(page: Page, pattern: RegExp): Promise<string> {
  await expect.poll(() => new URL(page.url()).pathname).toMatch(pattern);
  return new URL(page.url()).pathname.split("/").at(-1) ?? "";
}

let linkedId = "";
let handId = "";
let incidentPage = "";

test.describe("one incident, from the monitor's down notification to its deletion", () => {
  test.describe.configure({ mode: "serial" });

  test("the down notification's link opens a new incident from the monitor: its name and the components linked to it", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/components/new`);
    await page.fill("input[name=name-en]", linkedName);
    const website = page.locator("[data-slot=component-monitor]", {
      hasText: "Website",
    });
    const monitorId = (await website.getAttribute("data-monitor")) ?? "";
    await website.locator("label").click();
    await page.click("[data-slot=save-component]");
    linkedId = await idOf(page, componentPath);

    await page.goto(`${englishOrigin}/admin/components/new`);
    await page.fill("input[name=name-en]", handName);
    await page.click("[data-slot=save-component]");
    handId = await idOf(page, componentPath);

    await page.goto(
      `${englishOrigin}/admin/incidents/new?monitor=${monitorId}`
    );
    await expect(page.locator("[data-slot=incident-prefilled]")).toBeVisible();
    await expect(page.locator("input[name=title-en]")).toHaveValue("Website");
    await expect(
      page.locator(
        `[data-slot=incident-component][data-component="${linkedId}"]`
      )
    ).toBeVisible();
    await expect(
      page.locator(`[data-slot=incident-component][data-component="${handId}"]`)
    ).toHaveCount(0);

    await page.fill("input[name=title-en]", `Checkout failing ${run}`);
    await page.click(
      "[data-slot=incident-impact-choice] [role=radio][data-value=major]"
    );
    await page.fill("textarea[name=message-en]", "Card payments fail.");
    await page.click(
      `[data-component="${linkedId}"] [data-slot=incident-component-status] [role=radio][data-value=partial_outage]`
    );
    await page.click("[data-slot=create-incident]");
    await idOf(page, incidentPath);
    incidentPage = new URL(page.url()).pathname;
    await expect(
      page.locator("[data-slot=incident-summary] [data-slot=incident-impact]")
    ).toHaveAttribute("data-impact", "major");
    await expect(page.locator("[data-slot=incident-update]")).toHaveCount(1);
  });

  test("an update moves the stage and may add a component, whose status then follows the incident", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}${incidentPage}`);
    await page.click(
      "[data-slot=incident-stage-choice] [role=radio][data-value=identified]"
    );
    await page.fill("textarea[name=message-en]", "The mail relay is down too.");
    await page.click(`[data-component="${handId}"] [role=checkbox]`);
    await page.click(
      `[data-component="${handId}"] [data-slot=incident-component-status] [role=radio][data-value=major_outage]`
    );
    // A component the incident already affects stays ticked; only the one added here can be taken out.
    await expect(
      page.locator(`[data-component="${linkedId}"] [role=checkbox]`)
    ).toBeDisabled();
    await expect(
      page.locator(`[data-component="${handId}"] [role=checkbox]`)
    ).toBeEnabled();
    await page.click("[data-slot=post-update]");
    await expect(page.locator("[data-slot=incident-update]")).toHaveCount(2);
    await expect(
      page.locator("[data-slot=incident-update]").first()
    ).toHaveAttribute("data-stage", "identified");

    await page.goto(`${englishOrigin}/admin/components/${handId}`);
    await expect(
      page.locator("[data-slot=component-status][data-level=major_outage]")
    ).toBeVisible();
    await expect(
      page.locator(`[data-slot=component-incidents] a[href="${incidentPage}"]`)
    ).toBeVisible();
  });

  test("resolving with the keep choice leaves the component set by hand at the incident's status, and the list shows it resolved", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}${incidentPage}`);
    await page.click(
      "[data-slot=incident-stage-choice] [role=radio][data-value=resolved]"
    );
    await page.click("[data-slot=incident-keep]");
    await page.fill("textarea[name=message-en]", "Payments work again.");
    await page.click("[data-slot=post-update]");
    await expect(
      page.locator("[data-slot=incident-resolved-note]")
    ).toBeVisible();
    await expect(page.locator("[data-slot=incident-update-form]")).toHaveCount(
      0
    );

    await page.goto(`${englishOrigin}/admin/components/${handId}`);
    await expect(
      page.locator("[data-slot=component-status][data-level=major_outage]")
    ).toBeVisible();
    await expect(page.locator("[data-slot=component-incidents]")).toHaveCount(
      0
    );

    await page.goto(`${englishOrigin}/admin/incidents`);
    await expect(
      page.locator(
        `[data-incident="${incidentPage.split("/").at(-1)}"][data-stage=resolved]`
      )
    ).toBeVisible();
  });

  test("an update's text can be fixed, and a deleted incident leaves the list", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}${incidentPage}`);
    const first = page.locator("[data-slot=incident-update]").last();
    await first.locator("[data-slot=fix-update]").click();
    await first
      .locator("[data-slot=fix-form] textarea[lang=en]")
      .fill("Card payments fail at checkout.");
    await first.locator("[data-slot=save-fix]").click();
    await expect(
      page
        .locator("[data-slot=incident-update]")
        .last()
        .locator("[data-slot=update-message]")
    ).toHaveText("Card payments fail at checkout.");

    await page.click("[data-slot=delete-incident]");
    await page.click("[data-slot=confirm-delete]");
    await expectPath(page, "/admin/incidents");
    await expect(
      page.locator(`[data-incident="${incidentPage.split("/").at(-1)}"]`)
    ).toHaveCount(0);
  });
});

// The Bun.serve entry and the handler share one module tree in the build, so a
// storage refusal thrown under the entry is known by its class in the handler: an incident naming only a deleted component is invalid, not unavailable.
test("an incident naming only a component deleted since the form opened is refused as invalid", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/components/new`);
  await page.fill("input[name=name-en]", `Gone ${run}`);
  await page.click("[data-slot=save-component]");
  const goneId = await idOf(page, componentPath);

  await page.goto(`${englishOrigin}/admin/incidents/new`);
  await page.fill("input[name=title-en]", `Gone component ${run}`);
  await page.fill(
    "textarea[name=message-en]",
    "Named a component then lost it."
  );
  await page.click(`[data-component="${goneId}"] [role=checkbox]`);

  const other = await context.newPage();
  await other.goto(`${englishOrigin}/admin/components/${goneId}`);
  await other.click("[data-slot=delete-component]");
  await other.click("[data-slot=confirm-delete]");
  await expectPath(other, "/admin/components");
  await other.close();

  await page.click("[data-slot=create-incident]");
  await expect(
    page.locator("[data-slot=save-outcome][data-reason=invalid]")
  ).toBeVisible();
});

test("deleting a component names the incidents it is the last affected component of, and they go with it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/components/new`);
  await page.fill("input[name=name-en]", `Last ${run}`);
  await page.click("[data-slot=save-component]");
  const lastId = await idOf(page, componentPath);

  await page.goto(`${englishOrigin}/admin/incidents/new`);
  await page.fill("input[name=title-en]", `Only on last ${run}`);
  await page.fill("textarea[name=message-en]", "Affects one component.");
  await page.click(`[data-component="${lastId}"] [role=checkbox]`);
  await page.click("[data-slot=create-incident]");
  const incidentId = await idOf(page, incidentPath);

  await page.goto(`${englishOrigin}/admin/components/${lastId}`);
  await page.click("[data-slot=delete-component]");
  await expect(
    page.locator(`[data-slot=deleted-incidents] [data-record="${incidentId}"]`)
  ).toBeVisible();
  await page.click("[data-slot=confirm-delete]");
  await expectPath(page, "/admin/components");
  await page.goto(`${englishOrigin}/admin/incidents`);
  await expect(page.locator(`[data-incident="${incidentId}"]`)).toHaveCount(0);
});

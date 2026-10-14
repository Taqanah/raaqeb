// A create form sent twice before the page answers, as a quick double press
// on a slow device does, stores one record. On an install of its own, so the
// lists it counts hold only its records.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

let install: Install | undefined;
let origin = "";
let componentId = "";
let incidentId = "";

test.beforeAll(async () => {
  install = await spawnInstall({
    account: true,
    language: "en",
    records: async (storage) => {
      const component = await storage.components.create({
        description: undefined,
        monitorIds: [],
        name: { en: "Shared component" },
        status: "operational",
      });
      componentId = component.id;
      const incident = await storage.incidents.create(
        { impact: "minor", title: { en: "Open incident" } },
        {
          author: "operator",
          message: { en: "Looking into it." },
          stage: "investigating",
          statuses: [{ componentId, status: "degraded_performance" }],
        }
      );
      incidentId = incident.id;
    },
  });
  ({ origin } = install);
});

test.afterAll(async () => {
  await install?.stop();
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

/** Sends the form of the Save button `button` names twice in one task, before the page can show the first save running. */
function submitTwice(page: Page, button = "[data-save]"): Promise<void> {
  return page.evaluate((selector) => {
    const save = document.querySelector<HTMLButtonElement>(selector);
    save?.form?.requestSubmit(save);
    save?.form?.requestSubmit(save);
  }, button);
}

/** How many records the list shows under `name`, once every request the double send started has answered. */
async function countOn(page: Page, list: string, name: string) {
  await page.waitForLoadState("networkidle");
  await page.goto(`${origin}${list}`);
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  return page.getByText(name, { exact: true }).count();
}

const forms: readonly {
  readonly what: string;
  readonly path: string;
  readonly list: string;
  readonly fill: (page: Page, name: string) => Promise<void>;
}[] = [
  {
    fill: async (page, name) => {
      await page.fill("input[name=name]", name);
      await page.fill("input[name=url]", "http://127.0.0.1:1/");
    },
    list: "/admin/monitors",
    path: "/admin/monitors/new",
    what: "monitor",
  },
  {
    fill: async (page, name) => {
      await page.fill("input[name=name-en]", name);
      await page.click(
        "[data-slot=component-hand-status] [role=radio][data-value=operational]"
      );
    },
    list: "/admin/components",
    path: "/admin/components/new",
    what: "component",
  },
  {
    fill: async (page, name) => {
      const form = page.locator("[data-slot=channel-form]");
      await form.locator("input[name=name]").fill(name);
      await form.locator("input[name=url]").fill("http://127.0.0.1:1/hook");
    },
    list: "/admin/channels",
    path: "/admin/channels/new",
    what: "notification channel",
  },
  {
    fill: async (page, name) => {
      await page.fill("input[name=title]", name);
      await page.fill("input[name=slug]", `twice-${Date.now().toString(36)}`);
    },
    list: "/admin/pages",
    path: "/admin/pages/new",
    what: "status page",
  },
  {
    fill: async (page, name) => {
      await page.fill("input[name=title-en]", name);
      await page.fill("textarea[name=message-en]", "Sent twice.");
      await page.click(`[data-component="${componentId}"] [role=checkbox]`);
    },
    list: "/admin/incidents",
    path: "/admin/incidents/new",
    what: "incident",
  },
  {
    fill: async (page, name) => {
      await page.fill("input[name=title-en]", name);
      await page.fill("textarea[name=message-en]", "Sent twice.");
      await page
        .locator(
          `[data-slot=window-component][data-component="${componentId}"] label`
        )
        .click();
    },
    list: "/admin/maintenance",
    path: "/admin/maintenance/new",
    what: "maintenance window",
  },
];

for (const form of forms) {
  test(`a new ${form.what} sent twice before the page answers is stored once`, async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${origin}${form.path}`);
    const name = `Twice ${form.what} ${Date.now().toString(36)}`;
    await form.fill(page, name);
    await submitTwice(page);
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(form.path);
    expect(await countOn(page, form.list, name)).toBe(1);
  });
}

test("an incident update sent twice before the page answers is posted once, with no refusal", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${origin}/admin/incidents/${incidentId}`);
  await page.click(
    "[data-slot=incident-stage-choice] [role=radio][data-value=identified]"
  );
  await page.fill("textarea[name=message-en]", "Found it.");
  await submitTwice(page, "[data-slot=post-update]");
  await expect(page.locator("[data-slot=incident-update]")).toHaveCount(2);
  await page.waitForLoadState("networkidle");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=failed]")
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-slot=incident-update]")).toHaveCount(2);
});

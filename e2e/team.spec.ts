// The team on an install of its own: the owner invites an operator, who
// accepts the link and signs in under the role it gave; a viewer reads the
// admin and changes nothing; the owner changes a role and deactivates an
// account, whose sign-in is refused as such. A second install requires a
// second step, which leaves an operator without one their own account alone.

import type { Page } from "@playwright/test";
import { secondStepRequired } from "@/server/auth/second-step.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, seedAccount, spawnInstall } from "./support/spawn.ts";

const reader = {
  email: "reader@example.com",
  name: "Reader",
  password: "a reader's password",
  role: "viewer",
} as const;
const invited = {
  email: "new@example.com",
  name: "Nadia",
  password: "a new operator's password",
};

async function signIn(
  page: Page,
  origin: string,
  email = operatorEmail,
  password = operatorPassword
): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await page.click("form button[type=submit]");
}

test.describe("a team", () => {
  test.describe.configure({ mode: "serial" });
  let install: Install | undefined;
  let link = "";
  test.beforeAll(async () => {
    install = await spawnInstall({
      account: true,
      language: "en",
      records: (storage) => seedAccount(storage, reader),
    });
  });
  test.afterAll(async () => {
    await install?.stop();
  });

  test("the owner invites an editor and is shown the link to send, since the install has no email channel", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await signIn(page, origin);
    await expectPath(page, "/admin/monitors");
    await page.click("[data-nav=team]");
    await expectPath(page, "/admin/team");
    await expect(page.locator("[data-slot=team-member]")).toHaveCount(2);
    await page.click("[data-slot=team-invite]");
    await page.fill("input[name=email]", invited.email);
    await page.selectOption("select[name=role]", "editor");
    await page.click("[data-slot=team-invite-send]");
    await expect(page.locator("[data-slot=team-link-line]")).toHaveAttribute(
      "data-emailed",
      "false"
    );
    link =
      (await page.locator("[data-slot=team-link-value]").textContent()) ?? "";
    expect(link.startsWith(`${origin}/invitation?token=rqi_`)).toBe(true);
    await page.click("[data-slot=team-link-done]");
    await expect(page.locator("[data-slot=team-invitation]")).toHaveCount(1);
  });

  test("the invited operator accepts the link with a name and a password, and lands in the admin as an editor", async ({
    page,
  }) => {
    await page.goto(link);
    await expect(page.locator("[data-slot=invitation-email]")).toHaveText(
      invited.email
    );
    await expect(page.locator("[data-slot=invitation-role]")).toHaveAttribute(
      "data-role",
      "editor"
    );
    await page.fill("input[name=name]", invited.name);
    await page.fill("input[name=password]", invited.password);
    await page.click("[data-slot=invitation-accept]");
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("[data-slot=new-monitor]")).toBeVisible();
    await expect(page.locator("[data-nav=team]")).toHaveCount(0);
  });

  test("the link works once: opened again it is closed", async ({ page }) => {
    await page.goto(link);
    await expect(page.locator("[data-slot=invitation-closed]")).toBeVisible();
    await expect(page.locator("[data-slot=invitation-form]")).toHaveCount(0);
  });

  test("a viewer reads the admin and is offered nothing to change: no new monitor, no team, settings only their own", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await signIn(page, origin, reader.email, reader.password);
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("[data-slot=new-monitor]")).toHaveCount(0);
    await expect(page.locator("[data-nav=team]")).toHaveCount(0);
    await expect(page.locator("[data-nav=settings]")).toHaveAttribute(
      "href",
      "/admin/settings/account"
    );
    await page.goto(`${origin}/admin/team`);
    await expectPath(page, "/admin/monitors");
    await page.goto(`${origin}/admin/channels/new`);
    await expect(page.locator("[data-slot=read-only]")).toBeVisible();
    await expect(page.locator("form button[data-save]")).toBeDisabled();
  });

  test("the owner makes the viewer a responder, and deactivates the editor, whose sign-in is then refused as deactivated", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await signIn(page, origin);
    await expectPath(page, "/admin/monitors");
    await page.goto(`${origin}/admin/team`);
    const readerRow = page.locator(
      `[data-slot=team-member]:has([data-slot=team-role]):has-text("${reader.email}")`
    );
    await readerRow.locator("[data-slot=team-role]").selectOption("responder");
    await page.click("[data-slot=team-role-change] [data-slot=team-confirm]");
    await expect(readerRow).toHaveAttribute("data-role", "responder");
    const editorRow = page.locator(
      `[data-slot=team-member]:has-text("${invited.email}")`
    );
    await editorRow.locator("[data-slot=team-actions]").click();
    await page.click("[data-action=deactivate]");
    await page.click("[data-slot=team-deactivate] [data-slot=team-confirm]");
    await expect(editorRow).toHaveAttribute("data-state", "deactivated");
    await page.context().clearCookies();
    await signIn(page, origin, invited.email, invited.password);
    await expect(page.locator("[data-failure=deactivated]")).toBeVisible();
    await expectPath(page, "/sign-in");
  });
});

test.describe("a second step every operator must have", () => {
  let install: Install | undefined;
  test.beforeAll(async () => {
    install = await spawnInstall({
      account: true,
      language: "en",
      records: async (storage) => {
        await seedAccount(storage, reader);
        await storage.settings.set(secondStepRequired, true);
      },
    });
  });
  test.afterAll(async () => {
    await install?.stop();
  });

  test("leaves an operator without one their own sign-in page, which says why, until they switch it on", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await signIn(page, origin, reader.email, reader.password);
    await expectPath(page, "/admin/settings/sign-in");
    await expect(
      page.locator("[data-slot=second-step-required]")
    ).toBeVisible();
    await page.goto(`${origin}/admin/pages`);
    await expectPath(page, "/admin/settings/sign-in");
    await page.goto(`${origin}/admin/settings/account`);
    await expectPath(page, "/admin/settings/account");
  });
});

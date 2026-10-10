// What an install with an email channel does through the mail: a visitor's
// sign-up confirmed from its message, the second step and the authenticator
// app switched on and off in the browser, and a reset link that works once.
// Each test spawns its own install with the operator account and its own
// fake SMTP server, and adds the email channel through the admin.

import type { Page } from "@playwright/test";
import { appCode } from "@/server/auth/fixture.ts";
import {
  bodyText,
  type FakeSmtp,
  fakeSmtp,
  parse,
} from "@/server/notify/fixture.ts";
import {
  test as base,
  clientAddress,
  expect,
  expectPath,
} from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

const test = base.extend<{ install: Install; smtp: FakeSmtp }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the destructuring to order fixtures
  install: async ({}, use) => {
    const install = await spawnInstall({ account: true });
    await use(install);
    await install.stop();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the destructuring to order fixtures
  smtp: async ({}, use) => {
    const smtp = fakeSmtp();
    await use(smtp);
    smtp.stop();
  },
});

const continueButton = "form button[type=submit]";
const pagePath = /^\/admin\/pages\/[0-9a-f-]{36}$/;
const subscriptionLink = /https?:\/\/\S+\/subscriptions\/[\w-]+/;
const resetLink = /https?:\/\/\S+\/reset-password\?token=\S+/;
/** Better Auth's cookie that holds a sign-in waiting for its second step. */
const pendingSignIn = /two_factor/;

/** The text of the last message the fake SMTP server received. */
function lastMail(smtp: FakeSmtp): string {
  return bodyText(parse(smtp.messages.at(-1) ?? ""));
}

/** Signs in from a client address of its own, so a walk never spends the sign-in limit of one (3 in 10 seconds). */
async function signIn(
  page: Page,
  origin: string,
  password = operatorPassword
): Promise<void> {
  await page
    .context()
    .setExtraHTTPHeaders({ "x-forwarded-for": clientAddress(8) });
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", password);
  await page.click(continueButton);
}

async function signOut(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/sign-out`);
  await page.click(continueButton);
  await expectPath(page, "/sign-in");
}

/** Adds an email channel that sends through the fake SMTP server, as an operator does. */
async function addEmailChannel(
  page: Page,
  origin: string,
  smtp: FakeSmtp
): Promise<void> {
  await page.goto(`${origin}/admin/channels/new`);
  await page.click("[role=radio][data-value=email]");
  const form = page.locator("[data-slot=channel-form]");
  await form.locator("input[name=name]").fill("Mail");
  await form.locator("input[name=from]").fill("raaqeb@example.com");
  await form.locator("input[name=to]").fill("team@example.com");
  await form.locator("input[name=host]").fill("127.0.0.1");
  await form.locator("select[name=security]").selectOption("none");
  await form.locator("input[name=port]").fill(String(smtp.port));
  await form.locator("button[type=submit]").click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .not.toBe("/admin/channels/new");
}

test("a visitor subscribes to a status page by email, confirms from the link the message carries, and the operator sees the subscriber confirmed", async ({
  install,
  page,
  smtp,
}) => {
  const { origin } = install;
  await signIn(page, origin);
  await expectPath(page, "/admin/monitors");
  await addEmailChannel(page, origin, smtp);

  await page.goto(`${origin}/admin/components/new`);
  await page.fill("input[name=name-ar]", "الموقع");
  await page.click("[data-slot=save-component]");
  await expect
    .poll(() => new URL(page.url()).pathname)
    .not.toBe("/admin/components/new");
  const componentId = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  await page.goto(`${origin}/admin/pages/new`);
  await page.fill("input[name=title]", "حالة الخدمة");
  await page.fill("input[name=slug]", "service");
  await page.click("[data-slot=new-page-form] button[type=submit]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(pagePath);
  const editorPath = new URL(page.url()).pathname;
  await page.selectOption("select[name=add-component]", componentId);
  await page.click("label[for=published]");
  await page.click("[data-slot=save-page]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();

  // The visitor's side: the dialog's email form, then the message.
  await page.goto(`${origin}/status/service`);
  await page.click("[data-slot=subscribe-open]");
  await page.click(
    "[data-slot=subscribe-channel] [role=radio][data-value=email]"
  );
  await page.fill("input[name=address]", "reader@example.com");
  await page.click("[data-slot=subscribe-submit]");
  await expect(page.locator("[data-slot=subscribe-answer]")).toHaveAttribute(
    "data-state",
    "sent"
  );
  await expect
    .poll(() => smtp.commands)
    .toContain("RCPT TO:<reader@example.com>");
  await expect.poll(() => smtp.messages.length).toBe(1);
  const link = subscriptionLink.exec(lastMail(smtp))?.[0] ?? "";
  expect(new URL(link).origin).toBe(origin);
  await page.goto(link);
  const panel = page.locator("[data-slot=subscription]");
  await expect(panel).toHaveAttribute("data-state", "pending");
  await page.click("[data-slot=subscription-confirm]");
  await expect(panel).toHaveAttribute("data-state", "confirmed");

  await page.goto(`${origin}${editorPath}/subscribers`);
  await expect(page.locator("[data-slot=subscriber]")).toHaveAttribute(
    "data-state",
    "confirmed"
  );
});

test("the authenticator app gives new backup codes and turns off, a pending sign-in that lapsed starts over, and the second step turns off in the browser so the password alone signs in", async ({
  install,
  page,
  smtp,
}) => {
  test.setTimeout(60_000);
  const { origin } = install;
  await signIn(page, origin);
  await expectPath(page, "/admin/monitors");
  await addEmailChannel(page, origin, smtp);

  // Email codes on first, so the app's turn-off leaves the second step on.
  await page.goto(`${origin}/admin/settings/sign-in`);
  await page.click("[data-slot=auth-email-test]");
  await expect(page.locator("[data-slot=auth-email-test-sent]")).toBeVisible();
  const secondStep = page.locator("[data-slot=second-step-form]");
  await secondStep.locator("input[name=password]").fill(operatorPassword);
  await secondStep.locator("button[type=submit]").click();
  await expect(secondStep).toHaveAttribute("data-on", "true");

  const app = page.locator("[data-slot=authenticator-form]");
  await app.locator("input[name=password]").fill(operatorPassword);
  await app.locator("button[name=intent][value=set-up]").click();
  const key = page.locator("[data-slot=authenticator-key]");
  const uri = `otpauth://totp/x?secret=${(await key.innerText()).replaceAll(" ", "")}`;
  await page.fill(
    "[data-slot=authenticator-scan] input[name=code]",
    appCode(uri)
  );
  await page.click("[data-slot=authenticator-scan] button[type=submit]");
  const shown = page.locator("[data-slot=backup-code]");
  await expect(shown).toHaveCount(10);
  const first = await shown.allInnerTexts();
  await page.click("[data-slot=backup-codes-done]");
  await expect(app).toHaveAttribute("data-app", "true");

  // New codes replace the old ten.
  await app.locator("input[name=password]").fill(operatorPassword);
  await app.locator("button[name=intent][value=codes]").click();
  await expect(shown).toHaveCount(10);
  const renewed = await shown.allInnerTexts();
  expect(renewed.filter((code) => first.includes(code))).toEqual([]);
  await page.click("[data-slot=backup-codes-done]");
  await signOut(page, origin);

  // A wrong code is refused on the form; once the pending sign-in has lapsed, only signing in again helps.
  await signIn(page, origin);
  const codeForm = page.locator("[data-slot=code-form][data-method=app]");
  await expect(codeForm).toBeVisible();
  await page.fill("input[name=code]", "000000");
  await page.click("[data-slot=code-form] button[type=submit]");
  await expect(page.locator("form [role=alert]")).toHaveCount(1);
  // The pending sign-in lives in a cookie that lapses after minutes; clearing it is that lapse.
  await page.context().clearCookies({ name: pendingSignIn });
  await page.fill("input[name=code]", appCode(uri));
  await page.click("[data-slot=code-form] button[type=submit]");
  await page.click("[data-slot=sign-in-again]");
  await expectPath(page, "/sign-in");
  await expect(page.locator("input[name=password]")).toBeVisible();

  await signIn(page, origin);
  await expect(codeForm).toBeVisible();
  await page.fill("input[name=code]", appCode(uri));
  await page.click("[data-slot=code-form] button[type=submit]");
  await expectPath(page, "/admin/monitors");

  // The app off: the emailed code keeps the second step on, until it too is switched off.
  await page.goto(`${origin}/admin/settings/sign-in`);
  await app.locator("input[name=password]").fill(operatorPassword);
  await app.locator("button[name=intent][value=off]").click();
  await expect(app).toHaveAttribute("data-app", "false");
  await expect(secondStep).toHaveAttribute("data-on", "true");
  await secondStep.locator("input[name=password]").fill(operatorPassword);
  await secondStep.locator("button[type=submit]").click();
  await expect(secondStep).toHaveAttribute("data-on", "false");

  await signOut(page, origin);
  const sent = smtp.messages.length;
  await signIn(page, origin);
  await expectPath(page, "/admin/monitors");
  expect(smtp.messages.length).toBe(sent);
});

test("a reset link from the mail sets a new password once, refuses a short one first, and a second use is told to ask for a new link", async ({
  install,
  page,
  smtp,
}) => {
  const { origin } = install;
  await signIn(page, origin);
  await expectPath(page, "/admin/monitors");
  await addEmailChannel(page, origin, smtp);
  await signOut(page, origin);

  await page.click("a[href='/forgot-password']");
  await expectPath(page, "/forgot-password");
  // The link is the router's: the path moves before the page does, and the sign-in form has an email field too.
  await expect(page.locator("input[name=password]")).toHaveCount(0);
  await page.fill("input[name=email]", operatorEmail);
  await page.click(continueButton);
  await expect(page.locator("[data-slot=reset-sent]")).toBeVisible();
  await expect.poll(() => smtp.messages.length).toBe(1);
  const link = resetLink.exec(lastMail(smtp))?.[0] ?? "";
  expect(new URL(link).origin).toBe(origin);

  await page.goto(link);
  // The browser refuses a password under eight characters before it posts (no `noValidate`).
  await page.fill("input[name=newPassword]", "short");
  await page.click(continueButton);
  await expect(page.locator("input[name=newPassword]:invalid")).toHaveCount(1);
  await page.fill("input[name=newPassword]", "a password from the link");
  await page.click(continueButton);
  await expect(page.locator("[data-slot=reset-done]")).toBeVisible();

  // The same link again: the form shows, and the answer is that the link is spent.
  await page.goto(link);
  await page.fill("input[name=newPassword]", "yet another password");
  await page.click(continueButton);
  await expect(page.locator("[data-slot=reset-link-invalid]")).toBeVisible();
  await expect(page.locator("input[name=newPassword]")).toHaveCount(0);
  await expect(page.locator("a[href='/forgot-password']")).toBeVisible();

  await signIn(page, origin, "a password from the link");
  await expectPath(page, "/admin/monitors");
});

// Onboarding on the built entry. The fresh server is walked from
// the language screen to the empty monitors list; the Arabic server, which
// stays in onboarding for the whole run, shows the database screen's verdicts
// and the redirects.

import type { Page } from "@playwright/test";
import { appCode } from "@/server/auth/fixture.ts";
import { bodyText, fakeSmtp, parse } from "@/server/notify/fixture.ts";
import {
  clientAddress,
  expect,
  expectPath,
  expectRefused,
  expectSaidOnce,
  test,
} from "./support/fixtures.ts";
import { freshOrigin } from "./support/servers.ts";

const continueButton = "form button[type=submit]";
const radio = (name: string, value: string) =>
  `[role=radiogroup][data-name=${name}] [role=radio][data-value="${value}"]`;

/** The fresh server at another name, as over a tunnel before DNS: the walk runs here and enters `freshOrigin` as the public address. */
const tunnelOrigin = freshOrigin.replace("127.0.0.1", "localhost");
const publicAddressInput = "input[name=publicAddress]";
const addressWarning = "[data-slot=address-elsewhere]";

const sixDigits = /\b\d{6}\b/;
const resetLink = /https?:\/\/\S+\/reset-password\?token=\S+/;

/** The text of the last message the fake SMTP server received. */
function lastMail(messages: readonly string[]): string {
  return bodyText(parse(messages.at(-1) ?? ""));
}

async function signInAs(page: Page, password: string): Promise<void> {
  // A new client address, so the walk never spends the sign-in limit of one (3 in 10 seconds).
  await page
    .context()
    .setExtraHTTPHeaders({ "x-forwarded-for": clientAddress(9) });
  await page.goto(`${freshOrigin}/sign-in`);
  await page.fill("input[name=email]", "owner@example.com");
  await page.fill("input[name=password]", password);
  await page.click(continueButton);
}

async function signOut(page: Page): Promise<void> {
  await page.goto(`${freshOrigin}/sign-out`);
  await page.click(continueButton);
  await expectPath(page, "/sign-in");
}

/** Enters the code the last message carried, trusting the browser or not, and lands in the admin area. */
async function enterCode(
  page: Page,
  messages: readonly string[],
  trust: boolean
): Promise<void> {
  await expect(page.locator("[data-slot=code-form]")).toBeVisible();
  await expect.poll(() => messages.length).toBeGreaterThan(0);
  const code = sixDigits.exec(lastMail(messages))?.[0] ?? "";
  await page.fill("input[name=code]", code);
  if (trust) {
    await page.click("[data-slot=trust-browser]");
  }
  await page.click("[data-slot=code-form] button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

// The walk and what follows it share the fresh server's state, in order; the Arabic server's screens after them only read.
test.describe("the fresh install, walked to the end and then used", () => {
  test.describe.configure({ mode: "serial" });

  test("a fresh install is walked from the language screen to the empty monitors list, signed in", async ({
    context,
    page,
  }) => {
    await page.goto(`${tunnelOrigin}/`);
    await expectPath(page, "/onboarding");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator(radio("locale", "ar"))).toHaveAttribute(
      "aria-checked",
      "true"
    );

    await page.click(radio("locale", "en"));
    await page.click(continueButton);
    await expectPath(page, "/onboarding/database");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await expect(page.locator(radio("backend", "sqlite"))).toHaveAttribute(
      "aria-checked",
      "true"
    );
    await page.click(continueButton);
    await expectPath(page, "/onboarding/account");
    // The language rides in the address from screen to screen, and the account screen is rendered from it.
    expect(new URL(page.url()).search).toBe("?locale=en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await expect(page.locator(publicAddressInput)).toHaveValue(tunnelOrigin);

    // The pre-fill is where the browser is, not what the server resolved: here the trusted peer forwards https.
    const forwarded = { "x-forwarded-proto": "https" };
    const served = await context.request.get(page.url(), {
      headers: forwarded,
    });
    expect(await served.text()).toContain(
      tunnelOrigin.replace("http:", "https:")
    );
    await page.route(`${tunnelOrigin}/onboarding/account*`, (route) =>
      route.continue({
        headers: { ...route.request().headers(), ...forwarded },
      })
    );
    await page.reload();
    await page.unrouteAll();
    await expect(page.locator(publicAddressInput)).toHaveValue(tunnelOrigin);

    // What the screen refuses is said beside each field, and nothing is created.
    await page.fill("input[name=email]", "not an email");
    await page.fill("input[name=password]", "short");
    await page.fill(publicAddressInput, `${tunnelOrigin}/path`);
    await page.click(continueButton);
    await expectRefused(page, "form", ["email", "password", "publicAddress"]);
    await expectPath(page, "/onboarding/account");

    await page.fill("input[name=email]", "operator@example.com");
    await page.fill("input[name=password]", "correct horse battery");

    // An address the browser is not at: nothing is created, and the screen asks for a confirmation first.
    await page.fill(publicAddressInput, "https://status.example.test");
    await page.click(continueButton);
    await expect(page.locator(addressWarning)).toHaveCount(1);
    await expectPath(page, "/onboarding/account");
    await expect(page.locator(continueButton)).toBeDisabled();
    await page.click(`${addressWarning} [data-slot=checkbox]`);
    await expect(page.locator(continueButton)).toBeEnabled();
    // Editing the address takes the warning and its confirmation away: the next address is checked afresh.
    await page.fill(publicAddressInput, freshOrigin);
    await expect(page.locator(addressWarning)).toHaveCount(0);
    await page.click(continueButton);
    await expect(page.locator(addressWarning)).toHaveCount(1);
    await page.click(`${addressWarning} [data-slot=checkbox]`);
    await page.click(continueButton);
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("main [data-slot=empty]")).toHaveCount(1);
    // Back onto the account screen, which is gone, returns to the admin area rather than a bare not-found page.
    await page.goBack();
    await expectPath(page, "/admin/monitors");
    await expect(page.locator("main [data-slot=empty]")).toHaveCount(1);
    const cookies = await context.cookies(tunnelOrigin);
    expect(cookies.some((c) => c.name === "raaqeb.session_token")).toBe(true);

    // The account exists: the onboarding routes are gone and the root goes to the admin area.
    const gone = await Promise.all(
      ["/onboarding", "/onboarding/database", "/onboarding/account"].map(
        (path) => context.request.get(`${freshOrigin}${path}`)
      )
    );
    expect(gone.map((response) => response.status())).toEqual([404, 404, 404]);
    await page.goto(`${tunnelOrigin}/`);
    await expectPath(page, "/admin/monitors");

    // The getting-started checklist, every step open, until the operator dismisses it for good.
    const checklist = page.locator("main [data-slot=getting-started]");
    await expect(checklist.locator("li[data-done=false]")).toHaveCount(4);
    await page.click("[data-slot=dismiss-getting-started]");
    await expect(checklist).toHaveCount(0);
    // The focus the dismiss button held moves to the first control after the card.
    await expect(
      page.locator("main [data-slot=empty] [data-slot=new-monitor]")
    ).toBeFocused();
    await page.reload();
    await expect(page.locator("main [data-slot=empty]")).toHaveCount(1);
    await expect(checklist).toHaveCount(0);
  });

  test("after onboarding the operator sets the appearance, the operator language, the email and the password from the settings area", async ({
    page,
  }) => {
    await page.goto(`${freshOrigin}/sign-in`);
    await page.fill("input[name=email]", "operator@example.com");
    await page.fill("input[name=password]", "correct horse battery");
    await page.click(continueButton);
    await expectPath(page, "/admin/monitors");

    // Both themes: the appearance page writes the scales and the document follows.
    await page.goto(`${freshOrigin}/admin/settings/appearance`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
    // A choice saves on the click, with no save button.
    await page.click(radio("theme", "light"));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // Two quick choices keep each other.
    await page.click(radio("theme", "dark"));
    await page.click(radio("density", "compact"));
    await expect(
      page.locator("html[data-theme=dark][data-density=compact]")
    ).toHaveCount(1);

    // A language picked shows at once and is kept only by saving: leaving the page brings back the saved one.
    await page.goto(`${freshOrigin}/admin/settings/account`);
    await page.click(radio("operatorLanguage", "ar"));
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
    await expect(
      page.locator(
        "[data-slot=overrides-form] [data-slot=save-outcome][data-state=unsaved]"
      )
    ).toBeVisible();
    await page.click("nav a[data-nav]");
    await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);

    // Both locales: the operator language renders the admin area in Arabic while the install stays English.
    await page.goto(`${freshOrigin}/admin/settings/account`);
    await page.click(radio("operatorLanguage", "ar"));
    await page.click("[data-slot=overrides-form] button[type=submit]");
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
    await page.goto(`${freshOrigin}/admin/monitors`);
    await expect(page.locator("html[lang=ar][dir=rtl]")).toHaveCount(1);
    await expect(page.locator("nav a[data-nav]")).toHaveCount(7);
    await page.goto(`${freshOrigin}/sign-out`);
    await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);
    await page.goto(`${freshOrigin}/admin/settings/account`);
    await page.click(radio("operatorLanguage", ""));
    await page.click("[data-slot=overrides-form] button[type=submit]");
    await expect(page.locator("html[lang=en][dir=ltr]")).toHaveCount(1);

    // An empty current password is refused beside it: a session alone cannot move the account.
    await page.fill(
      "[data-slot=email-form] input[name=email]",
      "owner@example.com"
    );
    await page.click("[data-slot=email-form] button[type=submit]");
    await expectRefused(page, "[data-slot=email-form]", ["currentPassword"]);
    await expectSaidOnce(page, "[data-slot=email-form]", "currentPassword");
    // A wrong one too, and the address stays.
    await page.fill(
      "[data-slot=email-form] input[name=currentPassword]",
      "not the password"
    );
    await page.click("[data-slot=email-form] button[type=submit]");
    await expect(
      page.locator(
        "[data-slot=email-form] [data-slot=save-outcome][data-reason=wrong_password]"
      )
    ).toHaveCount(1);
    await expectRefused(page, "[data-slot=email-form]", ["currentPassword"]);
    await expectSaidOnce(page, "[data-slot=email-form]", "currentPassword");
    await expect(page.locator("[data-slot=sidebar-footer] bdi")).toHaveText(
      "operator@example.com"
    );
    await page.fill(
      "[data-slot=email-form] input[name=currentPassword]",
      "correct horse battery"
    );

    // An address that is not one is refused beside the field.
    await page.fill("[data-slot=email-form] input[name=email]", "not an email");
    await page.click("[data-slot=email-form] button[type=submit]");
    await expectRefused(page, "[data-slot=email-form]", ["email"]);
    await expectSaidOnce(page, "[data-slot=email-form]", "email");
    // The address the account already has is refused beside the field too.
    await page.fill(
      "[data-slot=email-form] input[name=email]",
      "operator@example.com"
    );
    await page.click("[data-slot=email-form] button[type=submit]");
    await expect(
      page.locator(
        "[data-slot=email-form] [data-slot=save-outcome][data-reason=same_email]"
      )
    ).toHaveCount(1);
    await expectRefused(page, "[data-slot=email-form]", ["email"]);
    await expectSaidOnce(page, "[data-slot=email-form]", "email");

    // The email change re-issues the session; the sidebar shows the new address.
    await page.fill(
      "[data-slot=email-form] input[name=email]",
      "owner@example.com"
    );
    await page.click("[data-slot=email-form] button[type=submit]");
    await expect(page.locator("[data-slot=sidebar-footer] bdi")).toHaveText(
      "owner@example.com"
    );
    // Nothing typed stays in the form once the change went through.
    await expect(
      page.locator("[data-slot=email-form] input[name=currentPassword]")
    ).toHaveValue("");
    await expect(
      page.locator("[data-slot=email-form] input[name=email]")
    ).toHaveValue("");

    // An empty current password and a short new one are refused beside each field.
    await page.fill(
      "[data-slot=password-form] input[name=newPassword]",
      "short"
    );
    await page.click("[data-slot=password-form] button[type=submit]");
    await expectRefused(page, "[data-slot=password-form]", [
      "currentPassword",
      "newPassword",
    ]);
    await expectSaidOnce(page, "[data-slot=password-form]", "newPassword");

    // The password change needs the current one, keeps the caller signed in, and the new password signs in afterwards.
    await page.fill(
      "[data-slot=password-form] input[name=currentPassword]",
      "not the password"
    );
    await page.fill(
      "[data-slot=password-form] input[name=newPassword]",
      "another long password"
    );
    await page.click("[data-slot=password-form] button[type=submit]");
    await expect(
      page.locator(
        "[data-slot=password-form] [data-slot=save-outcome][data-reason=wrong_password]"
      )
    ).toHaveCount(1);
    await expectRefused(page, "[data-slot=password-form]", ["currentPassword"]);
    await expectSaidOnce(page, "[data-slot=password-form]", "currentPassword");
    await page.fill(
      "[data-slot=password-form] input[name=currentPassword]",
      "correct horse battery"
    );
    await page.fill(
      "[data-slot=password-form] input[name=newPassword]",
      "another long password"
    );
    await page.click("[data-slot=password-form] button[type=submit]");
    await expect(page.locator("[data-slot=sidebar-footer] bdi")).toHaveText(
      "owner@example.com"
    );
    await expectPath(page, "/admin/settings/account");
    await expect(
      page.locator(
        "[data-slot=password-form] [data-slot=save-outcome][data-state=saved]"
      )
    ).toHaveCount(1);
    for (const field of ["currentPassword", "newPassword"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one field at a time keeps the failure readable
      await expect(
        page.locator(`[data-slot=password-form] input[name=${field}]`)
      ).toHaveValue("");
    }
    await page.goto(`${freshOrigin}/sign-out`);
    await page.click("form button[type=submit]");
    await expectPath(page, "/sign-in");
    await page.fill("input[name=email]", "owner@example.com");
    await page.fill("input[name=password]", "another long password");
    await page.click(continueButton);
    await expectPath(page, "/admin/monitors");
  });

  test("with no email the operator is shown the reset command; with an email channel the second step turns on after a test; the authenticator app signs in with its code, a backup code once, or an emailed code; and both recovery paths set a new password, the command switching the second step off", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    // Without an email channel "forgot password" shows the command, left to right.
    await page.goto(`${freshOrigin}/sign-in`);
    await page.click("a[href='/forgot-password']");
    await expectPath(page, "/forgot-password");
    const command = page.locator("[data-slot=reset-command]");
    await expect(command).toHaveText("raaqeb reset-password");
    await expect(command).toHaveAttribute("dir", "ltr");

    const smtp = fakeSmtp();
    try {
      await signInAs(page, "another long password");
      await expectPath(page, "/admin/monitors");
      // No email channel: nothing to choose, and the switch stays locked.
      await page.goto(`${freshOrigin}/admin/settings/sign-in`);
      await expect(page.locator("[data-slot=no-email-channel]")).toBeVisible();
      await expect(
        page.locator("[data-slot=second-step-form][data-locked=true]")
      ).toBeVisible();
      await expect(
        page.locator("[data-slot=second-step-form] input[name=password]")
      ).toHaveCount(0);

      await page.goto(`${freshOrigin}/admin/channels/new`);
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

      // The test message goes to the operator's address, then the switch opens.
      await page.goto(`${freshOrigin}/admin/settings/sign-in`);
      await expect(
        page.locator("[data-slot=second-step-form][data-locked=true]")
      ).toBeVisible();
      await expect(
        page.locator("[data-slot=second-step-form] input[name=password]")
      ).toHaveCount(0);
      await page.click("[data-slot=auth-email-test]");
      await expect(
        page.locator("[data-slot=auth-email-test-sent]")
      ).toBeVisible();
      expect(smtp.commands).toContain("RCPT TO:<owner@example.com>");
      await page.fill(
        "[data-slot=second-step-form] input[name=password]",
        "another long password"
      );
      await page.click("[data-slot=second-step-form] button[type=submit]");
      await expect(
        page.locator("[data-slot=second-step-form][data-on=true]")
      ).toHaveCount(1);

      // The password alone now leads to the code; a trusted browser skips it next time.
      await signOut(page);
      await signInAs(page, "another long password");
      await enterCode(page, smtp.messages, true);
      await signOut(page);
      await signInAs(page, "another long password");
      await expectPath(page, "/admin/monitors");
      await signOut(page);

      // With email: the link arrives, sets the password, and the reset forgot the trusted browser.
      await page.click("a[href='/forgot-password']");
      // The link is the router's: the path moves before the page does, and the sign-in form has an email field too.
      await expectPath(page, "/forgot-password");
      await expect(page.locator("input[name=password]")).toHaveCount(0);
      await page.fill("input[name=email]", "not an email");
      await page.click(continueButton);
      await expectRefused(page, "form", ["email"]);
      await page.fill("input[name=email]", "owner@example.com");
      const before = smtp.messages.length;
      await page.click(continueButton);
      await expect(page.locator("[data-slot=reset-sent]")).toBeVisible();
      await expect.poll(() => smtp.messages.length).toBe(before + 1);
      await page.goto(resetLink.exec(lastMail(smtp.messages))?.[0] ?? "");
      await page.fill("input[name=newPassword]", "short");
      await page.click(continueButton);
      await expectRefused(page, "form", ["newPassword"]);
      await page.fill("input[name=newPassword]", "a password from the link");
      await page.click(continueButton);
      await expect(page.locator("[data-slot=reset-done]")).toBeVisible();
      await signInAs(page, "another long password");
      await expect(page.locator("form [role=alert]")).toHaveCount(1);
      await signInAs(page, "a password from the link");
      await enterCode(page, smtp.messages, false);

      // The authenticator app: set up from its key, in force with its first code, then ten backup codes shown once.
      await page.goto(`${freshOrigin}/admin/settings/sign-in`);
      const app = page.locator(
        "[data-slot=authenticator-form][data-app=false]"
      );
      await app
        .locator("input[name=password]")
        .fill("a password from the link");
      await app.locator("button[type=submit]").click();
      await expect(page.locator("[data-slot=authenticator-qr]")).toBeVisible();
      const key = page.locator("[data-slot=authenticator-key]");
      await expect(key).toHaveAttribute("dir", "ltr");
      const uri = `otpauth://totp/x?secret=${(await key.innerText()).replaceAll(" ", "")}`;
      await page.fill(
        "[data-slot=authenticator-scan] input[name=code]",
        appCode(uri)
      );
      await page.click("[data-slot=authenticator-scan] button[type=submit]");
      const shown = page.locator("[data-slot=backup-code]");
      await expect(shown).toHaveCount(10);
      const backupCodes = await shown.allInnerTexts();
      await page.click("[data-slot=backup-codes-done]");
      await expect(
        page.locator("[data-slot=authenticator-form][data-app=true]")
      ).toBeVisible();
      await expect(
        page.locator("[data-slot=second-step-form][data-on=true]")
      ).toHaveCount(1);
      await signOut(page);

      // The password now asks for the app's code, not an emailed one.
      const sentBefore = smtp.messages.length;
      await signInAs(page, "a password from the link");
      await expect(
        page.locator("[data-slot=code-form][data-method=app]")
      ).toBeVisible();
      await page.fill("input[name=code]", appCode(uri));
      await page.click("[data-slot=code-form] button[type=submit]");
      await expectPath(page, "/admin/monitors");
      expect(smtp.messages.length).toBe(sentBefore);
      await signOut(page);

      // A backup code works once, typed in capitals; the second time it is refused.
      const backup = backupCodes[0] ?? "";
      for (const [round, landed] of [
        [1, true],
        [2, false],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: the second sign-in follows the first
        await signInAs(page, "a password from the link");
        await page.click("[data-slot=use-backup]");
        await expect(
          page.locator("[data-slot=code-form][data-method=backup]")
        ).toBeVisible();
        await page.fill("input[name=code]", backup.toUpperCase());
        await page.click("[data-slot=code-form] button[type=submit]");
        if (landed) {
          await expectPath(page, "/admin/monitors");
          await signOut(page);
        } else {
          await expect(page.locator("form [role=alert]")).toHaveCount(1);
          await expectPath(page, "/sign-in");
          expect(round).toBe(2);
        }
      }

      // With an email channel, the code can be emailed instead.
      const mailed = smtp.messages.length;
      await page.click("[data-slot=use-email]");
      await expect(
        page.locator("[data-slot=code-form][data-method=email]")
      ).toBeVisible();
      await expect.poll(() => smtp.messages.length).toBe(mailed + 1);
      await enterCode(page, smtp.messages, false);
      await signOut(page);

      // Without email: the command beside the running server prints the same kind of link.
      const run = Bun.spawn(
        [
          "bun",
          "dist/server/server.js",
          "reset-password",
          "--data-dir",
          "test-results/data-fresh",
        ],
        { stderr: "pipe", stdin: "ignore", stdout: "pipe" }
      );
      const printed = await new Response(run.stdout).text();
      expect(await run.exited).toBe(0);
      // The second step was on, so the command switched it off with the app: shell access proves ownership.
      expect(printed).toContain("The second step is off");
      const link = resetLink.exec(printed)?.[0] ?? "";
      expect(new URL(link).origin).toBe(freshOrigin);
      await page.goto(link);
      await page.fill("input[name=newPassword]", "a password from the command");
      await page.click(continueButton);
      await expect(page.locator("[data-slot=reset-done]")).toBeVisible();
      await signInAs(page, "a password from the command");
      await expectPath(page, "/admin/monitors");
      await page.goto(`${freshOrigin}/admin/settings/sign-in`);
      await expect(
        page.locator("[data-slot=authenticator-form][data-app=false]")
      ).toBeVisible();
    } finally {
      smtp.stop();
    }
  });
});

test("the database screen shows what the connection test found and the DATABASE_URL line", async ({
  page,
}) => {
  await page.goto("/onboarding/database?locale=en");
  await page.click(radio("backend", "postgres"));
  await page.fill("input[name=url]", "postgres://u:p@127.0.0.1:1/raaqeb");
  await page.click("button[name=test]");
  await expect(page.locator("[data-verdict=unreachable]")).toHaveCount(1);
  await expect(page.locator("[data-verdict=unreachable]")).toHaveAttribute(
    "data-failure",
    "refused"
  );
  await expect(page.locator("output[name=databaseUrl]")).toHaveCount(0);
  // A line that is not a Postgres URL never reaches a server: the verdict says the URL is malformed, and continuing stays shut.
  await page.fill("input[name=url]", "not a url");
  await page.click("button[name=test]");
  await expect(
    page.locator("[data-verdict=unreachable][data-failure=malformed]")
  ).toHaveCount(1);
  await expect(page.locator(continueButton)).toBeDisabled();
});

test("during onboarding the sign-in page and the admin area go to onboarding", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await expectPath(page, "/onboarding");
  await page.goto("/admin");
  await expectPath(page, "/onboarding");
});

test("the account screen is not reachable before a database is chosen", async ({
  page,
}) => {
  await page.goto("/onboarding/account");
  await expectPath(page, "/onboarding/database");
});

test("the switcher on an onboarding screen renders the other locale for that document only", async ({
  page,
}) => {
  await page.goto("/onboarding?locale=en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.goto("/onboarding");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
});

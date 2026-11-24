// Single sign-on on an install of its own, against a local OpenID Connect
// provider: the owner sets the provider up on its settings page, an invited
// operator signs in through it under the invitation's role, and someone with
// no invitation comes back to the sign-in page told why.

import {
  invitationTokenHash,
  newInvitationToken,
} from "@/server/auth/invitation.ts";
import {
  type OidcProviderFixture,
  startOidcProvider,
} from "@/server/auth/oidc-fixture.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, seedAccount, spawnInstall } from "./support/spawn.ts";

test.describe("single sign-on", () => {
  let provider: OidcProviderFixture | undefined;
  let install: Install | undefined;
  test.beforeAll(async () => {
    provider = await startOidcProvider();
    install = await spawnInstall({
      account: true,
      language: "en",
      records: async (storage) => {
        const owner = await storage.operatorAccounts.findByEmail(operatorEmail);
        await storage.invitations.put({
          createdAt: Date.now(),
          email: "nadia@example.com",
          expiresAt: Date.now() + 86_400_000,
          id: "sso-invitation",
          invitedBy: owner?.id ?? null,
          role: "editor",
          tokenHash: invitationTokenHash(newInvitationToken()),
        });
      },
    });
  });
  test.afterAll(async () => {
    await install?.stop();
    provider?.stop();
  });

  test("the owner sets the provider up, an invited operator signs in through it as an editor, and an address with no invitation is told why", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    await page.goto(`${origin}/sign-in`);
    await expect(page.locator("[data-slot=sso-sign-in]")).toHaveCount(0);
    await page.fill("input[name=email]", operatorEmail);
    await page.fill("input[name=password]", operatorPassword);
    await page.click("form button[type=submit]");
    await expectPath(page, "/admin/monitors");
    await page.goto(`${origin}/admin/settings/single-sign-on`);
    await page.fill("input[name=name]", "Company login");
    await page.fill("input[name=discoveryUrl]", provider?.discoveryUrl ?? "");
    await page.fill("input[name=clientId]", provider?.clientId ?? "");
    await page.fill("input[name=clientSecret]", provider?.clientSecret ?? "");
    await page.click("label[for=enabled]");
    await page.click("[data-slot=sso-test]");
    await expect(page.locator("[data-slot=sso-tested]")).toHaveAttribute(
      "data-state",
      "ok"
    );
    await page.click("[data-slot=save-sso]");
    // Settled, not only pending: a disabled button is also a save still on its way.
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toBeVisible();

    await page.context().clearCookies();
    provider?.signInAs({
      email: "nadia@example.com",
      emailVerified: true,
      name: "Nadia",
      sub: "nadia",
    });
    await page.goto(`${origin}/sign-in`);
    await page.click("[data-slot=sso-sign-in]");
    await expectPath(page, "/admin/monitors");
    // An editor adds monitors, which a viewer cannot, and has no team in the sidebar.
    await expect(page.locator("[data-slot=new-monitor]")).toBeVisible();
    await expect(page.locator("[data-nav=team]")).toHaveCount(0);

    await page.context().clearCookies();
    provider?.signInAs({
      email: "stranger@example.com",
      emailVerified: true,
      name: "Stranger",
      sub: "stranger",
    });
    await page.goto(`${origin}/sign-in`);
    await page.click("[data-slot=sso-sign-in]");
    await expectPath(page, "/sign-in");
    await expect(page.locator("[data-failure=sso_not_invited]")).toBeVisible();
  });
});

test.describe("required single sign-on", () => {
  let provider: OidcProviderFixture | undefined;
  let install: Install | undefined;
  test.beforeAll(async () => {
    provider = await startOidcProvider();
    install = await spawnInstall({
      account: true,
      language: "en",
      records: (storage) =>
        seedAccount(storage, {
          email: "heir@example.com",
          name: "Heir",
          password: "an admin's password",
          role: "admin",
        }),
    });
  });
  test.afterAll(async () => {
    await install?.stop();
    provider?.stop();
  });

  test("an owner who hands ownership on from a password session is signed out, the password no longer lets them in, and the hand-over is in the audit log", async ({
    page,
  }) => {
    const origin = install?.origin ?? "";
    const signIn = async () => {
      await page.goto(`${origin}/sign-in`);
      await page.fill("input[name=email]", operatorEmail);
      await page.fill("input[name=password]", operatorPassword);
      await page.click("form button[type=submit]");
    };
    await signIn();
    await expectPath(page, "/admin/monitors");
    await page.goto(`${origin}/admin/settings/single-sign-on`);
    await page.fill("input[name=name]", "Company login");
    await page.fill("input[name=discoveryUrl]", provider?.discoveryUrl ?? "");
    await page.fill("input[name=clientId]", provider?.clientId ?? "");
    await page.fill("input[name=clientSecret]", provider?.clientSecret ?? "");
    await page.click("label[for=enabled]");
    await page.click("label[for=requireSso]");
    await page.click("[data-slot=save-sso]");
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toBeVisible();

    await page.goto(`${origin}/admin/team`);
    const heir = page.locator("[data-slot=team-member][data-role=admin]");
    await heir.locator("[data-slot=team-actions]").click();
    await page.click("[data-action=transfer]");
    await page.fill("input[name=password]", operatorPassword);
    await page.click("[role=dialog] button[type=submit]");
    await expectPath(page, "/sign-in");

    await signIn();
    await expect(page.locator("[data-failure=sso_required]")).toBeVisible();

    // The hand-over answered and was recorded although its session ended with it.
    await page.fill("input[name=email]", "heir@example.com");
    await page.fill("input[name=password]", "an admin's password");
    await page.click("form button[type=submit]");
    await expectPath(page, "/admin/monitors");
    await page.goto(`${origin}/admin/audit`);
    await expect(
      page.locator("[data-slot=audit-entry][data-action='ownership.change']")
    ).toHaveCount(1);
  });
});

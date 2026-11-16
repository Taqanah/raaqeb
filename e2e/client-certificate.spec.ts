// An HTTP monitor's client certificate in the form, on an install of its own:
// "test now" reaches a server that requires one with the certificate, its key
// and the CA the spec's server was signed by, is refused by name for a key that
// is not the certificate's, and the saved monitor shows the certificates and
// never the key, which the edit keeps when it is left empty. The certificates
// are made with openssl at run time.

import type { Page } from "@playwright/test";
import {
  type MutualTls,
  mutualTls,
  serveMutualTls,
} from "@/server/checks/mtls-fixture.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

const anyText = /\S/;
const detailPath = /^\/admin\/monitors\/[0-9a-f-]{36}$/;

let install: Install;
let certs: MutualTls;
let server: { stop: () => void; url: string };

test.beforeAll(async () => {
  install = await spawnInstall({ account: true, language: "en" });
  certs = await mutualTls();
  server = serveMutualTls(certs);
});

test.afterAll(async () => {
  server.stop();
  await certs.cleanup();
  await install.stop();
});

async function signIn(page: Page, path: string): Promise<void> {
  await page.goto(`${install.origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
  await page.goto(`${install.origin}${path}`);
  await expect(page.locator("[data-slot=monitor-form]")).toBeVisible();
}

test("a client certificate carries the test and the check, a key that is not its own is refused by name, and the edit shows the certificates and never the key", async ({
  page,
}) => {
  await signIn(page, "/admin/monitors/new");
  await page.fill("input[name=name]", "Partner API");
  await page.fill("input[name=url]", server.url);
  await page.fill("textarea[name=caCertificates]", certs.ca);
  // The key and its passphrase come with the certificate.
  await expect(page.locator("textarea[name=clientKey]")).toHaveCount(0);
  await page.fill("textarea[name=clientCertificate]", certs.client.cert);
  await page.fill("textarea[name=clientKey]", certs.clientOther.key);
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-panel] [role=alert]")
  ).toBeVisible();
  await expect(
    page.locator("[data-slot=test-result][data-result=up]")
  ).toHaveCount(0);

  await page.fill("textarea[name=clientKey]", certs.client.key);
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-result][data-result=up]")
  ).toBeVisible();

  await page.click("[data-slot=save-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
  // A saved monitor is due at once; the server answers no connection without the certificate, so the first check is up only if it carried it.
  await expect
    .poll(async () => {
      await page.reload();
      return await page.evaluate(
        () =>
          document
            .querySelector("[data-slot=monitor-state]")
            ?.getAttribute("data-state") ?? "none"
      );
    })
    .toBe("up");
  const detail = new URL(page.url()).pathname;
  await page.goto(`${install.origin}${detail}/edit`);
  await expect(page.locator("textarea[name=clientCertificate]")).toHaveValue(
    certs.client.cert.trim()
  );
  await expect(page.locator("textarea[name=caCertificates]")).toHaveValue(
    certs.ca.trim()
  );
  const key = page.locator("textarea[name=clientKey]");
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("placeholder", anyText);
  await expect(page.locator("body")).not.toContainText("PRIVATE KEY");

  // Left empty, the stored key is kept: the test still presents it.
  await page.click("[data-slot=test-now]");
  await expect(
    page.locator("[data-slot=test-result][data-result=up]")
  ).toBeVisible();

  // Emptying the certificate takes the key fields away with it.
  await page.fill("textarea[name=clientCertificate]", "");
  await expect(page.locator("textarea[name=clientKey]")).toHaveCount(0);
  await expect(page.locator("input[name=clientPassphrase]")).toHaveCount(0);
});

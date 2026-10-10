// The components and status pages screens, on the built
// entry, signed in on the English server, whose seeded monitors point at
// loopback ports nothing listens on, so they read down once checked. The
// tests build on one another and run in order.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
} from "./support/servers.ts";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
const linkedName = `Shop ${run}`;
const handName = `Support ${run}`;
const slug = `status-${run}`;
const componentPath = /^\/admin\/components\/[0-9a-f-]{36}$/;
const pagePath = /^\/admin\/pages\/[0-9a-f-]{36}$/;
const atLeastPartial = /^(partial_outage|major_outage)$/;

/** A 1 by 1 transparent PNG a browser decodes, so its preview has a size. */
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

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
/** The page the second test creates, unpublished until the third publishes it. */
let draftId = "";
let handId = "";

test("a component linked to a monitor derives its status; one with no link shows the status set by hand", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/components`);
  await page.click("[data-slot=add-component]");
  await expectPath(page, "/admin/components/new");
  await page.fill("input[name=name-en]", linkedName);
  await page
    .locator("[data-slot=component-monitor]", { hasText: "Website" })
    .locator("label")
    .click();
  // With a monitor linked, the status set by hand is greyed.
  await expect(
    page.locator("[data-slot=component-hand-status] [role=radio]").first()
  ).toBeDisabled();
  await page.click("[data-slot=save-component]");
  linkedId = await idOf(page, componentPath);
  await expect(page.locator("[data-slot=component-status]")).toBeVisible();

  await page.goto(`${englishOrigin}/admin/components/new`);
  await page.fill("input[name=name-en]", handName);
  await page.click(
    "[data-slot=component-hand-status] [role=radio][data-value=partial_outage]"
  );
  await page.click("[data-slot=save-component]");
  handId = await idOf(page, componentPath);
  await expect(
    page.locator("[data-slot=component-status][data-level=partial_outage]")
  ).toBeVisible();

  await page.goto(`${englishOrigin}/admin/components`);
  await expect(
    page.locator(
      `[data-component="${handId}"] [data-slot=component-status][data-level=partial_outage]`
    )
  ).toBeVisible();
  await expect(
    page.locator(`[data-component="${linkedId}"] [data-slot=component-status]`)
  ).toBeVisible();
});

test("a new page opens its editor, where components are placed and grouped, and the list shows its level", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/pages/new`);
  await page.fill("input[name=title]", `Status ${run}`);
  await page.fill("input[name=slug]", slug);
  await page.click("[data-slot=new-page-form] button[type=submit]");
  const pageId = await idOf(page, pagePath);
  draftId = pageId;

  await page.selectOption("select[name=add-component]", linkedId);
  await page.selectOption("select[name=add-component]", handId);
  await page.click("[data-slot=add-page-group]");
  await page.fill("[data-slot=page-group] input[lang=en]", "Core");
  await page.selectOption(
    `[data-slot=page-item][data-component="${handId}"] select[data-slot=move-to]`,
    { label: "Core" }
  );
  await expect(
    page.locator(`[data-slot=page-group] [data-component="${handId}"]`)
  ).toBeVisible();
  await page.click("[data-slot=save-page]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();

  // Read back from the server: the layout survived the save.
  await page.reload();
  await expect(
    page.locator(`[data-slot=page-group] [data-component="${handId}"]`)
  ).toBeVisible();
  await expect(
    page.locator(`[data-slot=page-layout] > [data-component="${linkedId}"]`)
  ).toBeVisible();

  await page.goto(`${englishOrigin}/admin/pages`);
  const row = page.locator(`[data-page="${pageId}"]`);
  await expect(row.locator("[data-slot=page-path]")).toHaveText(
    `/status/${slug}`
  );
  // The page shows a partial outage set by hand and a component linked to a monitor that is down or not yet checked: the level is at least partial.
  await expect(row.locator("[data-slot=page-level]")).toHaveAttribute(
    "data-level",
    atLeastPartial
  );
});

test("a visitor's not-found under an unpublished page never names it, at its views and at addresses that match none", async ({
  request,
}) => {
  const missing = "00000000-0000-7000-8000-000000000000";
  const addresses = [
    `/status/${slug}`,
    `/status/${slug}/history`,
    `/status/${slug}/history/1999-01`,
    `/status/${slug}/incidents/${missing}`,
    `/status/${slug}/maintenance/${missing}`,
    `/status/${slug}/no-such-view`,
    `/ar/status/${slug}/incidents/${missing}`,
  ];
  const answers = await Promise.all(
    addresses.map(async (address) => {
      const answer = await request.get(`${englishOrigin}${address}`);
      return { address, body: await answer.text(), status: answer.status() };
    })
  );
  for (const { address, body, status } of answers) {
    expect(status, address).toBe(404);
    // The page's title appears nowhere: not in the head, the body or the data the page hydrates from.
    expect(body, address).not.toContain(`Status ${run}`);
  }
});

test("a new page is unpublished: a visitor finds nothing at its addresses and its domain gets no certificate, the signed-in operator previews it, and publishing it makes it public", async ({
  page,
  request,
}) => {
  const domain = `draft-${run}.example.test`;
  // The English server trusts 127.0.0.1 as a proxy, so a forwarded host is the host the request came through.
  const onDomain = {
    headers: { "x-forwarded-host": domain, "x-forwarded-proto": "http" },
    maxRedirects: 0,
  };
  const visitorStatuses = async () => [
    (await request.get(`${englishOrigin}/status/${slug}`)).status(),
    (
      await request.get(`${englishOrigin}/api/pages/${draftId}/overview`)
    ).status(),
    (await request.get(`${englishOrigin}/status/${slug}/feed.atom`)).status(),
    (await request.get(`${englishOrigin}/`, onDomain)).status(),
    // The proxy's question before a certificate for the domain.
    (
      await request.get(
        `${englishOrigin}/api/custom-domain?domain=${encodeURIComponent(domain)}`
      )
    ).status(),
  ];

  await signIn(page);
  await page.goto(`${englishOrigin}/admin/pages`);
  await expect(
    page.locator(`[data-page="${draftId}"] [data-slot=page-unpublished]`)
  ).toBeVisible();
  await page.goto(`${englishOrigin}/admin/pages/${draftId}`);
  await page.fill("input[name=customDomain]", domain);
  await page.click("[data-slot=save-page]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();
  // The bare host of its custom domain is a not-found too, never the admin.
  expect(await visitorStatuses()).toEqual([404, 404, 404, 404, 404]);

  const preview = await page.goto(`${englishOrigin}/status/${slug}`);
  expect(preview?.status()).toBe(200);
  expect(preview?.headers()["cache-control"]).toBe("no-store");
  await expect(page.locator("[data-slot=preview-banner]")).toBeVisible();
  await expect(
    page.locator(`[data-slot=status-page][data-page="${draftId}"]`)
  ).toBeVisible();

  await page.goto(`${englishOrigin}/admin/pages/${draftId}`);
  await page.click("label[for=published]");
  await page.click("[data-slot=save-page]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();
  expect(await visitorStatuses()).toEqual([200, 200, 200, 200, 200]);
  await page.goto(`${englishOrigin}/status/${slug}`);
  await expect(
    page.locator(`[data-slot=status-page][data-page="${draftId}"]`)
  ).toBeVisible();
  await expect(page.locator("[data-slot=preview-banner]")).toHaveCount(0);
  await page.goto(`${englishOrigin}/admin/pages`);
  await expect(
    page.locator(`[data-page="${draftId}"] [data-slot=page-unpublished]`)
  ).toHaveCount(0);
});

test("a slug another page has is refused on the field, and a logo uploads and shows", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/pages/new`);
  await page.fill("input[name=title]", "Duplicate");
  await page.fill("input[name=slug]", slug);
  await page.click("[data-slot=new-page-form] button[type=submit]");
  await expect(page.locator("input[name=slug]")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  await expectPath(page, "/admin/pages/new");

  await page.goto(`${englishOrigin}/admin/pages`);
  await page
    .locator("[data-page] [data-slot=page-path]", {
      hasText: `/status/${slug}`,
    })
    .locator("xpath=ancestor::tr//a[@data-slot='page-title']")
    .click();
  await idOf(page, pagePath);
  await page.setInputFiles("input[name=image-logo]", {
    buffer: png,
    mimeType: "image/png",
    name: "logo.png",
  });
  const preview = page.locator(
    "[data-image=logo] [data-slot=page-image-preview]"
  );
  await expect(preview).toBeVisible();
  const src = await preview.getAttribute("src");
  const answer = await page.request.get(`${englishOrigin}${src}`);
  expect(answer.status()).toBe(200);
  expect(answer.headers()["content-type"]).toBe("image/png");
  expect(answer.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable"
  );
});

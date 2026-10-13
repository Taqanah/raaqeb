// Subscribing to a status page, on the
// built entry, on the English install, whose default page is seeded with
// four email subscriptions under known tokens. The form, a subscription's
// own page with its plain-form confirm and unsubscribe, an email client's
// one-click unsubscribe, and the admin's list. Each test changes a seeded
// subscription no other test reads, but the pending one, read before it is
// confirmed, in order.

import type { Page } from "@playwright/test";
import { runSql } from "@/server/storage/fixture.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  noticesPage,
  operatorEmail,
  operatorPassword,
  publicPage,
  seededSubscriptions,
} from "./support/servers.ts";

/** The subscribe button's tag in a page's HTML. */
const submitButton = /<button[^>]*data-slot="subscribe-submit"[^>]*>/;

/** The noscript block of a page's HTML. */
const noscriptBlock = /<noscript>([\s\S]*?)<\/noscript>/;

const pageOf = (token: string) => `${englishOrigin}/subscriptions/${token}`;

async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

test("the overview carries the subscribe form, and without JavaScript its noscript line links the feed", async ({
  request,
}) => {
  const html = await (await request.get(`${englishOrigin}/`)).text();
  expect(html).toContain('data-slot="subscribe-form"');
  const noscript = noscriptBlock.exec(html)?.[1] ?? "";
  expect(noscript).toContain('href="/feed.atom"');
  expect(noscript).toContain('data-slot="subscribe-noscript"');
  // Without JavaScript the form cannot post, so its button waits for hydration.
  const button = submitButton.exec(html)?.[0] ?? "";
  expect(button).toContain("disabled");
});

test("the form refuses a webhook that is not https on the public internet, and says so", async ({
  page,
}) => {
  await page.goto(`${englishOrigin}/`);
  // The form sits in the dialog the header's button opens.
  await page.click("[data-slot=subscribe-open]");
  const channel = page.locator(
    "[data-slot=subscribe-channel] [role=radio][data-value=webhook]"
  );
  if ((await channel.count()) > 0) {
    await channel.click();
  }
  const answer = page.locator("[data-slot=subscribe-answer]");
  await page.fill("input[name=address]", "http://hooks.example.com/raaqeb");
  await page.click("[data-slot=subscribe-submit]");
  await expect(answer).toHaveAttribute("data-state", "refused");
  await expect(answer).not.toBeEmpty();
  await page.fill("input[name=address]", "https://127.0.0.1:3213/ok/raaqeb");
  await page.click("[data-slot=subscribe-submit]");
  await expect(answer).toHaveAttribute("data-state", "refused");
  await expect(answer).not.toBeEmpty();
});

test.describe("the pending subscription, read and then confirmed", () => {
  test.describe.configure({ mode: "serial" });

  test("a subscription's page is never cached nor indexed, and opening its confirm link changes nothing", async ({
    page,
    request,
  }) => {
    const { token } = seededSubscriptions.pending;
    const answer = await request.get(pageOf(token));
    expect(answer.status()).toBe(200);
    expect(answer.headers()["cache-control"]).toBe("no-store");
    const opened = await request.get(`${pageOf(token)}/confirm`, {
      maxRedirects: 0,
    });
    expect(opened.status()).toBe(303);
    expect(opened.headers().location).toBe(`/subscriptions/${token}`);
    await page.goto(pageOf(token));
    await expect(page.locator("[data-slot=subscription]")).toHaveAttribute(
      "data-state",
      "pending"
    );
    await expect(page.locator("meta[name=robots]")).toHaveAttribute(
      "content",
      "noindex"
    );
  });

  test("its buttons confirm, then unsubscribe, each landing back on the page", async ({
    page,
  }) => {
    const { address, token } = seededSubscriptions.pending;
    await page.goto(pageOf(token));
    const panel = page.locator("[data-slot=subscription]");
    await expect(panel.locator("[data-slot=subscription-address]")).toHaveText(
      address
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.click("[data-slot=subscription-confirm]");
    await expectPath(page, `/subscriptions/${token}`);
    await expect(panel).toHaveAttribute("data-state", "confirmed");
    await expect(page.locator("[data-slot=subscription-confirm]")).toHaveCount(
      0
    );
    await page.click("[data-slot=subscription-unsubscribe]");
    await expectPath(page, `/subscriptions/${token}`);
    await expect(panel).toHaveAttribute("data-state", "unsubscribed");
    await expect(
      page.locator("[data-slot=subscription-unsubscribe]")
    ).toHaveCount(0);
  });
});

test("a subscription's page is in its subscription language, inside its status page's frame", async ({
  page,
}) => {
  await page.goto(pageOf(seededSubscriptions.arabic.token));
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("[data-slot=status-page]")).toBeVisible();
  await expect(page.locator("[data-slot=subscription]")).toHaveAttribute(
    "data-state",
    "confirmed"
  );
  // One language: the frame shows no switch to the other.
  await expect(page.locator("[data-slot=page-locale]")).toHaveCount(0);
});

test("an email client's one-click unsubscribe answers 200 with no redirect, and the subscription is gone", async ({
  page,
  request,
}) => {
  const { token } = seededSubscriptions.oneClick;
  const answer = await request.post(`${pageOf(token)}/unsubscribe`, {
    form: { "List-Unsubscribe": "One-Click" },
    maxRedirects: 0,
  });
  expect(answer.status()).toBe(200);
  await page.goto(pageOf(token));
  await expect(page.locator("[data-slot=subscription]")).toHaveAttribute(
    "data-state",
    "unsubscribed"
  );
});

test("a token no subscription has is not found", async ({ request }) => {
  const answer = await request.get(pageOf("e2e-unknown-token-0001"));
  expect(answer.status()).toBe(404);
  const posted = await request.post(
    `${pageOf("e2e-unknown-token-0001")}/confirm`,
    { maxRedirects: 0 }
  );
  expect(posted.status()).toBe(404);
});

test("the admin lists the page's subscribers from its editor, and removing one takes it off the list", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/pages`);
  await page
    .locator("[data-slot=page-title]", { hasText: publicPage.title })
    .click();
  await page.click("[data-slot=page-subscribers-link]");
  const rows = page.locator("[data-slot=subscriber]");
  await expect(rows).toHaveCount(4);
  const removed = rows.filter({
    hasText: seededSubscriptions.removed.address,
  });
  await expect(removed).toHaveAttribute("data-state", "pending");
  await removed.locator("[data-slot=remove-subscriber]").click();
  await page.click("[data-slot=confirm-remove-subscriber]");
  await expect(rows).toHaveCount(3);
  await expect(
    rows.filter({ hasText: seededSubscriptions.removed.address })
  ).toHaveCount(0);
});

/** The English install's database, which the spec reads beside the running server. */
const english = {
  backend: "sqlite",
  file: "test-results/data-en/raaqeb.sqlite",
} as const;

/** The event types queued for the notices page's subscriber, oldest first. */
async function queuedForNotices(): Promise<string[]> {
  const rows = await runSql(
    english,
    "SELECT n.payload AS payload FROM notifications n JOIN subscriptions s ON s.id = n.subscription_id WHERE s.token = ? ORDER BY n.queued_at",
    [noticesPage.subscriber.token]
  );
  return rows.map((row) => JSON.parse(String(row.payload)).type);
}

test("the admin's writes reach a confirmed subscriber: an incident published and updated, and a window scheduled, rescheduled and cancelled", async ({
  page,
}) => {
  const [component] = await runSql(
    english,
    "SELECT id FROM components WHERE name = ?",
    // A component's name is content, stored as its JSON text.
    [JSON.stringify({ en: noticesPage.component })]
  );
  const componentId = String(component?.id);
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/incidents/new`);
  await page.fill("input[name=title-en]", "Notices delayed");
  await page.fill("textarea[name=message-en]", "Notices go out late.");
  await page.click(`[data-component="${componentId}"] [role=checkbox]`);
  await page.click(
    `[data-component="${componentId}"] [data-slot=incident-component-status] [role=radio][data-value=partial_outage]`
  );
  await page.click("[data-slot=create-incident]");
  await expect(page.locator("[data-slot=incident-update]")).toHaveCount(1);
  await page.click(
    "[data-slot=incident-stage-choice] [role=radio][data-value=identified]"
  );
  await page.fill("textarea[name=message-en]", "A slow relay.");
  await page.click("[data-slot=post-update]");
  await expect(page.locator("[data-slot=incident-update]")).toHaveCount(2);
  await page.goto(`${englishOrigin}/admin/maintenance/new`);
  await page.fill("input[name=title-en]", "Relay swap");
  await page.fill("textarea[name=message-en]", "We replace the relay.");
  await page.click(
    `[data-slot=window-component][data-component="${componentId}"] label`
  );
  await page.click("[data-slot=create-window]");
  await expect(page.locator("[data-slot=save-window]")).toBeVisible();
  // An hour later on the same wall clock; the field holds `yyyy-mm-ddThh:mm`.
  const ends = await page.locator("input[name=ends]").inputValue();
  await page.fill(
    "input[name=ends]",
    new Date(Date.parse(`${ends}Z`) + 3_600_000).toISOString().slice(0, 16)
  );
  await page.click("[data-slot=save-window]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();
  await page.click("[data-slot=cancel-window]");
  await page.click("[data-slot=confirm-cancel]");
  await expectPath(page, "/admin/maintenance");
  await expect
    .poll(queuedForNotices)
    .toEqual([
      "incident.published",
      "incident.updated",
      "maintenance.scheduled",
      "maintenance.rescheduled",
      "maintenance.cancelled",
    ]);
});

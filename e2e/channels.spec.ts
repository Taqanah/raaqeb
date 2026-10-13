// The notification channels pages and the monitor
// form's channel selection, on the built entry, signed in on the English
// server, with the webhook pointed at the run's receiver
// (e2e/support/sink.ts). The tests that build on one channel run in order;
// beside them, one case per chat channel type fills its declared fields, and
// two tests with channels of their own pin the switches and the refusals.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
  sinkOrigin,
  sinkPort,
} from "./support/servers.ts";

// A token in the URL's path, as a Slack or Discord webhook carries one; the channel's name must not repeat it.
const run = Date.now().toString(36);
const token = `secret${run.split("").reverse().join("")}`;
const channelName = `Ops ${run}`;
const channelPath = /^\/admin\/channels\/[0-9a-f-]{36}$/;
const signingSecret = /^whsec_[A-Za-z0-9+/]{43}=$/;

interface Received {
  readonly body: string;
  readonly headers: Record<string, string | undefined>;
  readonly path: string;
}

async function receivedAt(path: string): Promise<Received[]> {
  const response = await fetch(`${sinkOrigin}/received`);
  const all = (await response.json()) as Received[];
  return all.filter((each) => each.path === path);
}

/** Whether a send's Standard Webhooks signature verifies under the secret. */
async function signedBy(
  secret: string,
  got: Received | undefined
): Promise<boolean> {
  const headers = got?.headers ?? {};
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    Buffer.from((headers["webhook-signature"] ?? "").slice(3), "base64"),
    new TextEncoder().encode(
      `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${got?.body}`
    )
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

async function openChannel(page: Page): Promise<string> {
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/channels`);
  await page
    .locator("[data-channel] [data-slot=channel-name]", {
      hasText: channelName,
    })
    .click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(channelPath);
  await expect(page.locator("[data-slot=channel-form]")).toBeVisible();
  return new URL(page.url()).pathname;
}

test.describe("one webhook channel, from its creation to its deletion", () => {
  test.describe.configure({ mode: "serial" });

  test("a new webhook channel stores its URL out of sight, and its page shows the signing secret and the URL's host", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/channels`);
    await page.click("[data-slot=add-channel]");
    await expectPath(page, "/admin/channels/new");
    await page.fill("[data-slot=channel-form] input[name=name]", channelName);
    await page.fill(
      "[data-slot=channel-form] input[name=url]",
      `${sinkOrigin}/ok/${token}`
    );
    await page.click("[data-slot=channel-form] button[type=submit]");
    await expect.poll(() => new URL(page.url()).pathname).toMatch(channelPath);
    await expect(page.locator("[data-slot=signing-secret]")).toHaveText(
      signingSecret
    );
    await expect(page.locator("[data-slot=channel-summary]")).toHaveText(
      `127.0.0.1:${sinkPort}`
    );
    await expect(
      page.locator("[data-slot=channel-form] input[name=url]")
    ).toHaveValue("");
    expect(await page.content()).not.toContain(token);
  });

  test("the channel page previews each notification's body as a sample and sends nothing", async ({
    page,
  }) => {
    await openChannel(page);
    const preview = page.locator("[data-slot=notification-preview]");
    await expect(preview.locator("[data-slot=preview-sample]")).toBeVisible();
    await expect(preview.locator("[data-preview]")).toHaveCount(6);
    await expect(
      preview.locator("[data-preview='monitor.down'] [data-slot=preview-body]")
    ).toContainText('"type": "monitor.down"');
    await expect(page.locator("[data-slot=recent-sends]")).toHaveCount(0);
    expect(await receivedAt(`/ok/${token}`)).toEqual([]);
  });

  test("send test posts one signed channel.test to the receiver and lists it as sent", async ({
    page,
  }) => {
    await openChannel(page);
    const secret =
      (await page.locator("[data-slot=signing-secret]").textContent()) ?? "";
    await page.click("[data-slot=send-test]");
    await expect(
      page.locator("[data-slot=test-result][data-status=sent]")
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("[data-slot=recent-sends] [data-send][data-status=sent]")
    ).toHaveCount(1);
    const [got] = await receivedAt(`/ok/${token}`);
    expect(JSON.parse(got?.body ?? "{}").type).toBe("channel.test");
    expect(await signedBy(secret, got)).toBe(true);
  });

  test("a receiver that answers an error shows the failed send with its reason", async ({
    page,
  }) => {
    await openChannel(page);
    await page.fill(
      "[data-slot=channel-form] input[name=url]",
      `${sinkOrigin}/broken/${token}`
    );
    await page.click("[data-slot=channel-form] button[type=submit]");
    await expect(
      page.locator("[data-slot=save-outcome][data-state=saved]")
    ).toBeVisible();
    await page.click("[data-slot=send-test]");
    await expect(
      page.locator("[data-slot=test-result][data-status=failed]")
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("[data-slot=test-result] [data-reason=unexpected_status]")
    ).toBeVisible();
    await expect(
      page.locator("[data-slot=recent-sends] [data-send]")
    ).toHaveCount(2);
  });

  test("the list shows the channel with its host and its newest send", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/channels`);
    const row = page.locator("[data-channel]", { hasText: channelName });
    await expect(row.locator("[data-slot=channel-summary]")).toHaveText(
      `127.0.0.1:${sinkPort}`
    );
    await expect(row.locator("[data-slot=last-send]")).toHaveAttribute(
      "data-status",
      "failed"
    );
  });

  test("a new monitor starts with the channel that applies to new monitors, and the operator can clear it", async ({
    page,
  }) => {
    const path = await openChannel(page);
    const id = path.split("/").at(-1) ?? "";
    await page.goto(`${englishOrigin}/admin/monitors/new`);
    const choice = page.locator(
      `[data-slot=monitor-channels] [role=checkbox][data-channel="${id}"]`
    );
    await expect(choice).toHaveAttribute("aria-checked", "true");
    await choice.click();
    await expect(choice).toHaveAttribute("aria-checked", "false");
  });

  test("deleting a channel asks first, then removes it from the list", async ({
    page,
  }) => {
    await openChannel(page);
    await page.click("[data-slot=delete-channel]");
    await page.click("[data-slot=confirm-delete]");
    await expectPath(page, "/admin/channels");
    await expect(
      page.locator("[data-channel]", { hasText: channelName })
    ).toHaveCount(0);
  });
});

interface ChatCase {
  /** The field of its body that holds the text or the topic, which the receiver checks. */
  readonly carries: string;
  readonly fields: Readonly<Record<string, string>>;
  /** Where the receiver gets its sends; absent for a platform the run cannot reach. */
  readonly path?: string;
  readonly summary: string;
  readonly type: string;
}

const chats: readonly ChatCase[] = [
  {
    carries: "text",
    fields: { url: `${sinkOrigin}/ok/slack-${token}` },
    path: `/ok/slack-${token}`,
    summary: `127.0.0.1:${sinkPort}`,
    type: "slack",
  },
  {
    carries: "content",
    fields: { url: `${sinkOrigin}/ok/discord-${token}` },
    path: `/ok/discord-${token}`,
    summary: `127.0.0.1:${sinkPort}`,
    type: "discord",
  },
  {
    carries: "topic",
    fields: { server: sinkOrigin, topic: `raaqeb-${run}` },
    path: "/",
    summary: `127.0.0.1:${sinkPort}`,
    type: "ntfy",
  },
  {
    carries: "chat_id",
    fields: {
      botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      chatId: "-1001234567890",
    },
    summary: "-1001234567890",
    type: "telegram",
  },
];

for (const chat of chats) {
  test(`a ${chat.type} channel's form draws the fields its type declares and saves them${chat.path === undefined ? "" : ", and its test reaches the receiver"}`, async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/channels/new`);
    await page.click(`[role=radio][data-value=${chat.type}]`);
    const form = page.locator("[data-slot=channel-form]");
    await expect(
      form.locator("[role=radiogroup][data-name=locale]")
    ).toBeVisible();
    await form.locator("input[name=name]").fill(`${chat.type} ${run}`);
    // Applying to no new monitor keeps every other spec's down monitor from sending to the platform's real host (Telegram's is fixed).
    const appliesToNew = form.locator(
      "[role=switch][aria-labelledby=appliesToNew-label]"
    );
    await appliesToNew.click();
    await expect(appliesToNew).toHaveAttribute("aria-checked", "false");
    // Filled one after another; the form redraws its fields on each input.
    await Object.entries(chat.fields).reduce(async (before, [name, value]) => {
      await before;
      const input = form.locator(`input[name=${name}]`);
      await expect(input).toBeVisible();
      await input.fill(value);
    }, Promise.resolve());
    await form.locator("button[type=submit]").click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(channelPath);
    await expect(page.locator("[data-slot=channel-summary]")).toHaveText(
      chat.summary
    );
    expect(await page.content()).not.toContain(token);
    // The English server's channel writes in English; its down sample names the event.
    await expect(
      page.locator(
        "[data-slot=notification-preview] [data-preview='monitor.down']"
      )
    ).toContainText(" is down");
    if (chat.path === undefined) {
      return;
    }
    await page.click("[data-slot=send-test]");
    await expect(
      page.locator("[data-slot=test-result][data-status=sent]")
    ).toBeVisible({ timeout: 15_000 });
    // The test message names its channel, so this send is told from the other types' sends.
    const sends = (await receivedAt(chat.path)).map((each) =>
      JSON.parse(each.body)
    );
    expect(
      sends.filter(
        (each) =>
          typeof each[chat.carries] === "string" &&
          JSON.stringify(each).includes(`${chat.type} ${run}`)
      )
    ).toHaveLength(1);
  });
}

test("a channel that does not apply to new monitors starts unticked on the new-monitor form, and a renewed signing secret signs the next send", async ({
  page,
}) => {
  const path = `/ok/renew-${token}`;
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/channels/new`);
  const form = page.locator("[data-slot=channel-form]");
  const appliesToNew = form.locator(
    "[role=switch][aria-labelledby=appliesToNew-label]"
  );
  await form.locator("input[name=name]").fill(`Renew ${run}`);
  await expect(appliesToNew).toHaveAttribute("aria-checked", "true");
  await appliesToNew.click();
  await form.locator("input[name=url]").fill(`${sinkOrigin}${path}`);
  await form.locator("button[type=submit]").click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(channelPath);
  const channelPage = page.url();
  const id = new URL(channelPage).pathname.split("/").at(-1) ?? "";
  const before =
    (await page.locator("[data-slot=signing-secret]").textContent()) ?? "";
  await page.reload();
  await expect(appliesToNew).toHaveAttribute("aria-checked", "false");

  await page.goto(`${englishOrigin}/admin/monitors/new`);
  await expect(
    page.locator(
      `[data-slot=monitor-channels] [role=checkbox][data-channel="${id}"]`
    )
  ).toHaveAttribute("aria-checked", "false");

  await page.goto(channelPage);
  const renew = form.locator(
    "[role=switch][aria-labelledby=renewGenerated-label]"
  );
  await renew.click();
  await form.locator("button[type=submit]").click();
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();
  const secret = page.locator("[data-slot=signing-secret]");
  await expect(secret).toHaveText(signingSecret);
  await expect(secret).not.toHaveText(before);
  // The switch is for one save; the next save keeps the new secret.
  await expect(renew).toHaveAttribute("aria-checked", "false");
  const after = (await secret.textContent()) ?? "";
  await page.click("[data-slot=send-test]");
  await expect(
    page.locator("[data-slot=test-result][data-status=sent]")
  ).toBeVisible({ timeout: 15_000 });
  const [got] = await receivedAt(path);
  expect(await signedBy(after, got)).toBe(true);
  expect(await signedBy(before, got)).toBe(false);
});

test("the channel form refuses a bad webhook URL, an email sender that is not an address and a missing SMTP host beside each field, and saves nothing", async ({
  page,
}) => {
  const name = `Refused ${run}`;
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/channels/new`);
  const form = page.locator("[data-slot=channel-form]");
  const invalid = (field: string) =>
    form.locator(`[name=${field}][aria-invalid=true]`);
  const refused = page.locator(
    "[data-slot=save-outcome][data-state=failed][data-reason=invalid]"
  );
  await form.locator("input[name=url]").fill("not a url");
  await form.locator("button[type=submit]").click();
  await expect(invalid("url")).toBeVisible();
  await expect(invalid("name")).toBeVisible();
  await expect(refused).toBeVisible();
  // The first marked field takes the focus, and a refusal clears as its field is edited, without another save.
  await expect(form.locator("input[name=name]")).toBeFocused();
  await form.locator("input[name=name]").fill(name);
  await expect(invalid("name")).toHaveCount(0);
  await expect(invalid("url")).toBeVisible();
  await form.locator("input[name=url]").fill("https://example.test/hook");
  await expect(invalid("url")).toHaveCount(0);

  await page.click("[role=radio][data-value=email]");
  await form.locator("input[name=from]").fill("not-an-address");
  await form.locator("input[name=to]").fill("ops@example.com");
  await form.locator("button[type=submit]").click();
  await expect(invalid("from")).toBeVisible();
  await expect(invalid("from")).toBeFocused();
  await expect(invalid("host")).toBeVisible();
  await expect(invalid("to")).toHaveCount(0);
  await expect(invalid("name")).toHaveCount(0);
  await expect(refused).toBeVisible();
  await expectPath(page, "/admin/channels/new");

  await page.goto(`${englishOrigin}/admin/channels`);
  await expect(page.locator("[data-channel]", { hasText: name })).toHaveCount(
    0
  );
});

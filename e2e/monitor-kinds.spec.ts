// Every check type saved through the monitor form and reopened, the form's
// refusals per type, acknowledging an outage, and the list's bulk changes,
// on the built entry, signed in on the English server. Each test makes the
// monitors it needs under names and a group of its own, so the tests run in
// parallel with each other and with every other spec. Every target is a
// loopback port nothing listens on, and each monitor is saved with no
// channel ticked, so its down events notify nobody.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  englishOrigin,
  operatorEmail,
  operatorPassword,
  sinkOrigin,
} from "./support/servers.ts";

// A monitor's detail page: its id is a UUID, so /admin/monitors/new never matches.
const detailPath = /^\/admin\/monitors\/[0-9a-f-]{36}$/;
const editPath = /^\/admin\/monitors\/[0-9a-f-]{36}\/edit$/;
const channelPath = /^\/admin\/channels\/[0-9a-f-]{36}$/;

/** A name no other test of the run carries. */
function unique(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 6)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

/** Clears every channel the new-monitor form ticked, the ones that apply to new monitors. */
async function untickChannels(page: Page): Promise<void> {
  const ticked = page.locator(
    "[data-slot=monitor-channels] [role=checkbox][aria-checked=true]"
  );
  for (let left = await ticked.count(); left > 0; left -= 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each click redraws the list the next one reads
    await ticked.first().click();
    await expect(ticked).toHaveCount(left - 1);
  }
}

/** Saves a TCP monitor through the form and answers its id, from its detail page. */
async function createTcpMonitor(
  page: Page,
  monitor: {
    readonly group: string;
    readonly name: string;
    readonly tags?: string;
  }
): Promise<string> {
  await page.goto(`${englishOrigin}/admin/monitors/new`);
  await page.fill("input[name=name]", monitor.name);
  await page.click("[role=radio][data-value=tcp]");
  await page.fill("input[name=host]", "127.0.0.1");
  await page.fill("input[name=port]", "1");
  // Down on the first refused check, so an outage opens at once.
  await page.fill("input[name=retries]", "0");
  await page.fill("input[name=group]", monitor.group);
  await page.fill("input[name=tags]", monitor.tags ?? "");
  await untickChannels(page);
  await page.click("[data-slot=save-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
  return new URL(page.url()).pathname.split("/").at(-1) ?? "";
}

interface Kind {
  /** The database type picked under the database check type. */
  readonly database?: string;
  /** Each input the form shows for the type, and what is typed in it. */
  readonly fields: Readonly<Record<string, string>>;
  /** A select and the option picked in it. */
  readonly select?: readonly [string, string];
  /** What the edit form holds after the save, where it differs from what was typed. */
  readonly stored?: Readonly<Record<string, string>>;
  /** What the detail page shows as the monitor's target. */
  readonly target: string;
  readonly type: string;
}

const kinds: readonly Kind[] = [
  {
    fields: { host: "127.0.0.1", port: "9" },
    target: "127.0.0.1:9",
    type: "tcp",
  },
  {
    fields: {
      dnsName: "example.com",
      expected: "mail.example.com",
      resolver: "127.0.0.1:1",
    },
    select: ["recordType", "MX"],
    target: "example.com",
    type: "dns",
  },
  {
    database: "postgres",
    fields: {
      answerExpected: "1",
      connectionUrl: "postgres://watch:pg-secret-pass@127.0.0.1:1/app",
      query: "SELECT 1",
    },
    stored: { connectionUrl: "" },
    target: "127.0.0.1:1",
    type: "database",
  },
  {
    database: "mysql",
    fields: {
      answerExpected: "1",
      connectionUrl: "mysql://watch:my-secret-pass@127.0.0.1:2/app",
      query: "SELECT 1",
    },
    stored: { connectionUrl: "" },
    target: "127.0.0.1:2",
    type: "database",
  },
  {
    database: "redis",
    fields: {
      answerExpected: "PONG",
      connectionUrl: "redis://:rd-secret-pass@127.0.0.1:3/0",
      query: "PING",
    },
    stored: { connectionUrl: "" },
    target: "127.0.0.1:3",
    type: "database",
  },
  {
    fields: {
      container: "kinds-api",
      dockerEndpoint: "/tmp/raaqeb-e2e-no-daemon.sock",
    },
    target: "kinds-api",
    type: "docker",
  },
];

for (const kind of kinds) {
  const label = kind.database ?? kind.type;
  test(`a ${label} monitor saves from the form, shows its target, and its edit form holds what was typed${kind.stored ? ", the connection URL kept out of sight" : ""}`, async ({
    page,
  }) => {
    const name = unique(label);
    await signIn(page);
    await page.goto(`${englishOrigin}/admin/monitors/new`);
    await page.fill("input[name=name]", name);
    await page.click(`[data-name=type] [role=radio][data-value=${kind.type}]`);
    if (kind.database) {
      await page.click(
        `[data-name=databaseType] [role=radio][data-value=${kind.database}]`
      );
    }
    const form = page.locator("[data-slot=monitor-form]");
    // Filled one after another; the form redraws its fields on each input.
    await Object.entries(kind.fields).reduce(async (before, [field, value]) => {
      await before;
      await form.locator(`[name=${field}]`).fill(value);
    }, Promise.resolve());
    if (kind.select) {
      await form
        .locator(`select[name=${kind.select[0]}]`)
        .selectOption(kind.select[1]);
    }
    await page.fill("input[name=group]", name);
    await untickChannels(page);
    await page.click("[data-slot=save-monitor]");
    await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
    await expect(page.locator("h1")).toHaveText(name);
    await expect(page.locator("[data-slot=monitor-target]")).toHaveText(
      kind.target
    );
    const detail = new URL(page.url()).pathname;
    await page.click("[data-slot=edit-monitor]");
    await expectPath(page, `${detail}/edit`);
    await expect(
      page.locator(`[data-name=type] [role=radio][data-value=${kind.type}]`)
    ).toHaveAttribute("aria-checked", "true");
    if (kind.database) {
      await expect(
        page.locator(
          `[data-name=databaseType] [role=radio][data-value=${kind.database}]`
        )
      ).toHaveAttribute("aria-checked", "true");
    }
    const stored = { ...kind.fields, ...kind.stored };
    await Promise.all(
      Object.entries(stored).map(([field, value]) =>
        expect(form.locator(`[name=${field}]`)).toHaveValue(value)
      )
    );
    if (kind.select) {
      await expect(form.locator(`select[name=${kind.select[0]}]`)).toHaveValue(
        kind.select[1]
      );
    }
    await expect(page.locator("input[name=group]")).toHaveValue(name);
    if (kind.stored) {
      expect(await page.content()).not.toContain("secret-pass");
      // A save that leaves the connection URL empty keeps the stored one.
      await page.fill("input[name=name]", `${name} renamed`);
      await page.click("[data-slot=save-monitor]");
      await expectPath(page, detail);
      await expect(page.locator("[data-slot=monitor-target]")).toHaveText(
        kind.target
      );
    }
  });
}

test("a heartbeat monitor on a cron schedule saves, opens its edit page, and keeps its expression and grace period", async ({
  page,
}) => {
  const name = unique("cron");
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/monitors/new`);
  await page.fill("input[name=name]", name);
  await page.click("[data-name=type] [role=radio][data-value=heartbeat]");
  await page.click("[data-name=scheduleKind] [role=radio][data-value=cron]");
  await page.fill("input[name=cron]", "30 2 * * *");
  await page.fill("input[name=grace]", "15");
  await page.click("[data-name=graceUnit] [role=radio][data-value=minutes]");
  await page.fill("input[name=group]", name);
  await untickChannels(page);
  await page.click("[data-slot=save-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(editPath);
  await expect(page.locator("[data-slot=heartbeat-url]")).toContainText(
    `${englishOrigin}/api/heartbeat/`
  );
  await page.reload();
  await expect(
    page.locator("[data-name=scheduleKind] [role=radio][data-value=cron]")
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("input[name=cron]")).toHaveValue("30 2 * * *");
  await expect(page.locator("input[name=grace]")).toHaveValue("15");
  await expect(
    page.locator("[data-name=graceUnit] [role=radio][data-value=minutes]")
  ).toHaveAttribute("aria-checked", "true");
});

test("the form refuses a bad field of each check type beside the field, focuses the first, and saves nothing", async ({
  page,
}) => {
  const name = unique("refused");
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/monitors/new`);
  await page.fill("input[name=name]", name);
  const refusal = (path: string) => page.locator(`[data-error-for='${path}']`);

  await page.click("[data-name=type] [role=radio][data-value=tcp]");
  await page.fill("input[name=port]", "70000");
  await page.click("[data-slot=save-monitor]");
  await expect(refusal("config.host")).toBeVisible();
  await expect(refusal("config.port")).toBeVisible();
  await expect(page.locator("input[name=host]")).toBeFocused();
  await expect(page.locator("input[name=port]")).toHaveAttribute(
    "aria-invalid",
    "true"
  );

  await page.click("[data-name=type] [role=radio][data-value=dns]");
  await page.fill("input[name=dnsName]", "not a name!");
  await page.fill("input[name=resolver]", "not-an-address");
  await page.click("[data-slot=save-monitor]");
  await expect(refusal("config.name")).toBeVisible();
  await expect(refusal("config.resolver")).toBeVisible();

  await page.click("[data-name=type] [role=radio][data-value=database]");
  await page.click(
    "[data-name=databaseType] [role=radio][data-value=postgres]"
  );
  await page.fill("input[name=connectionUrl]", "mysql://u:p@127.0.0.1:1/app");
  await page.click("[data-slot=save-monitor]");
  await expect(refusal("credentials.url")).toBeVisible();

  await page.click("[data-name=type] [role=radio][data-value=heartbeat]");
  await page.click("[data-name=scheduleKind] [role=radio][data-value=cron]");
  await page.fill("input[name=cron]", "61 * * *");
  await page.click("[data-slot=save-monitor]");
  await expect(refusal("config.schedule.expression")).toBeVisible();
  await expect(
    page.locator("[data-slot=save-outcome][data-state=failed]")
  ).toBeVisible();

  await expectPath(page, "/admin/monitors/new");
  await page.goto(`${englishOrigin}/admin/monitors?q=${name}`);
  await expect(page.locator("[data-slot=monitor-no-matches]")).toHaveCount(1);
});

test("an open outage is acknowledged from the monitor's page and from the list's item menu, and is then no longer offered", async ({
  page,
}) => {
  const group = unique("ack");
  await signIn(page);
  const first = await createTcpMonitor(page, { group, name: `${group}-p` });
  await page.click("[data-slot=check-now]");
  const acknowledge = page.locator("[data-slot=acknowledge-outage]");
  await expect(acknowledge).toBeVisible({ timeout: 15_000 });
  await acknowledge.click();
  await expect(page.locator("[data-slot=outage-acknowledged]")).toBeVisible();
  await expect(acknowledge).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-slot=outage-acknowledged]")).toBeVisible();
  await expect(acknowledge).toHaveCount(0);

  const second = await createTcpMonitor(page, {
    group,
    name: `${group}-l`,
  });
  await page.click("[data-slot=check-now]");
  await expect(acknowledge).toBeVisible({ timeout: 15_000 });
  await page.goto(`${englishOrigin}/admin/monitors?group=${group}`);
  const menu = (id: string) =>
    page.locator(`[data-monitor="${id}"] [data-slot=monitor-menu]`);
  // The one acknowledged on its page is not offered again.
  await menu(first).click();
  await expect(page.locator("[data-action=duplicate]")).toBeVisible();
  await expect(page.locator("[data-action=acknowledge]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await menu(second).click();
  await page.click("[data-action=acknowledge]");
  // The menu has closed, so a toast says it went through.
  await expect(page.locator("[data-slot=toast]")).toBeVisible();
  await expect(page.locator("[data-action=acknowledge]")).toHaveCount(0);
  await page.reload();
  await menu(second).click();
  await expect(page.locator("[data-action=duplicate]")).toBeVisible();
  await expect(page.locator("[data-action=acknowledge]")).toHaveCount(0);
  await page.goto(`${englishOrigin}/admin/monitors/${second}`);
  await expect(page.locator("[data-slot=outage-acknowledged]")).toBeVisible();
  await expect(acknowledge).toHaveCount(0);
});

test("in bulk, monitors gain and lose a channel, lose a tag and move group; on a phone they are selected and deleted after a confirm", async ({
  page,
}) => {
  const group = unique("bulk");
  const moved = unique("moved");
  const tag = unique("t");
  await signIn(page);
  // A channel of this test's own that applies to no new monitor, so no other spec's monitor ticks it.
  await page.goto(`${englishOrigin}/admin/channels/new`);
  const channelForm = page.locator("[data-slot=channel-form]");
  await channelForm.locator("input[name=name]").fill(group);
  await channelForm
    .locator("[role=switch][aria-labelledby=appliesToNew-label]")
    .click();
  await channelForm
    .locator("input[name=url]")
    .fill(`${sinkOrigin}/ok/${group}`);
  await channelForm.locator("button[type=submit]").click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(channelPath);
  const channel = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const first = await createTcpMonitor(page, {
    group,
    name: `${group}-a`,
    tags: tag,
  });
  await createTcpMonitor(page, { group, name: `${group}-b`, tags: tag });

  const rows = page.locator("[data-monitor]");
  const dialog = page.locator("[data-slot=monitor-change-dialog]");
  /** Selects every row shown and applies one change to them. */
  const change = async (kind: string, field: string, value: string) => {
    await page.click("[data-slot=monitor-select-all]");
    await expect(page.locator("[data-slot=monitor-bulk]")).toContainText("2");
    await page.click("[data-slot=monitor-bulk] [data-action=change]");
    await page.click(`[data-change=${kind}]`);
    const input = dialog.locator(`[name=${field}]`);
    await (field === "group"
      ? input.fill(value)
      : input.selectOption(value).then(() => undefined));
    await dialog.locator("[data-slot=monitor-change-apply]").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-slot=monitor-bulk]")).toHaveCount(0);
  };
  const channelChoice = page.locator(
    `[data-slot=monitor-channels] [role=checkbox][data-channel="${channel}"]`
  );

  await page.goto(`${englishOrigin}/admin/monitors?group=${group}`);
  await expect(rows).toHaveCount(2);
  await change("add_channel", "channel", channel);
  await change("remove_tag", "tag", tag);
  await expect(page.locator("[data-slot=monitor-tag]")).toHaveCount(0);
  await change("set_group", "group", moved);
  await page.goto(`${englishOrigin}/admin/monitors?group=${moved}`);
  await expect(rows).toHaveCount(2);
  await expect(rows.locator("[data-slot=monitor-group]")).toHaveText([
    moved,
    moved,
  ]);
  await page.goto(`${englishOrigin}/admin/monitors/${first}/edit`);
  await expect(channelChoice).toHaveAttribute("aria-checked", "true");

  await page.goto(`${englishOrigin}/admin/monitors?group=${moved}`);
  await change("remove_channel", "channel", channel);
  await page.goto(`${englishOrigin}/admin/monitors/${first}/edit`);
  await expect(channelChoice).toHaveAttribute("aria-checked", "false");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${englishOrigin}/admin/monitors?group=${moved}`);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === window.innerWidth
    )
  ).toBe(true);
  await rows.first().locator("[data-slot=monitor-menu]").click();
  await expect(page.locator("[data-action=duplicate]")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.click("[data-slot=monitor-select-all-phone]");
  const bulk = page.locator("[data-slot=monitor-bulk]");
  await expect(bulk).toContainText("2");
  await bulk.locator("[data-action=delete]").click();
  const confirm = page.locator("[data-slot=monitor-delete-dialog]");
  await expect(confirm).toBeVisible();
  await page.click("[data-slot=alert-dialog-cancel]");
  await expect(confirm).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await bulk.locator("[data-action=delete]").click();
  await page.click("[data-slot=monitor-delete-confirm]");
  await expect(rows).toHaveCount(0);
  await expect(page.locator("[data-slot=monitor-no-matches]")).toHaveCount(1);
  await page.reload();
  await expect(rows).toHaveCount(0);
  await page.goto(`${englishOrigin}/admin/monitors/${first}`);
  await expect(page.locator("[data-slot=monitor-summary]")).toHaveCount(0);
});

test("an HTTP monitor's bearer token is stored out of sight, and its capture mode, own retention and degraded threshold come back on edit", async ({
  page,
}) => {
  const name = unique("http");
  const token = `tok${Date.now().toString(36)}secret`;
  await signIn(page);
  await page.goto(`${englishOrigin}/admin/monitors/new`);
  await page.fill("input[name=name]", name);
  await page.fill("input[name=url]", "http://127.0.0.1:1/kinds");
  await page.click("[data-name=auth] [role=radio][data-value=bearer]");
  await page.fill("input[name=token]", token);
  await page.click(
    "[data-name=captureMode] [role=radio][data-value=on_failure]"
  );
  await page.click("[data-name=retention] [role=radio][data-value=custom]");
  await page.fill("input[name=retentionDays]", "30");
  await page.fill("input[name=degradedMs]", "500");
  await page.fill("input[name=group]", name);
  await untickChannels(page);
  await page.click("[data-slot=save-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(detailPath);
  await page.click("[data-slot=edit-monitor]");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(editPath);
  await expect(
    page.locator("[data-name=auth] [role=radio][data-value=bearer]")
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("input[name=token]")).toHaveValue("");
  expect(await page.content()).not.toContain(token);
  await expect(
    page.locator("[data-name=captureMode] [role=radio][data-value=on_failure]")
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.locator("[data-name=retention] [role=radio][data-value=custom]")
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("input[name=retentionDays]")).toHaveValue("30");
  await expect(page.locator("input[name=degradedMs]")).toHaveValue("500");
  // A threshold makes the degraded pair possible, so its events can be chosen.
  await expect(
    page.locator("[data-slot=monitor-events] [data-event=degraded_started]")
  ).toBeEnabled();
});

// A long group name and tags end in an ellipsis inside the organization cell, so the row never pushes the item menu off the side of the list.
test("a long group name and tags stay inside the list at 1280 px, the item menu in view", async ({
  page,
}) => {
  const group = unique("a-group-name-written-out-in-full-words");
  await signIn(page);
  await createTcpMonitor(page, {
    group,
    name: unique("long"),
    tags: `${unique("a-tag-written-out-in-words")}, ${unique("another-tag-written-out-in-words")}`,
  });
  await page.goto(`${englishOrigin}/admin/monitors?group=${group}`);
  await expect(
    page.locator("[data-monitor] [data-slot=monitor-menu]")
  ).toBeInViewport({ ratio: 1 });
  expect(
    await page
      .locator("[data-slot=monitor-list] table")
      .evaluate(
        (table) => table.scrollWidth <= (table.parentElement?.clientWidth ?? 0)
      )
  ).toBe(true);
});

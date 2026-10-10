/**
 * The operator's steps the status page specs share, each through the
 * admin's screens on the English install: sign in, add a component set by
 * hand, and publish a page of the spec's own that shows it. A spec that
 * writes to its own page never touches the seeded ones other specs read.
 */
import type { Page } from "@playwright/test";
import { expect, expectPath } from "./fixtures.ts";
import { englishOrigin, operatorEmail, operatorPassword } from "./servers.ts";

/** A value no other run of the suite shares, for names and slugs. */
export const runId = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function signIn(page: Page): Promise<void> {
  await page.goto(`${englishOrigin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

/** The id at the end of the path, once the path is a record's. */
export async function idOf(page: Page, pattern: RegExp): Promise<string> {
  await expect.poll(() => new URL(page.url()).pathname).toMatch(pattern);
  return new URL(page.url()).pathname.split("/").at(-1) ?? "";
}

const componentPath = /^\/admin\/components\/[0-9a-f-]{36}$/;
const pagePath = /^\/admin\/pages\/[0-9a-f-]{36}$/;

/** A component linked to no monitor, at the status set by hand; its id. */
export async function handComponent(
  page: Page,
  name: string,
  level = "operational"
): Promise<string> {
  await page.goto(`${englishOrigin}/admin/components/new`);
  await page.fill("input[name=name-en]", name);
  await page.click(
    `[data-slot=component-hand-status] [role=radio][data-value=${level}]`
  );
  await page.click("[data-slot=save-component]");
  return await idOf(page, componentPath);
}

/** A new English page at `/status/<slug>` showing the components in order, published; its id. The editor stays open on it. */
export async function publishedPage(
  page: Page,
  slug: string,
  componentIds: readonly string[]
): Promise<string> {
  await page.goto(`${englishOrigin}/admin/pages/new`);
  await page.fill("input[name=title]", `Page ${slug}`);
  await page.fill("input[name=slug]", slug);
  await page.click("[data-slot=new-page-form] button[type=submit]");
  const id = await idOf(page, pagePath);
  for (const componentId of componentIds) {
    // biome-ignore lint/performance/noAwaitInLoops: each pick changes the select the next one uses
    await page.selectOption("select[name=add-component]", componentId);
  }
  await page.click("label[for=published]");
  await savePage(page);
  return id;
}

/** Saves the page editor and waits for the saved outcome. */
export async function savePage(page: Page): Promise<void> {
  await page.click("[data-slot=save-page]");
  await expect(
    page.locator("[data-slot=save-outcome][data-state=saved]")
  ).toBeVisible();
}

/** The minute a time reads on the operator's clock, as a datetime-local field takes it. */
export function wallTime(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-u-nu-latn-ca-gregory", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * The start of a window from now, as the field takes it: this minute, or the
 * next one in a minute's last ten seconds, since the server would read this
 * minute as past by the time the form reaches it. The scheduler then starts
 * the window at its first tick in that minute, which the caller waits for.
 */
export function startingNow(timeZone: string): string {
  const now = Date.now();
  return wallTime(
    new Date(now).getSeconds() > 50 ? now + 60_000 : now,
    timeZone
  );
}

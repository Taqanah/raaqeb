// Every surface under the content security policy, on installs of the spec's
// own: each document names a nonce in its policy, its inline scripts and the
// page's custom CSS still run, and the browser reports no violation and no
// console error on any of them.

import type { Page } from "@playwright/test";
import { createIncident } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { createComponent } from "@/server/pages/components.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

declare global {
  interface Window {
    cspViolated?: (line: string) => void;
  }
}

/** The records the walk reads, by the ids the seed made. */
const seeded = { incident: "", page: "", window: "" };

/** Draws an outline only a style element the policy let through can draw. */
const customCss =
  "[data-slot=status-page] { outline: 3px solid rgb(1, 2, 3); }";

async function seed(storage: Storage): Promise<void> {
  const component = await createComponent(storage, {
    description: undefined,
    monitorIds: [],
    name: { en: "Api" },
    status: "operational",
  });
  const open = await createPage(storage, {
    locale: "en",
    slug: "open",
    title: "Open status",
  });
  const locked = await createPage(storage, {
    locale: "en",
    slug: "locked",
    title: "Locked status",
  });
  if (!(component.ok && open.ok && locked.ok)) {
    throw new Error("the pages could not be seeded");
  }
  const layout = [
    { componentId: component.component.id, kind: "component" as const },
  ];
  await savePage(storage, open.page.id, {
    customDomain: undefined,
    customization: { ...defaultCustomization, customCss, theme: "dark" },
    isDefault: true,
    layout,
    locale: "en",
    published: true,
    slug: "open",
    title: { ar: "الحالة", en: "Open status" },
  });
  await savePage(storage, locked.page.id, {
    access: { addresses: [], mode: "password", password: "correct horse" },
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    layout,
    locale: "en",
    published: true,
    slug: "locked",
    title: { en: "Locked status" },
  });
  const incident = await createIncident(
    storage,
    {
      impact: "minor",
      message: { en: "Some calls are slow." },
      stage: "investigating",
      statuses: [
        {
          componentId: component.component.id,
          status: "degraded_performance",
        },
      ],
      title: { en: "Slow calls" },
    },
    operatorEmail
  );
  const now = Date.now();
  const window = await createWindow(
    storage,
    {
      componentIds: [component.component.id],
      endsAt: now + 50 * 3_600_000,
      message: { en: "The database moves." },
      startsAt: now + 48 * 3_600_000,
      title: { en: "Database move" },
    },
    now
  );
  if (!(incident.ok && window.ok)) {
    throw new Error("the incident and the window could not be seeded");
  }
  seeded.incident = incident.incident.id;
  seeded.page = open.page.id;
  seeded.window = window.window.id;
}

let install: Install;

test.beforeAll(async () => {
  install = await spawnInstall({
    account: true,
    language: "en",
    records: seed,
  });
});

test.afterAll(async () => {
  await install.stop();
});

/** A policy that runs the inline scripts carrying its nonce. */
const noncedScripts = /script-src 'self' 'nonce-[^']+'/;

/** A document's own failing status, which the browser writes to the console as an error. */
const documentStatus =
  /^Failed to load resource: the server responded with a status of (403|404)/;

/** Every violation the page reports and every console error it writes, from now on, across its documents and frames. */
async function watched(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !documentStatus.test(message.text())) {
      seen.push(message.text());
    }
  });
  await page.exposeFunction("cspViolated", (line: string) => {
    seen.push(line);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.cspViolated?.(
        `${event.violatedDirective} blocked ${event.blockedURI} at ${event.documentURI}`
      );
    });
  });
  return seen;
}

/** Opens the path and asserts its document arrived under a policy naming a nonce. */
async function visit(page: Page, path: string): Promise<void> {
  const response = await page.goto(`${install.origin}${path}`);
  expect(response?.headers()["content-security-policy"], path).toMatch(
    noncedScripts
  );
}

test("a visitor's every page runs under the policy with no violation: the views, the incident and the window, a private page's password form, a not-found and the sign-in pages", async ({
  page,
}) => {
  const seen = await watched(page);
  for (const path of [
    "/",
    "/ar",
    "/history",
    `/incidents/${seeded.incident}`,
    `/maintenance/${seeded.window}`,
    "/status/locked",
    "/no-such-page",
    "/sign-in",
    "/sign-in?locale=ar",
    "/forgot-password",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one page after another, in one tab
    await visit(page, path);
  }
  expect(seen).toEqual([]);
});

test("every surface of a status page lets its custom CSS load from https, its not-found and a private page's password form included; the sign-in pages load from their own origin alone", async () => {
  const wide = async (path: string) =>
    (await fetch(`${install.origin}${path}`)).headers
      .get("content-security-policy")
      ?.includes("img-src 'self' https: data:");
  const pages = [
    "/",
    "/ar",
    "/history",
    `/incidents/${seeded.incident}`,
    `/maintenance/${seeded.window}`,
    "/status/locked",
    "/no-such-page",
  ];
  const operators = ["/sign-in", "/forgot-password", "/reset-password?token=t"];
  expect(await Promise.all([...pages, ...operators].map(wide))).toEqual([
    ...pages.map(() => true),
    ...operators.map(() => false),
  ]);
});

test("a status page's theme script and custom CSS still apply under the policy", async ({
  page,
}) => {
  const seen = await watched(page);
  await visit(page, "/");
  // The page's theme is dark; only its inline script writes that to the document.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("[data-slot=status-page]")).toHaveCSS(
    "outline-color",
    "rgb(1, 2, 3)"
  );
  expect(seen).toEqual([]);
});

test("the operator's every screen runs under the policy with no violation, the email preview's frame included", async ({
  page,
}) => {
  const seen = await watched(page);
  await visit(page, "/sign-in");
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
  for (const path of [
    "/admin/monitors/new",
    "/admin/components",
    "/admin/pages",
    `/admin/pages/${seeded.page}`,
    "/admin/incidents",
    `/admin/incidents/${seeded.incident}`,
    "/admin/maintenance",
    "/admin/reports",
    "/admin/audit",
    "/admin/team",
    "/admin/settings",
    "/admin/settings/appearance",
    "/admin/settings/account",
    "/admin/settings/sign-in",
    "/admin/settings/single-sign-on",
    "/admin/settings/setup-check",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one page after another, in one tab
    await visit(page, path);
  }
  await visit(page, "/admin/channels/new");
  await page.click("[role=radio][data-value=email]");
  const form = page.locator("[data-slot=channel-form]");
  await form.locator("input[name=name]").fill("Mail");
  await form.locator("input[name=from]").fill("raaqeb@example.com");
  await form.locator("input[name=to]").fill("team@example.com");
  await form.locator("input[name=host]").fill("127.0.0.1");
  await form.locator("select[name=security]").selectOption("none");
  await form.locator("input[name=port]").fill("2525");
  await form.locator("button[type=submit]").click();
  // A saved channel's page shows what it sends.
  await expect
    .poll(() => new URL(page.url()).pathname)
    .not.toBe("/admin/channels/new");
  // A preview's frame loads once its disclosure opens.
  await page.click("[data-slot=notification-preview] details summary >> nth=0");
  const preview = page.frameLocator("[data-slot=preview-email] >> nth=0");
  // The email's own style element, whose policy the frame inherits, still applies: tables collapse their borders by it alone.
  await expect(preview.locator("table").first()).toHaveCSS(
    "border-collapse",
    "collapse"
  );
  expect(seen).toEqual([]);
});

test("onboarding runs under the policy with no violation", async ({ page }) => {
  const fresh = await spawnInstall();
  try {
    const seen = await watched(page);
    for (const path of ["/onboarding/language", "/onboarding/database"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one page after another, in one tab
      const response = await page.goto(`${fresh.origin}${path}`);
      expect(response?.headers()["content-security-policy"], path).toMatch(
        noncedScripts
      );
    }
    expect(seen).toEqual([]);
  } finally {
    await fresh.stop();
  }
});

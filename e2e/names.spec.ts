// A name an operator wrote in the other script than the admin's: where a
// screen cuts it to fit, the cut falls at the name's end and its start stays
// in view. Each language on an install of its own, seeded with one long name
// on a monitor, a component and a status page.

import type { Locator, Page } from "@playwright/test";
import type { Storage } from "@/server/storage/storage.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { spawnInstall } from "./support/spawn.ts";

const names: Record<Locale, string> = {
  // An Arabic name, for the English admin.
  en: "بوابة توثيق العملاء لخدمات الدفع الإلكتروني في مجموعة الإنتاج الأوروبية",
  // An English name, for the Arabic admin.
  ar: "Customer Authentication Gateway Service for the European Production Cluster",
};

interface Seeded {
  componentId: string;
  monitorId: string;
  pageId: string;
}

async function seed(
  storage: Storage,
  language: Locale,
  into: Partial<Seeded>
): Promise<void> {
  const name = names[language];
  const monitor = await storage.monitors.create({
    channels: [],
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "off",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: "http://127.0.0.1:1/",
    },
    events: [...monitorEventKinds],
    group: undefined,
    intervalMs: 60_000,
    name,
    retries: 2,
    tags: [],
    timeoutMs: 10_000,
  });
  const component = await storage.components.create({
    description: undefined,
    monitorIds: [monitor.id],
    name: { [language]: name },
    status: "operational",
  });
  const fields = {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    locale: language,
    published: false,
    slug: "names",
    title: { [language]: name },
  };
  const page = await storage.pages.create(fields);
  await storage.pages.save(page.id, fields, [
    { componentId: component.id, kind: "component" },
  ]);
  into.monitorId = monitor.id;
  into.componentId = component.id;
  into.pageId = page.id;
}

/** Whether the name's element cuts it, and whether its first letter is inside the element's box; the element is the first in `scope`, itself included, that ends its text in an ellipsis. */
function cutAndStart(
  scope: Locator
): Promise<{ cut: boolean; startShows: boolean }> {
  return scope.evaluate((root) => {
    const element =
      [root, ...root.querySelectorAll("*")].find(
        (each) => getComputedStyle(each).textOverflow === "ellipsis"
      ) ?? root;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && (text.textContent ?? "").trim() === "") {
      text = walker.nextNode();
    }
    const first = document.createRange();
    if (text) {
      const content = text.textContent ?? "";
      const at = content.length - content.trimStart().length;
      first.setStart(text, at);
      first.setEnd(text, at + 1);
    }
    const letter = first.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      cut: element.scrollWidth > element.clientWidth,
      startShows:
        text !== null &&
        letter.left >= box.left - 1 &&
        letter.right <= box.right + 1,
    };
  });
}

async function expectStartShows(where: string, locator: Locator) {
  await expect(locator).toBeVisible();
  expect.soft(await cutAndStart(locator), where).toEqual({
    cut: true,
    startShows: true,
  });
}

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

const titles: Record<Locale, string> = {
  ar: "an English name in the Arabic admin",
  en: "an Arabic name in the English admin",
};

for (const language of ["ar", "en"] as const) {
  test(`${titles[language]} is cut at its end, its start in view, wherever a phone screen cuts it`, async ({
    page,
  }) => {
    const seeded: Partial<Seeded> = {};
    const install = await spawnInstall({
      account: true,
      language,
      records: (storage) => seed(storage, language, seeded),
    });
    try {
      const { componentId, monitorId, pageId } = seeded as Seeded;
      const { origin } = install;
      await page.setViewportSize({ height: 844, width: 390 });
      await signIn(page, origin);

      await expectStartShows(
        "the monitor list",
        page.locator(`[data-monitor="${monitorId}"] [data-slot=monitor-name]`)
      );

      await page.keyboard.press("Control+k");
      await page.keyboard.type("127.0.0.1");
      await expectStartShows(
        "the search palette",
        page.locator(`[data-palette-item="monitor:${monitorId}"]`)
      );
      await page.keyboard.press("Escape");

      await page.goto(`${origin}/admin/monitors/${monitorId}`);
      await expectStartShows(
        "the page title",
        page.locator("[data-slot=page] h1")
      );

      await page.goto(`${origin}/admin/monitors/${monitorId}/edit`);
      await expectStartShows(
        "the page title's parent",
        page.locator("[data-slot=page-parent]")
      );

      await page.goto(`${origin}/admin/components/${componentId}`);
      await expectStartShows(
        "a component's monitors",
        page.locator(
          `[data-slot=component-monitor][data-monitor="${monitorId}"] label`
        )
      );

      await page.goto(`${origin}/admin/incidents/new`);
      await expectStartShows(
        "an incident's components",
        page.locator(`li[data-component="${componentId}"] label`)
      );

      await page.goto(`${origin}/admin/maintenance/new`);
      await expectStartShows(
        "a maintenance window's components",
        page.locator(
          `[data-slot=window-component][data-component="${componentId}"] label`
        )
      );

      await page.goto(`${origin}/admin/pages/${pageId}`);
      await expectStartShows(
        "a status page's components",
        page.locator(`[data-slot=page-item][data-component="${componentId}"]`)
      );
    } finally {
      await install.stop();
    }
  });
}

// Export and import on the built entry: the English install's
// export downloaded from the settings page, refused by an install that is
// not empty, and imported into the empty install, whose monitors and
// default status page then are the English install's. Also the upload's
// session and origin checks, and one monitor's history download.

import type { Page } from "@playwright/test";
import { expect, expectPath, test } from "./support/fixtures.ts";
import {
  emptyOrigin,
  englishOrigin,
  operatorEmail,
  operatorPassword,
  publicPage,
} from "./support/servers.ts";

const waiting = /^(idle|importing)$/;
const rangeOfDay = /range=24h$/;
const historyFile = /^raaqeb-.+-24h\.jsonl\.zst$/;

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", operatorEmail);
  await page.fill("input[name=password]", operatorPassword);
  await page.click("form button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

/** Downloads the English install's full export through the settings page, and answers where it was saved. */
async function downloadExport(page: Page): Promise<string> {
  await signIn(page, englishOrigin);
  await page.goto(`${englishOrigin}/admin/settings/export`);
  await expect(page.locator("[data-slot=export-secrets]")).toBeVisible();
  await page.click("[data-slot=export-card] [role=radio][data-value=full]");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("[data-slot=export-download]"),
  ]);
  expect(download.suggestedFilename()).toBe("raaqeb-export.jsonl.zst");
  // Playwright deletes a download with its context; the later tests read this copy.
  const path = "test-results/export/raaqeb-export.jsonl.zst";
  await download.saveAs(path);
  return path;
}

async function upload(page: Page, origin: string, file: string) {
  await page.goto(`${origin}/admin/settings/export`);
  await page.setInputFiles("input[name=file]", file);
  await page.click("[data-slot=import-submit]");
  const answer = page.locator("[data-slot=import-answer]");
  await expect(answer).not.toHaveAttribute("data-state", waiting, {
    timeout: 60_000,
  });
  return answer;
}

let exported = "";

// In order: the later tests read the file the first downloads, and the last two the empty install the import fills.
test.describe("the full export, downloaded and then imported into the empty install", () => {
  test.describe.configure({ lock: "english-export", mode: "serial" });

  test("the settings page downloads the export as one zstd file of JSON Lines, the header first with the configuration", async ({
    page,
  }) => {
    exported = await downloadExport(page);
    const bytes = new Uint8Array(await Bun.file(exported).arrayBuffer());
    const lines = new TextDecoder()
      .decode(Bun.zstdDecompressSync(bytes))
      .split("\n")
      .filter((line) => line !== "");
    const header = JSON.parse(lines[0] ?? "{}");
    expect(header).toMatchObject({
      mode: "full",
      raaqeb: "export",
      version: 1,
    });
    expect(
      header.configuration.statusPages.map((row: { slug: string }) => row.slug)
    ).toContain(publicPage.slug);
    // The history follows, each record tagged with its kind and one of the configuration's monitors.
    const monitors = new Set(
      header.configuration.monitors.map((row: { id: string }) => row.id)
    );
    for (const line of lines.slice(1)) {
      const record = JSON.parse(line);
      expect(["check", "hourly", "daily", "outage"]).toContain(record.kind);
      expect(monitors.has(record.monitor)).toBe(true);
    }
  });

  test("the upload is refused without a session and from another site, and writes nothing", async ({
    page,
  }) => {
    const body = new Uint8Array(await Bun.file(exported).arrayBuffer());
    const signedOut = await page.request.post(`${emptyOrigin}/admin/import`, {
      data: Buffer.from(body),
      headers: { "content-type": "application/zstd", origin: emptyOrigin },
    });
    expect(signedOut.status()).toBe(401);
    await signIn(page, emptyOrigin);
    const crossSite = await page.request.post(`${emptyOrigin}/admin/import`, {
      data: Buffer.from(body),
      headers: {
        "content-type": "application/zstd",
        origin: "https://elsewhere.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(crossSite.status()).toBe(403);
    // The router matches a path whatever its case and a trailing slash, so the origin check must too.
    for (const path of ["/ADMIN/IMPORT", "/admin/import/", "/Admin/Import/"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request after another is plenty for a test
      const spelled = await page.request.post(`${emptyOrigin}${path}`, {
        data: Buffer.from(body),
        headers: {
          "content-type": "application/zstd",
          origin: "https://elsewhere.example",
          "sec-fetch-site": "cross-site",
        },
      });
      expect({ path, status: spelled.status() }).toEqual({ path, status: 403 });
    }
    // Submitting with no file chosen says so, and sends nothing.
    await page.goto(`${emptyOrigin}/admin/settings/export`);
    await page.click("[data-slot=import-submit]");
    await expect(page.locator("[data-slot=import-answer]")).toHaveAttribute(
      "data-state",
      "no_file"
    );
    // Still empty: the list shows its empty state, whose link leads to the import.
    await page.goto(`${emptyOrigin}/admin/monitors`);
    await expect(page.locator("[data-slot=empty]")).toBeVisible();
    await page.click("[data-slot=empty] a[href='/admin/settings/export']");
    await expectPath(page, "/admin/settings/export");
  });

  test("the empty install imports the file, then shows the English install's monitors and its default status page", async ({
    page,
  }) => {
    await signIn(page, emptyOrigin);
    const answer = await upload(page, emptyOrigin, exported);
    await expect(answer).toHaveAttribute("data-state", "ok");
    await page.goto(`${emptyOrigin}/admin/monitors`);
    await expect(
      page.locator("[data-monitor] [data-slot=monitor-name]", {
        hasText: "Nightly backup",
      })
    ).toBeVisible();
    await page.goto(`${emptyOrigin}/`);
    await expect(
      page.locator("[data-slot=status-page][data-page]")
    ).toContainText(publicPage.title);
  });

  test("an install that is no longer empty refuses a second import and says why", async ({
    page,
  }) => {
    await signIn(page, emptyOrigin);
    const answer = await upload(page, emptyOrigin, exported);
    await expect(answer).toHaveAttribute("data-state", "not_empty");
  });
});

// The install serves one export at a time, so this never overlaps the full download.
test("the export without the check history holds the configuration alone", {
  lock: "english-export",
}, async ({ page }) => {
  await signIn(page, englishOrigin);
  await page.goto(`${englishOrigin}/admin/settings/export`);
  await page.click(
    "[data-slot=export-card] [role=radio][data-value=configuration]"
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("[data-slot=export-download]"),
  ]);
  const file = Bun.file(await download.path());
  const lines = new TextDecoder()
    .decode(Bun.zstdDecompressSync(new Uint8Array(await file.arrayBuffer())))
    .split("\n")
    .filter((line) => line !== "");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
    mode: "configuration",
    raaqeb: "export",
  });
});

test("a damaged file and a file of another version are refused, each saying why, before the install is found not empty", async ({
  page,
}) => {
  const damaged = "test-results/export/damaged.jsonl.zst";
  await Bun.write(damaged, crypto.getRandomValues(new Uint8Array(2048)));
  const future = "test-results/export/future.jsonl.zst";
  await Bun.write(
    future,
    Bun.zstdCompressSync(
      new TextEncoder().encode(
        `${JSON.stringify({ raaqeb: "export", version: 999 })}\n`
      )
    )
  );
  // The English install has monitors, so an answer other than not_empty was decided first and wrote nothing.
  await signIn(page, englishOrigin);
  const invalid = await upload(page, englishOrigin, damaged);
  await expect(invalid).toHaveAttribute("data-state", "invalid");
  const version = await upload(page, englishOrigin, future);
  await expect(version).toHaveAttribute("data-state", "version");
});

test("a monitor's page downloads its history over the chart's range", async ({
  page,
}) => {
  await signIn(page, englishOrigin);
  await page
    .locator("[data-monitor] [data-slot=monitor-name]", { hasText: "Website" })
    .first()
    .click();
  const link = page.locator("[data-slot=history-download]");
  await expect(link).toHaveAttribute("href", rangeOfDay);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    link.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(historyFile);
});

// The reports area on an install of its own: a monitor paused after eight
// sealed days with one three-hour outage. A report is asked for through the
// form, read at its address, downloaded as CSV and printed; a range that is
// no range is refused in words.

import { type Cookie, type Page, request } from "@playwright/test";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { expect, expectPath, test } from "./support/fixtures.ts";
import { operatorEmail, operatorPassword } from "./support/servers.ts";
import { type Install, spawnInstall } from "./support/spawn.ts";

const hour = 3_600_000;
const day = 24 * hour;
/** The first of eight closed UTC days of history, ten days back. */
const start = Math.floor(Date.now() / day) * day - 10 * day;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const from = isoDay(start);
const to = isoDay(start + 7 * day);
const monitorName = "Reported site";

let install: Install | undefined;
let origin = "";
let session: Cookie[] = [];
let monitorId = "";

test.beforeAll(async () => {
  install = await spawnInstall({
    account: true,
    clock: () => start,
    records: async (storage) => {
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
        intervalMs: hour,
        name: monitorName,
        retries: 0,
        tags: [],
        timeoutMs: 10_000,
      });
      monitorId = monitor.id;
      for (let at = start; at < start + 8 * day; at += hour) {
        const down =
          at >= start + 3 * day + 2 * hour && at < start + 3 * day + 5 * hour;
        // biome-ignore lint/performance/noAwaitInLoops: one write a check, as the scheduler makes them
        await storage.checks.record({
          capture: undefined,
          check: {
            attempts: 1,
            bytes: 10,
            monitorId: monitor.id,
            reason: down ? reasons.timeout : reasons.ok,
            responseMs: down ? undefined : 100,
            result: down ? "down" : "up",
            startedAt: at,
            statusCode: down ? undefined : 200,
          },
          detail: undefined,
        });
      }
      for (let at = start; at < start + 8 * day; at += day) {
        // biome-ignore lint/performance/noAwaitInLoops: each day is sealed after the one before, as the nightly job does
        await storage.checks.seal(monitor.id, at, 2 * hour, []);
      }
      await storage.outages.open(
        monitor.id,
        start + 3 * day + 2 * hour,
        reasons.timeout
      );
      await storage.outages.acknowledge(
        monitor.id,
        start + 3 * day + 2 * hour,
        start + 3 * day + 2 * hour + 10 * 60_000
      );
      await storage.outages.close(monitor.id, start + 3 * day + 5 * hour);
      await storage.monitors.pause([monitor.id]);
    },
  });
  ({ origin } = install);
  const api = await request.newContext();
  const signedIn = await api.post(`${origin}/api/auth/sign-in/email`, {
    data: { email: operatorEmail, password: operatorPassword },
    headers: { origin },
  });
  expect(signedIn.status()).toBe(200);
  session = (await api.storageState()).cookies;
  await api.dispose();
});

test.afterAll(async () => {
  await install?.stop();
});

async function open(page: Page, search: string): Promise<void> {
  await page.context().addCookies(session);
  await page.goto(`${origin}/admin/reports${search}`);
  await expectPath(page, "/admin/reports");
}

const asked = () =>
  `?subject=monitor&id=${monitorId}&from=${from}&to=${to}&target=99.9`;

test("the form asks for a report of a custom range, which then states its uptime against the target, its downtime, its outage and the target missed", async ({
  page,
}) => {
  await open(page, "");
  await expect(page.locator("[data-slot=report]")).toHaveCount(0);
  await page.selectOption("select[name=id]", monitorId);
  await page.click("[data-name=period] [data-value=custom]");
  await page.fill("input[name=from-date]", from);
  await page.fill("input[name=to-date]", to);
  await page.click("[data-slot=generate-report]");
  await expect(page.locator("[data-slot=report]")).toBeVisible();
  // 189 hours of 192 observed, cut down to two places.
  await expect(page.locator("[data-slot=report-uptime-value]")).toContainText(
    "98.43"
  );
  await expect(page.locator("[data-slot=figure-downtime] dd")).toContainText(
    "180"
  );
  await expect(page.locator("[data-slot=figure-outages] dd")).toHaveText("1");
  await expect(page.locator("[data-slot=report-met]")).toHaveAttribute(
    "data-met",
    "false"
  );
  await expect(
    page.locator("[data-slot=report-worst] [data-outage]")
  ).toHaveCount(1);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("id"))
    .toBe(monitorId);
});

test("a report at its address downloads as a CSV the spreadsheet reads: a byte order mark, the monitor's line and its outage", async ({
  page,
}) => {
  await open(page, asked());
  await expect(page.locator("[data-slot=report-uptime-value]")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("[data-slot=download-report]"),
  ]);
  expect(download.suggestedFilename()).toBe(
    `raaqeb-report-monitor-${from}-${to}.csv`
  );
  const path = "test-results/reports/report.csv";
  await download.saveAs(path);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  // The three bytes of the byte order mark, which a text read would drop.
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = new TextDecoder().decode(bytes.slice(3)).split("\r\n");
  const cells = lines[1]?.split(",") ?? [];
  expect(cells[1]).toBe(monitorName);
  expect(cells.slice(2, 6)).toEqual([from, to, "99.9", "98.43"]);
  // Downtime and observed time in minutes, then the outage count.
  expect(cells[7]).toBe("180");
  expect(cells[8]).toBe("11520");
  expect(cells[15]).toBe("1");
  expect(
    lines.some((line) => line.includes(monitorName) && line.includes(".000Z"))
  ).toBe(true);
});

test("printed, a report is the report alone: no sidebar, no form, no buttons", async ({
  page,
}) => {
  await open(page, asked());
  await expect(page.locator("[data-slot=report]")).toBeVisible();
  await expect(page.locator("[data-slot=report-form]")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("[data-slot=report-form]")).toBeHidden();
  await expect(page.locator("[data-slot=download-report]")).toBeHidden();
  await expect(page.locator("[data-slot=sidebar]")).toBeHidden();
  await expect(page.locator("[data-slot=report]")).toBeVisible();
});

test("a range that ends before it starts is refused in words and makes no report", async ({
  page,
}) => {
  await open(
    page,
    `?subject=monitor&id=${monitorId}&from=${to}&to=${from}&target=99.9`
  );
  await expect(page.locator("[data-slot=report-refused]")).toBeVisible();
  await expect(page.locator("[data-slot=report]")).toHaveCount(0);
});

test("without a session the CSV redirects to sign-in and serves no report", async () => {
  const anonymous = await request.newContext();
  const csv = await anonymous.get(
    `${origin}/admin/reports/report.csv${asked()}`,
    { maxRedirects: 0 }
  );
  expect([303, 307]).toContain(csv.status());
  expect(csv.headers().location).toContain("/sign-in");
  expect(await csv.text()).not.toContain(monitorName);
  await anonymous.dispose();
});

test("the page's read of a report, asked again with no session, serves no report", async ({
  page,
}) => {
  // The address the signed-in page reads its report from when the form asks.
  await open(page, "");
  const reading = page.waitForRequest(
    (each) =>
      each.url().includes("/_serverFn/") && each.url().includes(monitorId)
  );
  await page.selectOption("select[name=id]", monitorId);
  await page.click("[data-slot=generate-report]");
  const read = await reading;
  await expect(page.locator("[data-slot=report]")).toBeVisible();
  const anonymous = await request.newContext();
  // The page's own headers without its cookie, which Playwright leaves out of them only while no route is installed.
  const replay = await anonymous.get(read.url(), {
    headers: Object.fromEntries(
      Object.entries(await read.allHeaders()).filter(
        ([name]) => name !== "cookie"
      )
    ),
    maxRedirects: 0,
  });
  const body = await replay.text();
  expect(body).not.toContain(monitorName);
  expect(body).toContain("/sign-in");
  expect(body).not.toContain('"ok":true');
  await anonymous.dispose();
});

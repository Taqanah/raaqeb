import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "@playwright/test";
import { capture } from "./shots.ts";

let browser: Browser;
const server = Bun.serve({
  fetch: (request) =>
    new URL(request.url).pathname === "/here"
      ? new Response("<p>here</p>", {
          headers: { "content-type": "text/html" },
        })
      : new Response("gone", { status: 404 }),
  hostname: "127.0.0.1",
  port: 0,
});
const origin = `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  server.stop(true);
});

test("a path that answers 200 is shot", async () => {
  const page = await browser.newPage();
  expect((await capture(page, origin, "/here")).length).toBeGreaterThan(0);
});

test("a path that does not answer 200 is refused by name, never shot", async () => {
  const page = await browser.newPage();
  await expect(capture(page, origin, "/nope")).rejects.toThrow(
    "/nope answered 404"
  );
});

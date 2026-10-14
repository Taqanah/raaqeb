// A custom createStart() drops Start's default CSRF middleware; src/start.ts
// re-adds createCsrfMiddleware for server functions.
// Remove that line and the three refusals below go green for the attacker.
//
// Behaviour of createCsrfMiddleware in the installed @tanstack/start-client-core:
// Sec-Fetch-Site decides when present, else Origin is compared with the request
// origin, else Referer, and with none of the three the request fails closed.

import { expect, test } from "./support/fixtures.ts";

test("a server function call forged from another site is refused before the handler; the same-origin call reaches it", async ({
  context,
  page,
}) => {
  // Capture a genuine server function request from a real browser click, so
  // the replays pin the middleware and not the URL scheme of Start internals.
  // The Arabic server stays in onboarding: the database screen's connection
  // test is a server function a click submits.
  await page.goto("/onboarding/database");
  await page.click(
    "[role=radiogroup][data-name=backend] [role=radio][data-value=postgres]"
  );
  await page.fill("input[name=url]", "postgres://u:p@127.0.0.1:1/raaqeb");
  const [captured] = await Promise.all([
    page.waitForRequest((request) => request.url().includes("/_serverFn/")),
    page.click("button[name=test]"),
  ]);
  await expect(page.locator("[data-verdict=unreachable]")).toHaveCount(1);

  const url = captured.url();
  const body = captured.postData() ?? "";
  const headers = await captured.allHeaders();
  // The protocol headers the server function resolver needs, taken from the
  // real request so a replay fails only on the origin check. A call with no
  // payload carries no body and no content-type.
  const protocol: Record<string, string> = { "x-tsr-serverfn": "true" };
  for (const name of ["accept", "content-type"]) {
    const value = headers[name];
    if (value !== undefined) {
      protocol[name] = value;
    }
  }

  const crossOrigin = await context.request.post(url, {
    data: body,
    headers: { ...protocol, origin: "https://evil.example" },
  });
  expect(crossOrigin.status()).toBe(403);

  const noSignal = await context.request.post(url, {
    data: body,
    headers: protocol,
  });
  expect(noSignal.status()).toBe(403);

  const crossSite = await context.request.post(url, {
    data: body,
    headers: { ...protocol, "sec-fetch-site": "cross-site" },
  });
  expect(crossSite.status()).toBe(403);

  // The control: the same request with a same-origin Origin reaches the
  // handler, which proves the three refusals above are the CSRF layer.
  const sameOrigin = await context.request.post(url, {
    data: body,
    headers: { ...protocol, origin: new URL(url).origin },
  });
  expect(sameOrigin.status()).toBe(200);
  expect(await sameOrigin.text()).toContain("unreachable");

  // A payload that is not JSON is refused with a plain 400 before Start parses it.
  const malformed = await context.request.post(url, {
    data: Buffer.from("{bad"),
    headers: { ...protocol, origin: new URL(url).origin },
  });
  expect(malformed.status()).toBe(400);
});

// Vite resolves the server bundle under Node-first conditions unless told
// otherwise, and srvx's Node Response shim is an object Bun.serve refuses,
// so a throw that escapes Start's handler reached the client as Bun's empty
// fallback. A same-origin call to a server function that does not exist is
// such a throw.
test("an error that escapes Start's handler answers 500, not Bun's empty fallback", async ({
  request,
}) => {
  const response = await request.post("/_serverFn/not-a-registered-id", {
    data: {},
    headers: { "sec-fetch-site": "same-origin", "x-tsr-serverfn": "true" },
  });
  expect(response.status()).toBe(500);
});

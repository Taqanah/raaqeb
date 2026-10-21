import { expect, test } from "./support/fixtures.ts";
import { arabicOrigin, englishOrigin } from "./support/servers.ts";

test("GET /health answers 200 with the database and the scheduler ok on an install", async ({
  request,
}) => {
  const response = await request.get(`${englishOrigin}/health`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toEqual({
    database: "ok",
    ok: true,
    scheduler: "ok",
  });
});

test("during onboarding GET /health answers 200 and says so", async ({
  request,
}) => {
  const response = await request.get(`${arabicOrigin}/health`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true, onboarding: true });
});

test("a method /health does not declare answers 405 with its Allow and an empty body, never the app shell", async ({
  request,
}) => {
  for (const origin of [englishOrigin, arabicOrigin]) {
    // biome-ignore lint/performance/noAwaitInLoops: one install after the other
    const response = await request.post(`${origin}/health`);
    expect(response.status()).toBe(405);
    expect(response.headers().allow).toBe("GET, HEAD");
    expect((await response.body()).length).toBe(0);
  }
});

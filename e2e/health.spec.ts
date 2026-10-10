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

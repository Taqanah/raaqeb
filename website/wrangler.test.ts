import { expect, test } from "bun:test";
import { z } from "zod";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const configShape = z.object({
  assets: z.object({ directory: z.string(), not_found_handling: z.string() }),
  compatibility_date: z.string(),
  name: z.string(),
  routes: z.array(
    z.object({ custom_domain: z.boolean(), pattern: z.string() })
  ),
});

const config = configShape.parse(
  Bun.JSONC.parse(await Bun.file(`${import.meta.dir}/wrangler.jsonc`).text())
);

test("the Worker serves the folder the website build writes, which is where the Vite config puts the client", async () => {
  const vite = await Bun.file(`${import.meta.dir}/vite.config.ts`).text();
  expect(vite).toContain("build: { outDir:");
  expect(vite).toContain("/dist`");
  expect(config.assets.directory).toBe("./dist/client");
});

test("raaqeb.dev is a custom domain of the Worker, which has no script of its own", () => {
  expect(config.routes).toEqual([
    { custom_domain: true, pattern: "raaqeb.dev" },
  ]);
  expect(config).not.toHaveProperty("main");
});

test("the compatibility date is a past or present day", () => {
  expect(config.compatibility_date).toMatch(isoDate);
  expect(Date.parse(config.compatibility_date)).toBeLessThanOrEqual(Date.now());
});

test("an unknown address gets the not-found page in its language, which the build writes where the host looks for it", async () => {
  const vite = await Bun.file(`${import.meta.dir}/vite.config.ts`).text();
  expect(config.assets.not_found_handling).toBe("404-page");
  expect(vite).toContain('outputPath: "/404.html"');
  expect(vite).toContain('outputPath: "/en/404.html"');
});

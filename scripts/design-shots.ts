/**
 * Screenshots of the design sample page for review: both locales, both
 * themes, three appearance scale sets. Starts the Vite dev server on its own
 * port, drives Playwright's Chromium, and writes PNGs to `outDir`. Usage: bun
 * run design:shots
 */
import { chromium, type Page } from "@playwright/test";

const port = 3420;
const origin = `http://127.0.0.1:${port}`;
const outDir = `${import.meta.dir}/../.design-shots`;

const scales = [
  {
    density: "comfortable",
    fontSize: "medium",
    name: "medium",
    radius: "medium",
  },
  { density: "compact", fontSize: "small", name: "small", radius: "none" },
  { density: "spacious", fontSize: "large", name: "large", radius: "large" },
] as const;

const locales = ["ar", "en"] as const;
const themes = ["light", "dark"] as const;

interface Shot {
  readonly locale: (typeof locales)[number];
  readonly scale: (typeof scales)[number];
  readonly theme: (typeof themes)[number];
}

async function capture(
  page: Page,
  { locale, scale, theme }: Shot
): Promise<void> {
  await page.goto(`${origin}/design?locale=${locale}`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(
    ([t, s]) => {
      const root = document.documentElement;
      root.setAttribute("data-theme", t);
      root.setAttribute("data-font-size", s.fontSize);
      root.setAttribute("data-density", s.density);
      root.setAttribute("data-radius", s.radius);
      return document.fonts.ready;
    },
    [theme, scale] as const
  );
  // Colours and sizes transition for up to 200 ms after the attributes change.
  await page.waitForTimeout(400);
  const file = `${outDir}/${locale}-${theme}-${scale.name}.png`;
  await page.screenshot({ fullPage: true, path: file });
  process.stdout.write(`wrote ${file}\n`);
}

async function waitFor(url: string, deadline: number): Promise<void> {
  if (Date.now() >= deadline) {
    throw new Error("the dev server did not answer in time");
  }
  const up = await fetch(url).then(
    (response) => response.ok,
    () => false
  );
  if (!up) {
    await Bun.sleep(500);
    return waitFor(url, deadline);
  }
}

const dev = Bun.spawn(
  [
    "bunx",
    "vite",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: `${import.meta.dir}/..`, stderr: "inherit", stdout: "ignore" }
);
try {
  await waitFor(`${origin}/design`, Date.now() + 60_000);
  await Bun.$`mkdir -p ${outDir}`.quiet();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { height: 900, width: 1280 },
  });
  const shots = locales.flatMap((locale) =>
    themes.flatMap((theme) => scales.map((scale) => ({ locale, scale, theme })))
  );
  // One page, one shot after another, so the chain is sequential by design.
  await shots.reduce(
    (chain, shot) => chain.then(() => capture(page, shot)),
    Promise.resolve()
  );
  await browser.close();
} finally {
  dev.kill();
}

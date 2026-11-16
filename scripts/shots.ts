/**
 * Screenshots for a before and after: builds the checkout, serves it seeded
 * as serve:seeded does, signs in, and writes one image per path with the
 * desktop view beside the phone view.
 *
 *   bun run shots <dir> <path>...          this checkout
 *   bun run shots <dir> --main <path>...   main, built in a temporary worktree
 *
 * --main shoots origin/main when the clone has it, else the local main. A
 * path that does not answer 200 stops the run with its name and exit 1.
 *
 * An operator path (/admin, /sign-in and the account pages) is shot in each
 * locale, as <dir>/<name>.ar.png and <name>.en.png. A status page path is shot
 * once, in its page language, as <dir>/<name>.png: the seeded pages are
 * English, so /ar/... is their Arabic view.
 */
import { chromium, type Page } from "@playwright/test";
import { locales } from "@/shared/i18n/locale.ts";
import { operatorEmail, operatorPassword } from "../e2e/support/servers.ts";
import { waitForOrigin } from "../e2e/support/wait.ts";
import { build, root, seed, setInstallLanguage } from "./serve-seeded.ts";

const usage = "usage: bun run shots <dir> [--main] <path>...";
const operatorPath =
  /^\/(admin|sign-in|forgot-password|reset-password|invitation)(\/|\?|$)/;
const desktop = { height: 800, width: 1280 };
const phone = { height: 844, width: 390 };

/** A path that did not answer 200: the run stops rather than shoot an error page. */
class PathRefused extends Error {}

/** Stops what a killed run would leave behind: the server, the temporary worktree. */
const cleanups = new Set<() => void>();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    process.exit(2);
  });
}

/** Runs this script from main's own checkout, so main's build is shot over main's own seed. */
async function shootMain(
  outDir: string,
  paths: readonly string[]
): Promise<number> {
  const remote =
    await Bun.$`git -C ${root} rev-parse --verify --quiet origin/main`
      .quiet()
      .nothrow();
  const main = remote.exitCode === 0 ? "origin/main" : "main";
  const tree = (await Bun.$`mktemp -d`.text()).trim();
  await Bun.$`git -C ${root} worktree add --detach ${tree} ${main}`.quiet();
  const remove = () => {
    Bun.spawnSync(["git", "-C", root, "worktree", "remove", "--force", tree]);
  };
  cleanups.add(remove);
  try {
    if (!(await Bun.file(`${tree}/scripts/shots.ts`).exists())) {
      process.stderr.write(
        "main has no scripts/shots.ts yet: shoot main by hand\n"
      );
      return 1;
    }
    await Bun.$`bun install --frozen-lockfile`.cwd(tree).quiet();
    const sha = (
      await Bun.$`git -C ${tree} rev-parse --short HEAD`.text()
    ).trim();
    process.stdout.write(`${main} at ${sha}\n`);
    const run = Bun.spawn(["bun", "scripts/shots.ts", outDir, ...paths], {
      cwd: tree,
      stderr: "inherit",
      stdout: "inherit",
    });
    return await run.exited;
  } finally {
    cleanups.delete(remove);
    remove();
  }
}

/** A file name for the path: `/admin/monitors` is `admin-monitors`, `/` is `root`. */
function nameOf(path: string): string {
  return path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

/** The page at the path, whole; refuses a path that does not answer 200, after its redirects. */
export async function capture(
  page: Page,
  origin: string,
  path: string
): Promise<Buffer> {
  const response = await page.goto(`${origin}${path}`, {
    waitUntil: "networkidle",
  });
  const status = response?.status() ?? 200;
  if (status !== 200) {
    throw new PathRefused(`${path} answered ${status}`);
  }
  await page.evaluate(() => document.fonts.ready);
  // Colours and sizes transition for up to 200 ms after the first paint.
  await page.waitForTimeout(400);
  return page.screenshot({ fullPage: true });
}

/** Builds and seeds this checkout and writes the sheets. */
async function shoot(outDir: string, paths: readonly string[]): Promise<void> {
  await build();
  const dataDir = `${root}/data/shots`;
  await seed(dataDir, "ar");
  await Bun.$`mkdir -p ${outDir}`.quiet();
  const browser = await chromium.launch();
  const sheet = await browser.newPage({
    viewport: { height: 600, width: desktop.width + phone.width + 72 },
  });
  try {
    for (const locale of locales) {
      // biome-ignore lint/performance/noAwaitInLoops: one server per locale, one after the other
      await setInstallLanguage(dataDir, locale);
      const probe = Bun.serve({ fetch: () => new Response(""), port: 0 });
      const port = String(probe.port);
      probe.stop(true);
      const origin = `http://127.0.0.1:${port}`;
      const server = Bun.spawn(
        [
          "bun",
          "dist/server/server.js",
          "--port",
          port,
          "--host",
          "127.0.0.1",
          "--data-dir",
          dataDir,
        ],
        { cwd: root, stderr: "ignore", stdout: "ignore" }
      );
      const stopServer = () => server.kill();
      cleanups.add(stopServer);
      try {
        await waitForOrigin(`${origin}/health`, Date.now() + 30_000);
        const wide = await browser.newContext({ viewport: desktop });
        const signIn = await wide.newPage();
        await signIn.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
        await signIn.fill("input[name=email]", operatorEmail);
        await signIn.fill("input[name=password]", operatorPassword);
        await signIn.click("form button[type=submit]");
        await signIn.waitForURL(`${origin}/admin/**`);
        const narrow = await browser.newContext({
          hasTouch: true,
          isMobile: true,
          storageState: await wide.storageState(),
          viewport: phone,
        });
        // Status pages do not follow the install language, so they are shot in the first locale only.
        const here = paths.filter(
          (path) => operatorPath.test(path) || locale === locales[0]
        );
        for (const path of here) {
          // Both at once, so a monitor's state cannot change between the two halves.
          // biome-ignore lint/performance/noAwaitInLoops: one sheet page, one path after the other
          const [left, right] = await Promise.all([
            wide.newPage().then((page) => capture(page, origin, path)),
            narrow.newPage().then((page) => capture(page, origin, path)),
          ]);
          await sheet.setContent(
            `<body style="margin:0;padding:24px;display:flex;gap:24px;align-items:start;background:gray"><img src="data:image/png;base64,${left.toString("base64")}"><img src="data:image/png;base64,${right.toString("base64")}"></body>`
          );
          const file = `${outDir}/${nameOf(path)}${operatorPath.test(path) ? `.${locale}` : ""}.png`;
          await sheet.screenshot({ fullPage: true, path: file });
          process.stdout.write(`${file}\n`);
        }
        await wide.close();
        await narrow.close();
      } finally {
        cleanups.delete(stopServer);
        server.kill();
        await server.exited;
      }
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const onMain = args.includes("--main");
  const [dirArg, ...paths] = args.filter((arg) => arg !== "--main");
  if (
    !dirArg ||
    paths.length === 0 ||
    paths.some((path) => !path.startsWith("/"))
  ) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  const outDir = dirArg.startsWith("/") ? dirArg : `${process.cwd()}/${dirArg}`;
  try {
    if (onMain) {
      process.exit(await shootMain(outDir, paths));
    }
    await shoot(outDir, paths);
  } catch (error) {
    if (!(error instanceof PathRefused)) {
      throw error;
    }
    process.stderr.write(`${error.message}; nothing more was shot\n`);
    process.exit(1);
  }
}

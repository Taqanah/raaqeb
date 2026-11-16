/**
 * Builds this checkout and serves it on an install to look at in a browser,
 * in the foreground until Ctrl-C.
 *
 *   bun run serve:seeded           seeded: the e2e English install's account,
 *                                  monitors, status pages, incidents, windows
 *                                  and subscribers, in Arabic, the default look
 *   bun run serve:seeded --fresh   an empty data directory, in onboarding
 *
 * The port comes from the checkout's path, 4300 to 4799, so each checkout
 * keeps its own across restarts; RAAQEB_PORT overrides it. The data
 * directory is data/seeded, wiped at every start.
 */
import { installLanguage } from "@/server/settings/language.ts";
import { openStorage } from "@/server/storage/storage.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { buildDir, builtMain } from "../e2e/support/built.ts";
import { seedExampleInstall } from "../e2e/support/serve-en.ts";
import { operatorEmail, operatorPassword } from "../e2e/support/servers.ts";

export const root = `${import.meta.dir}/..`;
export const credentials = `${operatorEmail}  ${operatorPassword}`;

/** Builds this checkout into dist/, quietly unless it fails. */
export async function build(): Promise<void> {
  const built = await Bun.$`bun run build`.cwd(root).quiet().nothrow();
  if (built.exitCode !== 0) {
    process.stderr.write(
      `${built.stderr.toString().slice(-3000)}\nthe build failed: run bun run build to see it whole\n`
    );
    process.exit(1);
  }
}

/** Sets the install language, which the admin and sign-in follow for an operator who chose none. */
export async function setInstallLanguage(
  dataDir: string,
  locale: Locale
): Promise<void> {
  const opened = await openStorage({
    backend: "sqlite",
    file: `${dataDir}/raaqeb.sqlite`,
  });
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  await opened.storage.settings.set(installLanguage, locale);
  await opened.storage.close();
}

/** The seeded install with the install language given; its content is in English, which it was written in. */
export async function seed(dataDir: string, locale: Locale): Promise<void> {
  await seedExampleInstall(dataDir);
  await setInstallLanguage(dataDir, locale);
}

if (import.meta.main) {
  const fresh = Bun.argv.includes("--fresh");
  const port = Number(
    Bun.env.RAAQEB_PORT ?? 4300 + Number(BigInt(Bun.hash(root)) % 500n)
  );
  const dataDir = `${root}/data/seeded`;
  const origin = `http://127.0.0.1:${port}`;
  // Free before the build, so a server left running says so at once.
  try {
    Bun.serve({
      fetch: () => new Response(""),
      hostname: "127.0.0.1",
      port,
    }).stop(true);
  } catch {
    process.stderr.write(
      `port ${port} is in use, likely an earlier serve:seeded of this checkout: stop it, or set RAAQEB_PORT\n`
    );
    process.exit(1);
  }
  await build();
  if (fresh) {
    await Bun.$`rm -rf ${dataDir} && mkdir -p ${dataDir}`.quiet();
  } else {
    await seed(dataDir, "ar");
  }
  process.stdout.write(
    fresh
      ? `${origin}  onboarding, data in data/seeded\n`
      : `${origin}/sign-in  ${credentials}\n${origin}/  the default status page (English; /ar in Arabic), another at /status/notices\n`
  );
  const main = await builtMain();
  const running = await main(
    ["--port", String(port), "--host", "127.0.0.1", "--data-dir", dataDir],
    {},
    buildDir
  );
  if (typeof running === "number") {
    process.exit(running);
  }
}

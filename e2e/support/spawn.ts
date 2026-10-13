/**
 * An install of a test's own: the built server on a free port with a data
 * directory nothing else reads, for a spec that changes what the shared
 * servers must keep (the install language, the account, an email channel)
 * or reads the server's standard error. Not product code.
 */
import { authFor, operatorName } from "@/server/auth/auth.ts";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { installLanguage } from "@/server/settings/language.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { operatorEmail, operatorPassword } from "./servers.ts";
import { waitForOrigin } from "./wait.ts";

/** What the install starts with; nothing seeded leaves it in onboarding. */
export interface InstallSeed {
  /** The operator account with the English install's credentials (`operatorEmail`, `operatorPassword`) and the public address at the install's origin, both as onboarding's account screen stores them. */
  readonly account?: boolean;
  /** The install language; unset, the install keeps Arabic, its default. */
  readonly language?: Locale;
  /** False starts the server without `--trusted-proxies`, so the settings page may edit them; every sign-in then spends the one budget of 127.0.0.1. */
  readonly proxyFlag?: boolean;
  /** Writes the spec's own records, such as a monitor and its checks, before the server starts. */
  readonly records?: (storage: Storage) => Promise<void>;
}

/** A running install: its origin, and `stop`, which kills the server by its PID, removes its data directory and answers what the server wrote to standard error, a line each. */
export interface Install {
  readonly origin: string;
  readonly stop: () => Promise<string[]>;
}

/** A port nothing listens on now. */
function freePort(): number {
  const probe = Bun.serve({ fetch: () => new Response(""), port: 0 });
  const { port } = probe;
  probe.stop(true);
  return port ?? 0;
}

async function seed(
  dataDir: string,
  origin: string,
  what: InstallSeed
): Promise<void> {
  const opened = await openStorage({
    backend: "sqlite",
    file: `${dataDir}/raaqeb.sqlite`,
  });
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  try {
    if (what.language) {
      await opened.storage.settings.set(installLanguage, what.language);
    }
    if (what.account) {
      // Reset links and subscriber mail carry this origin; without it they carry bare paths.
      await opened.storage.settings.set(publicAddress, origin);
      const auth = await authFor(opened.storage, {
        betterAuthSecrets: undefined,
        installKey: await scratchInstallKey(),
      });
      await auth.api.signUpEmail({
        body: {
          email: operatorEmail,
          name: operatorName,
          password: operatorPassword,
        },
      });
    }
    await what.records?.(opened.storage);
  } finally {
    await opened.storage.close();
  }
}

/**
 * Starts the built server (`dist/`, which the Arabic e2e server's build
 * writes) on an install of its own, seeded as asked, and resolves once it
 * answers. The peer is 127.0.0.1, a trusted proxy here as on the English
 * server, so each test's `x-forwarded-for` keys its own sign-in limit.
 * Call `stop` in a `finally` or an `afterAll`.
 */
export async function spawnInstall(what: InstallSeed = {}): Promise<Install> {
  const port = freePort();
  const dataDir = `test-results/spawn-${port}`;
  const origin = `http://127.0.0.1:${port}`;
  await Bun.$`rm -rf ${dataDir} && mkdir -p ${dataDir}`.quiet();
  if (what.account || what.language || what.records) {
    await seed(dataDir, origin, what);
  }
  const server = Bun.spawn(
    [
      "bun",
      "dist/server/server.js",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--data-dir",
      dataDir,
      ...(what.proxyFlag === false ? [] : ["--trusted-proxies", "127.0.0.1"]),
    ],
    { stderr: "pipe", stdout: "ignore" }
  );
  // Read from the start, so a full pipe never blocks the server.
  const stderr = new Response(server.stderr).text();
  await waitForOrigin(`${origin}/health`, Date.now() + 30_000);
  return {
    origin,
    stop: async () => {
      server.kill();
      await server.exited;
      await Bun.$`rm -rf ${dataDir}`.quiet();
      return (await stderr).split("\n").filter((line) => line !== "");
    },
  };
}

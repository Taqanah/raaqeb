/**
 * The fifth e2e server: an install past onboarding with its operator
 * account and nothing else, the empty install an import needs. The export
 * spec imports the English install into it. Waits for the Arabic server,
 * which runs the build, then seeds its data directory and serves the build.
 */
import { authFor, operatorName } from "@/server/auth/auth.ts";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { releaseCheckEnabled } from "@/server/release/release.ts";
import { openStorage } from "@/server/storage/storage.ts";
import { buildDir, builtMain } from "./built.ts";
import { operatorEmail, operatorPassword } from "./servers.ts";
import { waitForOrigin } from "./wait.ts";

const [, , arabicOrigin, port, dataDir] = Bun.argv;
if (!(arabicOrigin && port && dataDir)) {
  process.stderr.write(
    "usage: bun e2e/support/serve-empty.ts <arabic origin> <port> <data dir>\n"
  );
  process.exit(2);
}

await waitForOrigin(arabicOrigin, Date.now() + 120_000);
await Bun.$`rm -rf ${dataDir}`.quiet();
await Bun.$`mkdir -p ${dataDir}`.quiet();
const opened = await openStorage({
  backend: "sqlite",
  file: `${dataDir}/raaqeb.sqlite`,
});
if (!opened.ok) {
  process.stderr.write(`${opened.message}\n`);
  process.exit(1);
}
// The daily release check would ask api.github.com; the run sends nothing off the machine.
await opened.storage.settings.set(releaseCheckEnabled, false);
// The operator account, created the way onboarding does, with the English install's credentials.
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
await opened.storage.close();

// The peer is always 127.0.0.1, so it is a trusted proxy here, as on the English server.
const main = await builtMain();
const running = await main(
  ["--port", port, "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
  {},
  buildDir
);
if (typeof running === "number") {
  process.exit(running);
}

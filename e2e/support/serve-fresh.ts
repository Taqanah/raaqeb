/**
 * The third e2e server: a fresh install with an empty data directory, which
 * the onboarding spec walks from the language screen to the empty monitors
 * list. Waits for the Arabic server, which runs the build, then serves it.
 */

import { buildDir, builtMain } from "./built.ts";
import { waitForOrigin } from "./wait.ts";

const [, , arabicOrigin, port, dataDir] = Bun.argv;
if (!(arabicOrigin && port && dataDir)) {
  process.stderr.write(
    "usage: bun e2e/support/serve-fresh.ts <arabic origin> <port> <data dir>\n"
  );
  process.exit(2);
}

await waitForOrigin(arabicOrigin, Date.now() + 120_000);
await Bun.$`rm -rf ${dataDir}`.quiet();
// The walk ends in the admin, whose first request runs the daily release check against api.github.com. A database file would skip onboarding's database step, so the switch cannot be seeded; a proxy nothing listens on keeps the request on the machine, and the sink and the servers on 127.0.0.1 stay direct.
process.env.HTTPS_PROXY = "http://127.0.0.1:9";
process.env.NO_PROXY = "127.0.0.1";

// The peer is always 127.0.0.1, so it is a trusted proxy here, as on the
// English server: the recovery walk signs in more often than Better Auth's
// sign-in limit allows one address, and gives each sign-in its own.
const main = await builtMain();
const running = await main(
  ["--port", port, "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
  {},
  buildDir
);
if (typeof running === "number") {
  process.exit(running);
}

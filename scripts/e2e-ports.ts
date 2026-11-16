/**
 * The first of the five ports the e2e run's servers take (e2e/support/servers.ts):
 * 3210 in a repository's main checkout, and five of its own in each linked
 * worktree, from 10000 to 26999: below the compose MongoDB's 27017 and the
 * kernel's ephemeral range, so worktrees run the suite side by side and a
 * rerun takes the same ports. Two worktrees can still draw the same five;
 * `RAAQEB_E2E_PORT` moves one. `bun run e2e` runs this file first, which
 * stops at once when one of the five is taken.
 */
export function firstPort(gitDir: string, commonDir: string): number {
  return gitDir === commonDir
    ? 3210
    : 10_000 + (Bun.hash.crc32(gitDir) % 3400) * 5;
}

/** This checkout's first port: `RAAQEB_E2E_PORT` when set, else derived; with no git checkout or no git, the main checkout's. */
export function checkoutFirstPort(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const set = env.RAAQEB_E2E_PORT;
  if (set !== undefined) {
    const port = Number(set);
    if (!(Number.isInteger(port) && port >= 1024 && port <= 65_531)) {
      throw new Error(
        `raaqeb: RAAQEB_E2E_PORT is not a first port from 1024 to 65531 (${set.length} characters)`
      );
    }
    return port;
  }
  try {
    const git = Bun.spawnSync(
      [
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd: import.meta.dir, stderr: "ignore" }
    );
    const [gitDir = "", commonDir = ""] = git.stdout
      .toString()
      .trim()
      .split("\n");
    return firstPort(gitDir, commonDir);
  } catch {
    // No git on PATH.
    return firstPort("", "");
  }
}

/** The line to print when one of the five ports from `first` is taken; nothing when all are free. */
export function busyPortMessage(first: number): string | undefined {
  for (let port = first; port < first + 5; port += 1) {
    try {
      Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: { data: () => undefined },
      }).stop(true);
    } catch {
      return `raaqeb: port ${port} is in use, one of this checkout's e2e ports ${first} to ${first + 4}: stop what holds it, or set RAAQEB_E2E_PORT to another first port`;
    }
  }
}

if (import.meta.main) {
  try {
    const message = busyPortMessage(checkoutFirstPort());
    if (message) {
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}

import type { MainResult, main as sourceMain } from "@/server.ts";
import { waitForOrigin } from "./wait.ts";

/** Where the Arabic server's `bun run build` writes the build the e2e servers run. */
export const buildDir = `${import.meta.dir}/../../dist`;

/**
 * With `RAAQEB_E2E_BINARY` set, the compiled binary the Arabic server's command
 * builds from this run's `dist/` (`bun scripts/package.ts e2e-binary`); every
 * server then runs it, so a fault only the binary shows reaches the suite.
 */
export const binary = process.env.RAAQEB_E2E_BINARY
  ? `${buildDir}/bin/raaqeb-e2e`
  : undefined;

/** Resolves once the server listens, as the entry's `main` does, or to the exit code when the command ends first. */
type Serve = (
  ...args: Parameters<typeof sourceMain>
) => Promise<MainResult | undefined>;

/**
 * The built entry's `main`, which the e2e servers run as `bun run start`
 * does: one module tree with the handler, as in the binary. With the binary,
 * `main` is the binary running `serve`: it resolves once the binary answers
 * on its `--port`, the moment the entry's `main` resolves, so what a server
 * does after it starts happens with either.
 */
export async function builtMain(): Promise<Serve> {
  if (binary) {
    return async (args) => {
      const served = Bun.spawn([binary, "serve", ...args], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      const port = args[args.indexOf("--port") + 1];
      return await Promise.race([
        served.exited,
        waitForOrigin(
          `http://127.0.0.1:${port}/health`,
          Number.POSITIVE_INFINITY
        ).then(() => undefined),
      ]);
    };
  }
  const built: { main: typeof sourceMain } = await import(
    `${buildDir}/server/server.js`
  );
  return built.main;
}

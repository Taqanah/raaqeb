import type { main as sourceMain } from "@/server.ts";

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

/**
 * The built entry's `main`, which the e2e servers run as `bun run start`
 * does: one module tree with the handler, as in the binary. With the binary,
 * `main` is the binary running `serve`, and resolves to its exit code.
 */
export async function builtMain(): Promise<typeof sourceMain> {
  if (binary) {
    return async (args) =>
      await Bun.spawn([binary, "serve", ...args], {
        stdio: ["ignore", "inherit", "inherit"],
      }).exited;
  }
  const built: { main: typeof sourceMain } = await import(
    `${buildDir}/server/server.js`
  );
  return built.main;
}

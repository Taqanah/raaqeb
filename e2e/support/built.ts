import type { main as sourceMain } from "@/server.ts";

/** Where the Arabic server's `bun run build` writes the build the e2e servers run. */
export const buildDir = `${import.meta.dir}/../../dist`;

/**
 * The built entry's `main`, which the e2e servers run as `bun run start`
 * does: one module tree with the handler, as in the binary.
 */
export async function builtMain(): Promise<typeof sourceMain> {
  const built: { main: typeof sourceMain } = await import(
    `${buildDir}/server/server.js`
  );
  return built.main;
}

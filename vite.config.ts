import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defaultServerConditions, defineConfig, type Plugin } from "vite";
import packageJson from "./package.json" with { type: "json" };
import { serverFunctionIds } from "./scripts/server-function-id.ts";

const migrationsDir = "src/server/storage/migrations";

/**
 * Copies each migration's SQL into the build as
 * dist/migrations/<dialect>/<name>/migration.sql, where the entry names it:
 * a bundled chunk has no migrations beside it, and the binary embeds an
 * asset folder under its base name, so the build's root is the one place
 * both share. drizzle-kit's snapshots stay behind: the
 * migrator reads the SQL only.
 */
function migrations(): Plugin {
  return {
    applyToEnvironment: (environment) => environment.name === "ssr",
    async writeBundle(options) {
      const into = `${options.dir}/../migrations`;
      await Bun.$`rm -rf ${into}`;
      const files = await Array.fromAsync(
        new Bun.Glob("*/*/migration.sql").scan({ cwd: migrationsDir })
      );
      await Promise.all(
        files.map((file) =>
          Bun.write(`${into}/${file}`, Bun.file(`${migrationsDir}/${file}`))
        )
      );
    },
    name: "raaqeb-migrations",
  };
}

/**
 * Lists every client chunk's transitive static imports as its imports, as
 * Rollup's `hoistTransitiveImports` did. Start preloads a route's chunk and
 * its imports; Rolldown lists only the direct ones, so the browser found each
 * deeper level of the graph a round trip after the one before.
 */
function transitiveImports(): Plugin {
  return {
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle: {
      handler(_options, bundle) {
        const direct = new Map<string, readonly string[]>();
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            direct.set(output.fileName, output.imports);
          }
        }
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") {
            continue;
          }
          const seen = new Set<string>();
          const next = [...output.imports];
          for (let file = next.pop(); file !== undefined; file = next.pop()) {
            if (!seen.has(file) && file !== output.fileName) {
              seen.add(file);
              next.push(...(direct.get(file) ?? []));
            }
          }
          output.imports = [...seen];
        }
      },
      order: "pre",
    },
    name: "raaqeb-transitive-imports",
  };
}

declare global {
  // Kept on the process's global because Vite loads this file again for the server's build, which must get the same id.
  var raaqebBuild: string | undefined;
}
globalThis.raaqebBuild ??= Date.now().toString(36);

export default defineConfig({
  define: {
    // New on every build, even of one version, so a tab can tell it runs another build than the server (src/start.ts).
    __RAAQEB_BUILD__: JSON.stringify(globalThis.raaqebBuild),
    // The running build's version for the release check (src/server/release/release.ts).
    __RAAQEB_VERSION__: JSON.stringify(packageJson.version),
  },
  // The Bun.serve entry builds beside Start's handler, so the two share one
  // module tree and a class storage throws is the class the handler checks.
  environments: {
    ssr: {
      build: {
        rolldownOptions: {
          input: {
            handler: "virtual:tanstack-start-server-entry",
            server: "./src/server.ts",
          },
        },
      },
    },
  },
  plugins: [
    tanstackStart({
      router: {
        addExtensions: true,
        // A route's loader goes into its lazy chunk with its component, so the
        // admin's loaders and the modules they import leave the public page's
        // preloads. A pending component has its own
        // chunk, so an admin page's skeleton stays out of the public entry.
        // The router offers it after the pending time whether or not
        // it has loaded, so the admin shell loads every skeleton once it is up
        // and suspends a page inside itself.
        codeSplittingOptions: {
          defaultBehavior: [
            ["loader", "component"],
            ["pendingComponent"],
            ["errorComponent"],
            ["notFoundComponent"],
          ],
        },
        quoteStyle: "double",
        semicolons: true,
      },
      // Start's default server entry is src/server.ts, the Bun.serve entry here.
      server: { build: { inlineCss: true }, entry: "handler.ts" },
      // A server function's URL names it, so the request log reads which one ran; the build ships browser and server together.
      serverFns: { generateFunctionId: serverFunctionIds() },
    }),
    // Before Start reads the chunks, which it does last.
    transitiveImports(),
    // React's plugin must come after Start's.
    viteReact(),
    tailwindcss(),
    migrations(),
  ],
  resolve: { tsconfigPaths: true },
  server: { port: 3000, strictPort: true },
  // Bun.serve runs the bundle: under Vite's Node-first conditions srvx inlines
  // its Node Response shim, which Bun.serve refuses, and a throw escaping
  // Start's handler reached the client as an empty 204.
  ssr: { resolve: { conditions: [...defaultServerConditions, "bun"] } },
});

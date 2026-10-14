import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vite";

/** The installers the site serves from its root, read from deploy/ at build so no copy sits in git. */
const installers = ["install.sh", "install.ps1"];

/**
 * The public website: the same stack as the product, in its own Vite
 * root, prerendered to static HTML in website/dist/client. It shares the
 * product's packages and the @/ alias to src/, and never ships in the binary.
 */
export default defineConfig({
  // Absolute, because Start's prerender finds the server bundle by this path from the working directory, not the root.
  build: { outDir: `${import.meta.dirname}/dist` },
  plugins: [
    // Compiles the docs' MDX (website/content/docs) before Start sees it.
    fumadocsMdx(),
    tanstackStart({
      prerender: { crawlLinks: true, enabled: true, failOnError: true },
      // Every page a visitor can reach, so a page no link names yet is still written.
      pages: [
        { path: "/" },
        { path: "/en" },
        { path: "/docs" },
        { path: "/en/docs" },
        { path: "/docs/search/ar.json" },
        { path: "/docs/search/en.json" },
        { path: "/llms.txt" },
        { path: "/llms-full.txt" },
        { path: "/robots.txt" },
        { path: "/sitemap.xml" },
        // The host serves the nearest 404.html for an address that is no file: English under /en, Arabic elsewhere.
        { path: "/404", prerender: { outputPath: "/404.html" } },
        { path: "/en/404", prerender: { outputPath: "/en/404.html" } },
      ],
      router: { addExtensions: true, quoteStyle: "double", semicolons: true },
      // The stylesheet rides in each page's HTML, so the first paint waits on no request but the fonts.
      server: { build: { inlineCss: true } },
      srcDirectory: ".",
    }),
    {
      // An emitted asset keeps its bytes, so `curl | sh` runs the file in deploy/.
      applyToEnvironment: (environment) => environment.name === "client",
      async generateBundle() {
        for (const name of installers) {
          // biome-ignore lint/performance/noAwaitInLoops: two small files, one after the other
          const source = await Bun.file(
            `${import.meta.dirname}/../deploy/${name}`
          ).bytes();
          this.emitFile({ fileName: name, source, type: "asset" });
        }
      },
      apply: "build",
      name: "raaqeb-installers",
    },
    // React's plugin must come after Start's.
    viteReact(),
    tailwindcss(),
  ],
  resolve: { tsconfigPaths: true },
  root: import.meta.dirname,
  server: { port: 3001, strictPort: true },
});

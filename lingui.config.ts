import { defineConfig } from "@lingui/cli";

/**
 * Lingui reads one PO catalog per locale from locales/ and compiles it to
 * locales/<locale>/messages.ts (gitignored, written by `bun run catalog`).
 * Ids are explicit and hand-written, so nothing is extracted from src/ and no
 * source locale is declared: with one, `compile --strict` would take an empty
 * Arabic translation as complete (ADR-0003).
 */
export default defineConfig({
  catalogs: [{ include: [], path: "locales/{locale}/messages" }],
  compileNamespace: "ts",
  locales: ["ar", "en"],
});

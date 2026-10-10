import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";

// Biome's noRestrictedImports sees module paths, and Bun's Postgres driver is
// `import { SQL } from "bun"` or the `Bun.SQL` global, which no path pattern can
// name. This test is the fourth import rule of ADR-0007 for that one driver.
// The database check's adapter is the one file outside storage that opens it,
// and only to reach a monitored server, never Raaqeb's own database.
const repoRoot = new URL("../", import.meta.url).pathname;
const storageFolder = "src/server/storage/";
const databaseCheckAdapter = "src/server/checks/database-io.ts";
const driverImport =
  /import\s*(type\s*)?\{[^}]*\bSQL\b[^}]*\}\s*from\s*["']bun["']/;
const driverGlobal = /\bBun\.(?:SQL|sql)\b/;

async function sourceFilesOutsideStorage(): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob("src/**/*.{ts,tsx}");
  for await (const file of glob.scan({ cwd: repoRoot })) {
    if (!file.startsWith(storageFolder) && file !== databaseCheckAdapter) {
      files.push(file);
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

describe("only storage imports the Bun Postgres driver", () => {
  test("no file outside src/server/storage but the database check's adapter imports SQL from bun or uses Bun.SQL", async () => {
    const files = await sourceFilesOutsideStorage();
    const texts = await Promise.all(
      files.map((file) => Bun.file(`${repoRoot}${file}`).text())
    );
    const offenders = files.filter((_, i) => {
      const text = texts[i] ?? "";
      return driverImport.test(text) || driverGlobal.test(text);
    });
    expect(offenders).toEqual([]);
  });

  test("the patterns catch the driver's import forms", () => {
    expect(driverImport.test('import { SQL } from "bun";')).toBe(true);
    expect(driverImport.test('import { SQL, serve } from "bun";')).toBe(true);
    expect(driverGlobal.test("const db = new Bun.SQL(url);")).toBe(true);
    expect(driverGlobal.test("await Bun.sql`select 1`;")).toBe(true);
    expect(driverImport.test('import { serve } from "bun";')).toBe(false);
    expect(driverGlobal.test("Bun.serve({})")).toBe(false);
  });
});

// The path patterns of ADR-0007 live in biome.jsonc as per-folder overrides.
// Each fixture is linted on disk under a chosen path, but in a temp directory
// outside the repo (a copy of biome.jsonc, a symlink to node_modules for the
// presets, a .gitignore and a git repo because the presets read the ignore
// file). A fixture inside the tree would be linted by any lint running at the
// same time, and Biome's stdin mode prints no lint diagnostics (2.5.12).
const biome = `${repoRoot}node_modules/.bin/biome`;
let fixtureRoot = "";

beforeAll(async () => {
  fixtureRoot = (await $`mktemp -d`.text()).trim();
  await $`ln -s ${repoRoot}node_modules ${fixtureRoot}/node_modules`.quiet();
  await $`cp ${repoRoot}biome.jsonc ${repoRoot}.gitignore ${fixtureRoot}/`.quiet();
  await $`git -C ${fixtureRoot} init -q`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${fixtureRoot}`.quiet();
});

/** Biome's report for a fixture placed at `path`, on the .bin shim run under Bun (bunfig.toml). */
async function lintAt(path: string, source: string): Promise<string> {
  await Bun.write(`${fixtureRoot}/${path}`, source);
  const result =
    await $`bun --bun ${biome} lint --config-path=${fixtureRoot} ${path}`
      .cwd(fixtureRoot)
      .quiet()
      .nothrow();
  return result.stdout.toString() + result.stderr.toString();
}

describe("the import rules fire where ADR-0007 says", () => {
  test("shared/ importing server/ is refused", async () => {
    const report = await lintAt(
      "src/shared/domain/uptime.ts",
      'import { monitors } from "@/server/storage/monitors.ts";\nexport const x = monitors;\n'
    );
    expect(report).toContain("shared/ imports nothing above it");
  });

  test("shared/ importing a UI is refused", async () => {
    const report = await lintAt(
      "src/shared/ui/button.tsx",
      'import { List } from "@/admin/monitors/list.tsx";\nexport const x = List;\n'
    );
    expect(report).toContain("shared/ imports nothing above it");
  });

  test("a UI importing server/ is refused", async () => {
    const report = await lintAt(
      "src/admin/monitors/list.tsx",
      'import { monitors } from "@/server/storage/monitors.ts";\nexport const x = monitors;\n'
    );
    expect(report).toContain("never import server/");
  });

  test("server/ importing a UI or routes/ is refused", async () => {
    const report = await lintAt(
      "src/server/scheduler/tick.ts",
      'import { Route } from "@/routes/index.tsx";\nexport const x = Route;\n'
    );
    expect(report).toContain("server/ never imports a UI or routes/");
  });

  test("Drizzle outside storage is refused", async () => {
    const report = await lintAt(
      "src/routes/index.tsx",
      'import { eq } from "drizzle-orm";\nexport const x = eq;\n'
    );
    expect(report).toContain("Only src/server/storage imports Drizzle");
  });

  test("a relative path into server/ is refused like the alias", async () => {
    const shared = await lintAt(
      "src/shared/domain/uptime.ts",
      'import { monitors } from "../../server/storage/monitors.ts";\nexport const x = monitors;\n'
    );
    expect(shared).toContain("shared/ imports nothing above it");
    const ui = await lintAt(
      "src/admin/monitors/list.tsx",
      'import { monitors } from "../../server/storage/monitors.ts";\nexport const x = monitors;\n'
    );
    expect(ui).toContain("never import server/");
  });

  test("a relative path from server/ into a UI is refused like the alias", async () => {
    const report = await lintAt(
      "src/server/scheduler/tick.ts",
      'import { Route } from "../../routes/index.tsx";\nexport const x = Route;\n'
    );
    expect(report).toContain("server/ never imports a UI or routes/");
  });

  test("a deep module importing another through the alias passes", async () => {
    const report = await lintAt(
      "src/server/scheduler/tick.ts",
      'import { monitors } from "@/server/storage/monitors.ts";\nexport const x = monitors;\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });

  test("routes/ importing server/ passes", async () => {
    const report = await lintAt(
      "src/routes/index.tsx",
      'import { monitors } from "@/server/storage/monitors.ts";\nexport const x = monitors;\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });

  test("routes/ importing a UI passes: a route calls one module", async () => {
    const report = await lintAt(
      "src/routes/design.tsx",
      'import { DesignSample } from "@/admin/design/sample.tsx";\nexport const x = DesignSample;\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });

  test("Lingui outside src/shared/i18n is refused (ADR-0003)", async () => {
    const ui = await lintAt(
      "src/admin/monitors/list.tsx",
      'import { Trans } from "@lingui/react";\nexport const x = Trans;\n'
    );
    expect(ui).toContain("crosses src/shared/i18n");
    const route = await lintAt(
      "src/routes/index.tsx",
      'import { i18n } from "@lingui/core";\nexport const x = i18n;\n'
    );
    expect(route).toContain("crosses src/shared/i18n");
    const server = await lintAt(
      "src/server/notify/email.ts",
      'import { i18n } from "@lingui/core";\nexport const x = i18n;\n'
    );
    expect(server).toContain("crosses src/shared/i18n");
    const shared = await lintAt(
      "src/shared/ui/button.tsx",
      'import { i18n } from "@lingui/core";\nexport const x = i18n;\n'
    );
    expect(shared).toContain("crosses src/shared/i18n");
  });

  test("src/shared/i18n importing Lingui passes", async () => {
    const report = await lintAt(
      "src/shared/i18n/messages.ts",
      'import { i18n } from "@lingui/core";\nexport const x = i18n;\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });

  test("storage importing Drizzle passes", async () => {
    const report = await lintAt(
      "src/server/storage/sqlite.ts",
      'import { eq } from "drizzle-orm";\nexport const x = eq;\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });
});

// ADR-0007: an import that goes up a folder uses the @/ alias.
// Each file below sits under a different override of biome.jsonc, and an
// override replaces the rule's patterns, so each must carry the refusal.
const upFolder = "An import that goes up a folder uses @/";
const eachOverride = [
  "src/admin/monitors/list.tsx",
  "src/start.ts",
  "src/server.ts",
  "src/server/scheduler/tick.ts",
  "src/server/storage/sqlite.ts",
  "src/routes/index.tsx",
  "src/shared/domain/uptime.ts",
  "src/shared/i18n/messages.ts",
];

describe("an import that goes up a folder uses the alias", () => {
  test.each(eachOverride)("a ../ import in %s is refused", async (path) => {
    const report = await lintAt(
      path,
      'import { cn } from "../ui/cn.ts";\nexport const x = cn;\n'
    );
    expect(report).toContain(upFolder);
  });

  test.each([
    [
      "an import",
      'import { cn } from "../../shared/ui/cn.ts";\nexport const x = cn;\n',
    ],
    [
      "a type import",
      'import type { Locale } from "../i18n/locale.ts";\nexport type X = Locale;\n',
    ],
    ["a re-export", 'export { cn } from "../ui/cn.ts";\n'],
    ["a dynamic import", 'export const load = () => import("../ui/cn.ts");\n'],
    ["a side-effect import", 'import "../ui/style.css";\n'],
    [
      "an import of the parent folder itself",
      'import { index } from "..";\nexport const x = index;\n',
    ],
  ])("%s that goes up a folder is refused", async (_form, source) => {
    const report = await lintAt("src/admin/monitors/list.tsx", source);
    expect(report).toContain(upFolder);
  });

  test("an import in the importer's own folder or below passes", async () => {
    const report = await lintAt(
      "src/admin/monitors/list.tsx",
      'import { a } from "./draft.ts";\nimport { b } from "./parts/row.tsx";\nexport const x = [a, b];\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });

  test("locales/, which the alias cannot reach, stays relative", async () => {
    const report = await lintAt(
      "src/server/settings/language.ts",
      'export const load = () => import("../../../locales/ar/messages.ts");\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });

  test.each(["e2e/api.spec.ts", "bench/floor/seed.ts", "scripts/catalog.ts"])(
    "outside src/, a ../ import of src/ in %s is refused",
    async (path) => {
      const up = "../".repeat(path.split("/").length - 1);
      const report = await lintAt(
        path,
        `import { cn } from "${up}src/shared/ui/cn.ts";\nexport const x = cn;\n`
      );
      expect(report).toContain("An import of src/ uses @/");
    }
  );

  test("outside src/, the alias and a ../ between folders outside src/ pass", async () => {
    const report = await lintAt(
      "bench/floor/seed.ts",
      'import { cn } from "@/shared/ui/cn.ts";\nimport { port } from "../../e2e/support/servers.ts";\nexport const x = [cn, port];\n'
    );
    expect(report).not.toContain("noRestrictedImports");
  });
});

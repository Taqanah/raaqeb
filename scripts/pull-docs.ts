/**
 * Mirrors the documentation of every dependency into docs/deps/ (gitignored)
 * so agents can grep it offline, pinned to the installed version where the
 * dependency's repo tags releases.
 */

import { $ } from "bun";

export interface Library {
  /** Default branch: mirrored when the repo has no release tags, or no tag for the installed version. */
  branch: string;
  /** Folder name under docs/deps. */
  name: string;
  /** npm package whose installed version picks the tag. Absent for Bun and for unpinned repos. */
  package?: string;
  /** Docs folders inside the repo, checked out sparsely. */
  paths: string[];
  /** owner/name on GitHub. */
  repo: string;
  /** Maps a version to the repo's tag. Absent means the repo has no release tags. */
  tag?: (version: string) => string;
}

export interface Ref {
  /** Set when the branch stands in for a tag that does not exist. */
  missingTag?: string;
  /** Git ref to check out: a tag or a branch. */
  ref: string;
  /** Where the ref came from. */
  source: "bun.lock" | "registry" | "bun runtime" | "default branch";
}

/** Package name to the version to pin, and where that version was read. */
export type Versions = Map<
  string,
  { version: string; source: "bun.lock" | "registry" }
>;

const v = (version: string) => `v${version}`;

export const libraries: Library[] = [
  {
    branch: "main",
    name: "tanstack-router",
    package: "@tanstack/react-router",
    paths: ["docs/router", "docs/start"],
    repo: "TanStack/router",
    tag: v,
  },
  {
    branch: "dev",
    name: "fumadocs",
    package: "fumadocs-core",
    paths: ["apps/docs/content/docs"],
    repo: "fuma-nama/fumadocs",
    tag: (version) => `fumadocs@${version}`,
  },
  {
    branch: "main",
    name: "tanstack-query",
    package: "@tanstack/react-query",
    paths: ["docs/framework/react"],
    repo: "TanStack/query",
    tag: v,
  },
  {
    branch: "main",
    name: "tanstack-form",
    package: "@tanstack/react-form",
    paths: ["docs/framework/react", "docs/overview.md", "docs/philosophy.md"],
    repo: "TanStack/form",
    tag: v,
  },
  {
    branch: "main",
    name: "shadcn",
    package: "shadcn",
    paths: ["apps/v4/content/docs"],
    repo: "shadcn-ui/ui",
    tag: (version) => `shadcn@${version}`,
  },
  {
    branch: "main",
    name: "base-ui",
    package: "@base-ui/react",
    paths: ["docs/src/app/(docs)/react"],
    repo: "mui/base-ui",
    tag: v,
  },
  {
    branch: "main",
    name: "better-auth",
    package: "better-auth",
    paths: ["docs/content/docs"],
    repo: "better-auth/better-auth",
    tag: v,
  },
  {
    branch: "main",
    name: "bun",
    paths: ["docs"],
    repo: "oven-sh/bun",
    tag: (version) => `bun-v${version}`,
  },
  {
    branch: "main",
    name: "zod",
    package: "zod",
    paths: ["packages/docs/content"],
    repo: "colinhacks/zod",
    tag: v,
  },
  {
    branch: "main",
    name: "lingui",
    package: "@lingui/core",
    paths: ["website/docs"],
    repo: "lingui/js-lingui",
    tag: v,
  },
  {
    branch: "main",
    name: "playwright",
    package: "@playwright/test",
    paths: ["docs/src"],
    repo: "microsoft/playwright",
    tag: v,
  },
  {
    branch: "main",
    name: "vite",
    package: "vite",
    paths: ["docs"],
    repo: "vitejs/vite",
    tag: v,
  },
  {
    branch: "main",
    name: "ultracite",
    package: "ultracite",
    paths: ["apps/docs"],
    repo: "haydenbleasel/ultracite",
    tag: v,
  },
  {
    branch: "main",
    name: "drizzle",
    paths: ["src/content/docs"],
    repo: "drizzle-team/drizzle-orm-docs",
  },
  {
    branch: "main",
    name: "tailwind",
    paths: ["src/docs"],
    repo: "tailwindlabs/tailwindcss.com",
  },
  {
    branch: "main",
    name: "biome",
    paths: ["src/content/docs"],
    repo: "biomejs/website",
  },
  {
    // The docs site is its own repo with no release tags; the installed source in node_modules/nodemailer answers for 10.0.10.
    branch: "master",
    name: "nodemailer",
    paths: ["docs"],
    repo: "nodemailer/nodemailer-homepage",
  },
  {
    branch: "main",
    name: "react",
    paths: ["src/content/reference", "src/content/learn"],
    repo: "reactjs/react.dev",
  },
];

/** Package name to resolved version, read from the text of bun.lock. */
export function installedVersions(lockText: string): Versions {
  const lock = Bun.JSONC.parse(lockText) as {
    packages?: Record<string, [string, ...unknown[]]>;
  };
  const versions: Versions = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key.includes("/") && !key.startsWith("@")) {
      continue; // a copy nested under another package, keyed "parent/name"
    }
    const at = entry[0].lastIndexOf("@");
    versions.set(key, { source: "bun.lock", version: entry[0].slice(at + 1) });
  }
  return versions;
}

/** The ref to mirror for one library. Throws when a pinned library's version is unknown. */
export function resolveRef(
  lib: Library,
  versions: Versions,
  bunVersion: string
): Ref {
  if (!lib.tag) {
    return { ref: lib.branch, source: "default branch" };
  }
  if (!lib.package) {
    return { ref: lib.tag(bunVersion), source: "bun runtime" };
  }
  const known = versions.get(lib.package);
  if (!known) {
    throw new Error(
      `${lib.package}: no version in bun.lock and none from the registry`
    );
  }
  return { ref: lib.tag(known.version), source: known.source };
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/** The one-line record written to docs/deps/<name>/PULLED.md. */
export function pulledRecord(lib: Library, ref: Ref, date: Date): string {
  const why = ref.missingTag ? `, no tag ${ref.missingTag}` : "";
  const paths = lib.paths.join(" ");
  return `${lib.repo} at ${ref.ref} (${ref.source}${why}), paths ${paths}, pulled ${day(date)}\n`;
}

/**
 * True when an existing PULLED.md says the folder already holds this ref and
 * these paths. A tag never moves, so a tag match is enough; a branch moves, so
 * a branch pull counts as current only on the day it was made.
 */
export function isCurrent(
  pulledText: string | null,
  ref: Ref,
  today: Date,
  lib: Library
): boolean {
  if (!pulledText?.includes(` at ${ref.ref} (`)) {
    return false;
  }
  if (!pulledText.includes(`, paths ${lib.paths.join(" ")}, `)) {
    return false;
  }
  return ref.source !== "default branch" || pulledText.includes(day(today));
}

/** The branch standing in for a tag that the repo does not have. */
export function fallbackToBranch(lib: Library, wanted: Ref): Ref {
  return { missingTag: wanted.ref, ref: lib.branch, source: "default branch" };
}

/** Reads `git ls-remote --exit-code`: 0 is found, 2 is not found, anything else is a transport failure. */
export function refProbe(exitCode: number, stderr: string): boolean {
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === 2) {
    return false;
  }
  throw new Error(`git ls-remote failed (${exitCode}): ${stderr.trim()}`);
}

/** Whether the repo has this tag or branch, asked without cloning. */
export async function refExists(repo: string, ref: string): Promise<boolean> {
  const probe =
    await $`git ls-remote --exit-code https://github.com/${repo} ${ref}`
      .quiet()
      .nothrow();
  return refProbe(probe.exitCode, probe.stderr.toString());
}

/** Images, video and fonts are not text an agent can grep; left out of the checkout so they are never fetched. */
const mediaExcluded = [
  "!*.png",
  "!*.jpg",
  "!*.jpeg",
  "!*.gif",
  "!*.webp",
  "!*.avif",
  "!*.ico",
  "!*.mp4",
  "!*.webm",
  "!*.woff",
  "!*.woff2",
];

/**
 * Sparse, shallow, single-ref clone of the docs paths into root/<name>. The
 * clone lands in a temporary folder and replaces the old one only on success,
 * so a failed clone (offline, bad ref) leaves the previous docs in place.
 */
export async function pull(
  lib: Library,
  ref: Ref,
  root: string
): Promise<"pulled" | "skipped"> {
  const dir = `${root}/${lib.name}`;
  const recordFile = Bun.file(`${dir}/PULLED.md`);
  const existing = (await recordFile.exists()) ? await recordFile.text() : null;
  if (isCurrent(existing, ref, new Date(), lib)) {
    return "skipped";
  }
  const tmp = `${dir}.pulling`;
  const patterns = [...lib.paths.map((path) => `/${path}`), ...mediaExcluded];
  await $`rm -rf ${tmp}`.quiet();
  await $`git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch ${ref.ref} https://github.com/${lib.repo} ${tmp}`.quiet();
  await $`git -C ${tmp} sparse-checkout set --no-cone ${patterns}`.quiet();
  await $`git -C ${tmp} checkout --quiet`.quiet();
  await $`rm -rf ${tmp}/.git`.quiet();
  const listings = await Promise.all(
    lib.paths.map((path) => $`find ${tmp}/${path} -type f`.quiet().text())
  );
  const empty = lib.paths.filter((_, i) => listings[i]?.trim() === "");
  if (empty.length > 0) {
    await $`rm -rf ${tmp}`.quiet();
    throw new Error(
      `${lib.name}: ${empty.join(", ")} holds no files at ${ref.ref}`
    );
  }
  await Bun.write(`${tmp}/PULLED.md`, pulledRecord(lib, ref, new Date()));
  await $`rm -rf ${dir}`.quiet();
  await $`mv ${tmp} ${dir}`.quiet();
  return "pulled";
}

/** What to print after the ref: why it is a branch, or that the package is not installed. */
function describeRef(ref: Ref): string {
  if (ref.missingTag) {
    return ` (no tag ${ref.missingTag}, branch instead)`;
  }
  return ref.source === "registry" ? " (not installed, registry latest)" : "";
}

/** A shell failure's stderr, or the error itself. */
function describe(reason: unknown): string {
  if (reason instanceof Error && "stderr" in reason) {
    const stderr = String(reason.stderr).trim();
    return stderr === "" ? reason.message : stderr;
  }
  return String(reason);
}

async function registryVersion(pkg: string): Promise<string> {
  return (await $`bun pm view ${pkg} version`.quiet().text()).trim();
}

/** Resolves the ref for one library, asking the registry and the repo as needed. */
async function refFor(lib: Library, versions: Versions): Promise<Ref> {
  if (lib.package && !versions.has(lib.package)) {
    versions.set(lib.package, {
      source: "registry",
      version: await registryVersion(lib.package),
    });
  }
  const wanted = resolveRef(lib, versions, Bun.version);
  if (wanted.source === "default branch") {
    return wanted;
  }
  return (await refExists(lib.repo, wanted.ref))
    ? wanted
    : fallbackToBranch(lib, wanted);
}

export async function main(): Promise<void> {
  const root = `${import.meta.dir}/../docs/deps`;
  const lockFile = Bun.file(`${import.meta.dir}/../bun.lock`);
  const versions = installedVersions(await lockFile.text());
  const results = await Promise.allSettled(
    libraries.map(async (lib) => {
      const ref = await refFor(lib, versions);
      const result = await pull(lib, ref, root);
      console.log(
        `${result.padEnd(7)} ${lib.name} ${ref.ref}${describeRef(ref)}`
      );
    })
  );
  const failures = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [`${libraries[i]?.name}: ${describe(r.reason)}`]
      : []
  );
  if (failures.length > 0) {
    console.error(`\n${failures.length} failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}

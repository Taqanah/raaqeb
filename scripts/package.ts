/**
 * The release artefacts. `bun run binaries`
 * compiles the Vite build into one `raaqeb` binary per target under `dist/bin/`,
 * each embedding the Bun runtime, the client assets and the migrations, and
 * writes their `SHA256SUMS`. `bun run image` builds the distroless image for
 * amd64 and arm64 from those binaries into an OCI archive under
 * `dist/image/` and loads the host's platform as `ghcr.io/taqanah/raaqeb:<version>`. The
 * version is package.json's; publishing belongs to the release workflow.
 */
import { isVersion } from "@/server/release/version.ts";
import { website } from "@/shared/ui/website.ts";

/** One target: Bun's compile target, the binary's file name, and the image platform it serves. */
export interface Target {
  readonly bun: Bun.Build.CompileTarget;
  readonly file: string;
  /** The Docker platform whose image carries this binary; the musl, macOS and Windows builds are for the installers only. */
  readonly platform: "linux/amd64" | "linux/arm64" | undefined;
}

/**
 * The four Linux targets, macOS on Apple Silicon only (Intel Macs are no
 * longer sold and no hardware tests them), and Windows on x64 and arm64. Bun
 * 1.4.3 has one x64 build, which picks its CPU paths at runtime (its
 * `-baseline` archives hold the same binary), so there is no baseline target.
 * Bun signs the macOS binary ad hoc as it compiles it, which Apple Silicon
 * needs.
 */
export const targets: readonly Target[] = [
  { bun: "bun-linux-x64", file: "raaqeb-linux-x64", platform: "linux/amd64" },
  {
    bun: "bun-linux-arm64",
    file: "raaqeb-linux-arm64",
    platform: "linux/arm64",
  },
  {
    bun: "bun-linux-x64-musl",
    file: "raaqeb-linux-x64-musl",
    platform: undefined,
  },
  {
    bun: "bun-linux-arm64-musl",
    file: "raaqeb-linux-arm64-musl",
    platform: undefined,
  },
  { bun: "bun-darwin-arm64", file: "raaqeb-darwin-arm64", platform: undefined },
  {
    bun: "bun-windows-x64",
    file: "raaqeb-windows-x64.exe",
    platform: undefined,
  },
  {
    bun: "bun-windows-arm64",
    file: "raaqeb-windows-arm64.exe",
    platform: undefined,
  },
];

/** A file of the release and its bytes. */
export interface Artefact {
  readonly bytes: Uint8Array;
  readonly name: string;
}

/** The `SHA256SUMS` text: one `<hex digest>  <name>` line per file, in name order, as `sha256sum -c` reads it. */
export function checksums(files: readonly Artefact[]): string {
  return files
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(
      (file) =>
        `${new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex")}  ${file.name}\n`
    )
    .join("");
}

/** Where a build came from: the version, the commit, whether the tree held changes, and when. */
export interface Provenance {
  readonly created: Date;
  readonly dirty: boolean;
  readonly revision: string;
  readonly version: string;
}

/** The image's OCI labels. A tree with changes gets `-dirty` on its revision, so an image never claims a commit it does not match. */
export function imageLabels(build: Provenance): Record<string, string> {
  return {
    "org.opencontainers.image.created": build.created.toISOString(),
    "org.opencontainers.image.description":
      "Self-hosted monitoring and status pages, Arabic first",
    "org.opencontainers.image.documentation": `${website}/docs`,
    "org.opencontainers.image.licenses": "FSL-1.1-ALv2",
    "org.opencontainers.image.revision": build.dirty
      ? `${build.revision}-dirty`
      : build.revision,
    "org.opencontainers.image.source": "https://github.com/Taqanah/raaqeb",
    "org.opencontainers.image.title": "raaqeb",
    "org.opencontainers.image.url": website,
    "org.opencontainers.image.version": build.version,
  };
}

/** The image's name in the registry and for Docker, `ghcr.io/taqanah/raaqeb:<version>`; registry names are lowercase. */
export function imageTag(version: string): string {
  return `ghcr.io/taqanah/raaqeb:${version}`;
}

/** The package's version, refused unless it is SemVer, with or without an alpha, beta or rc pre-release. */
export function releaseVersion(pkg: unknown): string {
  const version =
    typeof pkg === "object" && pkg !== null && "version" in pkg
      ? pkg.version
      : undefined;
  if (typeof version !== "string" || !isVersion(version)) {
    throw new Error("package.json's version must be a SemVer version");
  }
  return version;
}

const repo = `${import.meta.dir}/..`;
const binDir = `${repo}/dist/bin`;
const imageDir = `${repo}/dist/image`;

/**
 * The arguments of `bun build` that compile one target from the Vite build,
 * run from dist/ with dist/ as the root, so the binary's embedded tree is
 * dist's own layout: the entry at server/server.js, the handler beside it,
 * the client assets and the migrations where the entry looks. Splitting keeps
 * the chunks the two entries share as one copy, one module tree.
 */
export function compileArgs(target: Target, outfile: string): string[] {
  return [
    "build",
    "--compile",
    "--splitting",
    `--target=${target.bun}`,
    "--root=.",
    "--no-compile-autoload-bunfig",
    // Bun compiles for development unless told, which bundles React's development build.
    '--define=process.env.NODE_ENV="production"',
    // Minified, the binary measured 4 to 7 MB less RSS in one run each.
    "--minify",
    "--asset=client",
    "--asset=migrations",
    `--outfile=${outfile}`,
    "server/server.js",
    "server/handler.js",
  ];
}

/** Compiles every target from the Vite build in dist/ and writes their checksums. */
async function binaries(): Promise<void> {
  releaseVersion(await Bun.file(`${repo}/package.json`).json());
  await Bun.$`rm -rf ${binDir}`;
  for (const target of targets) {
    // biome-ignore lint/performance/noAwaitInLoops: one compile at a time; each holds a Bun runtime in memory
    await Bun.$`${process.execPath} ${compileArgs(target, `${binDir}/${target.file}`)}`
      .cwd(`${repo}/dist`)
      .quiet();
    process.stdout.write(`compiled dist/bin/${target.file}\n`);
  }
  const files = await Promise.all(
    targets.map(async (target) => ({
      bytes: await Bun.file(`${binDir}/${target.file}`).bytes(),
      name: target.file,
    }))
  );
  await Bun.write(`${binDir}/SHA256SUMS`, checksums(files));
  process.stdout.write("wrote dist/bin/SHA256SUMS\n");
}

/** The image's labels as `--label key=value` arguments, for the package's version. */
async function labelArgs(version: string): Promise<string[]> {
  const provenance = imageLabels({
    created: new Date(),
    dirty: (await Bun.$`git status --porcelain`.cwd(repo).text()).trim() !== "",
    revision: (await Bun.$`git rev-parse HEAD`.cwd(repo).text()).trim(),
    version,
  });
  return Object.entries(provenance).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
}

const imagePlatforms = targets
  .flatMap((target) => (target.platform ? [target.platform] : []))
  .join(",");

/**
 * Builds the image for both platforms into an OCI archive, then loads the
 * host's platform into Docker as ghcr.io/taqanah/raaqeb:<version>. Publishing is the release
 * workflow's (`push`).
 */
async function image(): Promise<void> {
  const version = releaseVersion(await Bun.file(`${repo}/package.json`).json());
  const labels = await labelArgs(version);
  const tag = imageTag(version);
  await Bun.$`mkdir -p ${imageDir}`;
  await Bun.$`docker buildx build --platform=${imagePlatforms} ${labels} --tag=${tag} --output=type=oci,dest=${imageDir}/raaqeb-${version}.oci.tar .`.cwd(
    repo
  );
  process.stdout.write(`wrote dist/image/raaqeb-${version}.oci.tar\n`);
  const host = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
  await Bun.$`docker buildx build --platform=${host} ${labels} --tag=${tag} --load .`.cwd(
    repo
  );
  process.stdout.write(`loaded ${tag} for ${host}\n`);
}

/**
 * Builds the image from the binaries in dist/bin for both platforms and pushes
 * it to the registry with an SBOM, the way the release workflow does after
 * its checks pass. BuildKit's own provenance is off: GitHub's attestation of
 * the pushed digest is the provenance. Needs a registry login and a builder
 * that can push a multi-platform image.
 */
async function push(): Promise<void> {
  const version = releaseVersion(await Bun.file(`${repo}/package.json`).json());
  const labels = await labelArgs(version);
  const tag = imageTag(version);
  await Bun.$`docker buildx build --platform=${imagePlatforms} ${labels} --tag=${tag} --sbom=true --provenance=false --push .`.cwd(
    repo
  );
  process.stdout.write(`pushed ${tag}\n`);
}

if (import.meta.main) {
  const [command] = Bun.argv.slice(2);
  if (command === "binaries") {
    await binaries();
  } else if (command === "image") {
    await image();
  } else if (command === "push") {
    await push();
  } else {
    process.stderr.write("usage: bun scripts/package.ts binaries|image|push\n");
    process.exit(2);
  }
}

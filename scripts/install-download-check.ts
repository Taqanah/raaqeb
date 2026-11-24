/**
 * `bun scripts/install-download-check.ts`: the installer's download alone,
 * on every image an operator may run it on, with zstd and without. In a plain
 * container of each, with no init and no privileges, `download` from
 * deploy/install.sh fetches the binary from dist/bin, checks the archive
 * and the binary it unpacks to against SHA256SUMS, and the binary it leaves
 * is then compared byte for byte with the raw one. The service is not
 * started: `bun run install:check` does that, on a runner. Needs Docker and
 * `bun run binaries`, so it stays out of the gate.
 */
import { standInImage } from "../bench/floor/container.ts";

const repo = `${import.meta.dir}/..`;
const bin = `${repo}/dist/bin`;
const tag = `r914-${Date.now().toString(36)}`;
const network = `${tag}-net`;
const files = `${tag}-files`;
const release = `http://${files}:8080`;

interface Distro {
  /** Adds a downloader where the image has none. */
  readonly addCurl: string;
  /** Adds zstd, where the image's packages have it. */
  readonly addZstd: string | undefined;
  readonly image: string;
  /** What the installer takes without zstd: the .gz, or the raw binary where there is no gzip either. */
  readonly withoutZstd: ".gz" | "raw";
}

const apt = (image: string): Distro => ({
  addCurl:
    "apt-get update -qq && apt-get install -y -qq --no-install-recommends curl >/dev/null",
  addZstd: "apt-get install -y -qq --no-install-recommends zstd >/dev/null",
  image,
  withoutZstd: ".gz",
});

/** The images an operator may install on, from a server's base to a container's minimal one. */
const distros: readonly Distro[] = [
  apt(
    "debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8"
  ),
  apt(
    "debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc"
  ),
  apt(
    "debian:13-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2"
  ),
  apt(
    "ubuntu:22.04@sha256:b000e69a50ff940390233025e7a337fb8469b509e2334fa4d018ac30f3e18cdb"
  ),
  apt(
    "ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b"
  ),
  // Alpine and busybox download with busybox's wget.
  {
    addCurl: ":",
    addZstd: "apk add --no-cache -q zstd",
    image:
      "alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f",
    withoutZstd: ".gz",
  },
  {
    addCurl: ":",
    addZstd: undefined,
    image:
      "busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
    withoutZstd: ".gz",
  },
  ...[
    "almalinux:9@sha256:02df05719ef287ebd0df0a1eedb9172a00bd70703aed7b25660e426b8e0d6047",
    "fedora:42@sha256:99e203b80b1c3d8f7e161ec10a68fd02b081ef83a3963553e513c82846b97814",
    "rockylinux/rockylinux:9@sha256:bb5755f96bec05ff26165e779ec843d7167544be9e50770508f307019a6d05c4",
  ].map(
    (image): Distro => ({
      addCurl: ":",
      addZstd: "dnf install -y -q zstd >/dev/null",
      image,
      withoutZstd: ".gz",
    })
  ),
  {
    addCurl: ":",
    addZstd: "microdnf install -y zstd >/dev/null",
    image:
      "rockylinux/rockylinux:9-minimal@sha256:96aef88435673089451d3ca68780d3f68936f19a03b15b685bff54e55b6ef3a5",
    withoutZstd: ".gz",
  },
  // RHEL's minimal bases have no gzip.
  ...[
    "almalinux:9-minimal@sha256:4af44be4e5e2a369bec919a213a7c372207f5532f33fff29634ea272ec85b46e",
    "redhat/ubi9-minimal@sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352",
  ].map(
    (image): Distro => ({
      addCurl: ":",
      addZstd: "microdnf install -y zstd >/dev/null",
      image,
      withoutZstd: "raw",
    })
  ),
];

/** Runs a command and answers its exit code and output, never throwing. */
async function run(
  command: string[],
  stdin?: string
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, {
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, output: stdout + stderr };
}

async function must(command: string[]): Promise<void> {
  const { code, output } = await run(command);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited ${code}: ${output}`);
  }
}

const tookArchive = /downloaded raaqeb-[\w.-]+?(\.zst|\.gz) from/;
const tookRaw = /downloading raaqeb-[\w.-]+ from/;
const fileLine = /^file=(\S+)$/m;

/** The file the installer said it took, from its own lines. */
function taken(output: string): string | undefined {
  return (
    tookArchive.exec(output)?.[1] ?? (tookRaw.test(output) ? "raw" : undefined)
  );
}

/** One image, with zstd or without: the file the installer must take, and the binary it leaves equal to the raw one. */
async function checkOne(
  distro: Distro,
  zstd: boolean,
  library: string,
  folder: string
): Promise<void> {
  const setup = zstd
    ? `${distro.addCurl} && ${distro.addZstd}`
    : `${distro.addCurl} && rm -f "$(command -v zstd)"`;
  const answer = await run(
    [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      network,
      "-v",
      `${folder}:/out`,
      distro.image,
      "sh",
      "-s",
    ],
    `${library}
${setup} || fail "could not set the image up"
file=raaqeb-linux-$(target_of "$(uname -m)" "$(libc_of "")")
tmp=$(mktemp -d)
download ${release} "$file" "$tmp" ""
cp "$tmp/$file" /out/binary && chmod 0644 /out/binary && echo "file=$file"
`
  );
  const name = `${distro.image.split("@")[0]}${zstd ? " with zstd" : ""}`;
  const expected = zstd ? ".zst" : distro.withoutZstd;
  const file = fileLine.exec(answer.output)?.[1];
  if (answer.code !== 0 || file === undefined) {
    throw new Error(`${name} exited ${answer.code}: ${answer.output}`);
  }
  if (taken(answer.output) !== expected) {
    throw new Error(`${name} took ${taken(answer.output)}, not ${expected}`);
  }
  const same = await run(["cmp", `${folder}/binary`, `${bin}/${file}`]);
  if (same.code !== 0) {
    throw new Error(`${name} left another binary than ${file}: ${same.output}`);
  }
  await Bun.$`rm -f ${folder}/binary`;
  process.stdout.write(
    `install-download-check: ${name}: took the ${expected}, both checks passed, and the binary is ${file} byte for byte\n`
  );
}

let failed = false;
const out = (await Bun.$`mktemp -d`.text()).trim();
try {
  const library = (await Bun.file(`${repo}/deploy/install.sh`).text()).replace(
    /\nmain "\$@"\n$/,
    "\n"
  );
  await must(["docker", "network", "create", network]);
  await must([
    "docker",
    "run",
    "-d",
    "--name",
    files,
    "--network",
    network,
    "-v",
    `${bin}:/srv:ro`,
    standInImage,
    "bun",
    "-e",
    'Bun.serve({ port: 8080, fetch: async (r) => { const f = Bun.file("/srv" + new URL(r.url).pathname); return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 }); } })',
  ]);
  for (const distro of distros) {
    for (const zstd of distro.addZstd === undefined ? [false] : [false, true]) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one container at a time, each holding a binary
        await checkOne(distro, zstd, library, out);
      } catch (error) {
        failed = true;
        process.stderr.write(`install-download-check: ${String(error)}\n`);
      }
    }
  }
} catch (error) {
  failed = true;
  process.stderr.write(`install-download-check failed: ${String(error)}\n`);
} finally {
  await run(["docker", "rm", "-f", files]);
  await run(["docker", "network", "rm", network]);
  await Bun.$`rm -rf ${out}`;
}
process.exit(failed ? 1 : 0);

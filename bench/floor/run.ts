/**
 * The floor benchmark's entry: `bun run bench [flags]`. With no
 * flags it runs a release's profile on the shipped image of this checkout's
 * version: the SQLite accelerated day beside the fixed runs of SQLite,
 * Postgres and the musl binary, each install on an efficiency core of its
 * own, then SQLite's capacity sweep and throughput sweep alone. The harness
 * itself runs on the stand-ins' cores. Each run writes its results file and its report under
 * `bench/floor/results/`; two or more runs also write their noise band
 * there, and to `bench/floor/band.json` when the band is full length and
 * clean. Linux with cgroup v2 and Docker only. Prints where the files are,
 * never a number: a human reads the report.
 */

import { imageTag } from "../../scripts/package.ts";
import { type NoiseBand, noiseBand, storable } from "./band.ts";
import {
  alpineImage,
  binaryNames,
  imageRevision,
  linkDirectories,
  mailpitImage,
  muslDockerfile,
  muslImage,
  mysqlImage,
  ohaImage,
  postgresImage,
  redisImage,
  runStamp,
  standInImage,
} from "./container.ts";
import { docker } from "./docker.ts";
import { type Flags, parseFlags, sweepLengths } from "./flags.ts";
import { floorBreaks } from "./floor.ts";
import {
  type Cores,
  coresOf,
  cpuList,
  type Machine,
  machineOf,
  placementOf,
} from "./host.ts";
import {
  type Invocation,
  removeCurrent,
  runCapacity,
  runDay,
  runFixed,
  runThroughput,
} from "./phases.ts";
import { lastRow, reportHtml } from "./report.ts";
import {
  type RunResult,
  resultsSchema,
  rowValues,
  type Variant,
  type VariantResult,
} from "./results.ts";

const bench = import.meta.dir;
const repo = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(
  /\/$/,
  ""
);

/** The host's binaries: the glibc one the shipped image holds and the musl one the musl variant runs. */
const { glibc: glibcBinary, musl: muslBinary } = binaryNames(process.arch);

function say(line: string): void {
  process.stdout.write(`raaqeb-bench: ${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`raaqeb-bench: ${line}\n`);
}

process.on("SIGINT", async () => {
  fail("interrupted; removing the run's containers");
  await removeCurrent();
  process.exit(130);
});

/** The directories outside the checkout that Bun's isolated store links into; the stand-in mounts them at their own path. */
async function storeLinks(): Promise<string[]> {
  const listing =
    await Bun.$`find ${repo}/node_modules/.bun -maxdepth 1 -type l -printf ${"%l\n"}`
      .nothrow()
      .quiet()
      .text();
  return linkDirectories(listing);
}

async function readMachine(): Promise<Machine> {
  const [cpuinfo, meminfo, kernel] = await Promise.all([
    Bun.file("/proc/cpuinfo").text(),
    Bun.file("/proc/meminfo").text(),
    Bun.file("/proc/sys/kernel/osrelease").text(),
  ]);
  return machineOf({
    cores: navigator.hardwareConcurrency,
    cpuinfo,
    kernel,
    meminfo,
  });
}

async function version(): Promise<string> {
  const manifest: unknown = await Bun.file(`${repo}/package.json`).json();
  const found =
    typeof manifest === "object" && manifest !== null
      ? Object.entries(manifest).find(([key]) => key === "version")?.[1]
      : undefined;
  return typeof found === "string" ? found : "0.0.0";
}

/** Pulls an image no local copy exists of; answers whether it is there. */
async function present(image: string): Promise<boolean> {
  const local = await Bun.$`docker image inspect ${image}`.nothrow().quiet();
  if (local.exitCode === 0) {
    return true;
  }
  return (
    (await Bun.$`docker pull -q ${image}`.nothrow().quiet()).exitCode === 0
  );
}

/** The SHA-256 a SHA256SUMS file lists for one name. */
function listedSum(sums: string, name: string): string | undefined {
  const line = sums
    .split("\n")
    .find((entry) => entry.trim().endsWith(` ${name}`));
  return line?.split(" ")[0];
}

/** Why the shipped image is not the build in `dist/bin`, or nothing when its binary is the one SHA256SUMS lists. */
async function sameBuild(image: string): Promise<string | undefined> {
  const sums = await Bun.file(`${repo}/dist/bin/SHA256SUMS`)
    .text()
    .catch(() => "");
  const expected = listedSum(sums, glibcBinary);
  if (!expected) {
    return "dist/bin has no SHA256SUMS: run bun run image";
  }
  const copy = (await Bun.$`mktemp`.text()).trim();
  const holder = `raaqeb-bench-copy-${Date.now()}`;
  try {
    await docker(["create", "--name", holder, image]);
    await docker(["cp", `${holder}:/usr/local/bin/raaqeb`, copy]);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(copy).bytes());
    return hasher.digest("hex") === expected
      ? undefined
      : `${image} holds another build than dist/bin: run bun run image`;
  } finally {
    await Bun.$`docker rm -f ${holder}`.nothrow().quiet();
    await Bun.$`rm -f ${copy}`.nothrow().quiet();
  }
}

/** Builds the musl variant's image from `dist/bin`, labelled with the revision measured. */
async function buildMusl(tag: string, revision: string): Promise<void> {
  const context = (await Bun.$`mktemp -d`.text()).trim();
  try {
    await Bun.$`cp ${repo}/dist/bin/${muslBinary} ${context}/`;
    const child = Bun.spawn(
      [
        "docker",
        "build",
        "-q",
        "-t",
        tag,
        "--label",
        `org.opencontainers.image.revision=${revision}`,
        "-f",
        "-",
        context,
      ],
      { stderr: "pipe", stdin: "pipe", stdout: "pipe" }
    );
    child.stdin.write(muslDockerfile(muslBinary));
    await child.stdin.end();
    if ((await child.exited) !== 0) {
      throw new Error(
        `the musl image did not build: ${await new Response(child.stderr).text()}`
      );
    }
  } finally {
    await Bun.$`rm -rf ${context}`.nothrow().quiet();
  }
}

/** What the run measures: its images, the commit they were built from, and whether that tree was dirty; or why it cannot run. */
async function images(
  flags: Flags,
  head: string,
  treeDirty: boolean
): Promise<
  | {
      commit: string;
      dirty: boolean;
      images: Record<Variant, string | undefined>;
      ok: true;
    }
  | { message: string; ok: false }
> {
  const at = await version();
  const wanted = flags.image ?? imageTag(at);
  let commit = head;
  let dirty = treeDirty;
  if (!flags.standIn) {
    if (!(await present(wanted))) {
      return {
        message: `no image ${wanted}: run bun run image, or name one with --image`,
        ok: false,
      };
    }
    const revision = imageRevision(
      await docker([
        "inspect",
        "-f",
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        wanted,
      ])
    );
    if (flags.image === undefined && revision.commit !== head) {
      return {
        message: `${wanted} was built from ${revision.commit}, not this checkout's ${head}: run bun run image`,
        ok: false,
      };
    }
    ({ commit } = revision);
    dirty = revision.dirty || treeDirty;
  }
  const musl = muslImage(at);
  if (flags.variants.includes("musl")) {
    if (!(await Bun.file(`${repo}/dist/bin/${muslBinary}`).exists())) {
      return {
        message: `dist/bin has no ${muslBinary}: run bun run binaries`,
        ok: false,
      };
    }
    if (!flags.standIn) {
      const other = await sameBuild(wanted);
      if (other) {
        return { message: other, ok: false };
      }
    }
    await buildMusl(musl, `${commit}${dirty ? "-dirty" : ""}`);
  }
  const shipped = flags.standIn ? undefined : wanted;
  return {
    commit,
    dirty,
    images: { musl, postgres: shipped, sqlite: shipped },
    ok: true,
  };
}

/** Why this machine cannot run the benchmark, or nothing when it can. */
async function unmet(flags: Flags): Promise<string | undefined> {
  if (!(await Bun.file("/sys/fs/cgroup/cgroup.controllers").exists())) {
    return "the benchmark reads cgroup v2 from the host: Linux only";
  }
  if ((await Bun.$`docker version`.nothrow().quiet()).exitCode !== 0) {
    return "docker does not answer";
  }
  // Pulled before any run, so a pull never lands inside a cold start or a phase.
  for (const image of [
    standInImage,
    ohaImage,
    mailpitImage,
    postgresImage,
    mysqlImage,
    redisImage,
    alpineImage,
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one image at a time
    if (!(await present(image))) {
      return `cannot pull ${image}`;
    }
  }
  if (flags.standIn) {
    say("building the checkout for the stand-in");
    const build = await Bun.$`bun run build`.cwd(repo).nothrow().quiet();
    if (build.exitCode !== 0) {
      return `the build failed:\n${build.stderr.toString()}`;
    }
  }
  return undefined;
}

/** One run: the day beside every variant's fixed run, each on its own core, then SQLite's sweeps alone; the day and the sweeps are left out of a short run. */
async function runOnce(
  invocation: Invocation,
  run: number,
  folder: string
): Promise<RunResult> {
  const { flags } = invocation;
  const startedAt = new Date().toISOString();
  const placement = placementOf(invocation.cores.measured);
  const full = flags.variants.includes("sqlite") && !flags.short;
  const part = (variant: Variant, cpu: number) => ({
    cpu,
    folder,
    invocation,
    run,
    variant,
  });
  const sqlite = part("sqlite", placement.alone);
  say(
    `run ${run}: ${[...(full ? ["the accelerated day"] : []), ...flags.variants.map((variant) => `the ${variant} fixed run`)].join(", ")}, at once`
  );
  const dayRun = full ? runDay(part("sqlite", placement.day)) : null;
  const fixedRuns = flags.variants.map((variant) =>
    runFixed(part(variant, placement.fixed[variant]))
  );
  // Every part ends and cleans up before a failed one fails the block.
  const failed = (await Promise.allSettled([dayRun, ...fixedRuns])).find(
    (each) => each.status === "rejected"
  );
  if (failed) {
    throw failed.reason;
  }
  const day = await dayRun;
  const fixed = await Promise.all(fixedRuns);
  if (full) {
    say(`run ${run}: sqlite, the capacity sweep`);
  }
  const capacity = full ? await runCapacity(sqlite) : null;
  if (full) {
    say(`run ${run}: sqlite, the throughput sweep`);
  }
  const throughput = full ? await runThroughput(sqlite) : null;
  const results: VariantResult[] = flags.variants.flatMap((variant, index) => {
    const own = fixed[index];
    const sqliteOwn = variant === "sqlite";
    return own
      ? [
          {
            capacity: sqliteOwn ? capacity : null,
            day: sqliteOwn ? day : null,
            fixed: own.fixed,
            image: invocation.images[variant] ?? standInImage,
            publicJavaScriptBytes: own.publicJavaScriptBytes,
            publicJavaScriptZstdBytes: own.publicJavaScriptZstdBytes,
            throughput: sqliteOwn ? throughput : null,
            variant,
          },
        ]
      : [];
  });
  const result: RunResult = {
    commit: invocation.commit,
    cores: {
      kind: invocation.cores.kind,
      measured: invocation.cores.measured,
      placement,
    },
    dirty: invocation.dirty,
    flags: {
      dayMonitors: flags.dayMonitors,
      daySeconds: flags.daySeconds,
      idleSeconds: flags.idleSeconds,
      intervalSeconds: flags.intervalSeconds,
      loadSeconds: flags.loadSeconds,
      monitors: flags.monitors,
      rate: flags.rate,
      short: flags.short,
    },
    floor: [],
    machine: invocation.machine,
    schema: resultsSchema,
    standIn: flags.standIn,
    startedAt,
    variants: results,
    wiring: flags.wiring,
  };
  return { ...result, floor: floorBreaks(result) };
}

/** The viewer built into one HTML file, the data still to be written into it. */
async function buildViewer(): Promise<string> {
  const out = (await Bun.$`mktemp -d`.text()).trim();
  try {
    await Bun.$`bun build --compile --target=browser --production ${bench}/report/index.html --outdir=${out}`
      .cwd(repo)
      .quiet();
    return await Bun.file(`${out}/index.html`).text();
  } finally {
    await Bun.$`rm -rf ${out}`.nothrow().quiet();
  }
}

/** The band beside the history, when one is stored. */
async function storedBand(): Promise<NoiseBand | undefined> {
  const file = Bun.file(`${bench}/band.json`);
  return (await file.exists()) ? ((await file.json()) as NoiseBand) : undefined;
}

/** Writes the band of the runs to the folder, and beside the history when it may be stored. */
async function writeBand(
  results: readonly RunResult[],
  folder: string
): Promise<string | undefined> {
  const band = noiseBand(results, new Date().toISOString());
  if (!band.ok) {
    return band.message;
  }
  const text = `${JSON.stringify(band.band, null, 2)}\n`;
  await Bun.write(`${folder}/band.json`, text);
  say(`wrote ${folder}/band.json`);
  if (storable(band.band)) {
    await Bun.write(`${bench}/band.json`, text);
    say(`wrote ${bench}/band.json`);
  }
  return undefined;
}

/** This machine's cores: the efficiency cores for the installs on a hybrid CPU. */
async function readCores(): Promise<
  { cores: Cores; ok: true } | { message: string; ok: false }
> {
  const atom = Bun.file("/sys/devices/cpu_atom/cpus");
  const online = await Bun.file("/sys/devices/system/cpu/online").text();
  const siblings = await Promise.all(
    cpuList(online).map((cpu) =>
      Bun.file(
        `/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`
      )
        .text()
        .catch(() => String(cpu))
    )
  );
  return coresOf({
    atom: (await atom.exists()) ? await atom.text() : undefined,
    online,
    siblings,
  });
}

async function invocationOf(
  flags: Flags,
  cores: Cores,
  previousFit: number | null
): Promise<
  { invocation: Invocation; ok: true } | { message: string; ok: false }
> {
  const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  const status = await Bun.$`git -C ${repo} status --porcelain`.text();
  const measured = await images(flags, head, status.trim() !== "");
  if (!measured.ok) {
    return measured;
  }
  return {
    invocation: {
      bench,
      commit: measured.commit,
      cores,
      dirty: measured.dirty,
      fixtures: `${repo}/src/server/checks/fixtures`,
      flags,
      images: measured.images,
      links: flags.standIn ? await storeLinks() : [],
      machine: await readMachine(),
      previousFit,
      repo,
      stamp: runStamp(new Date()),
      sweeps: sweepLengths(flags.wiring),
      user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    },
    ok: true,
  };
}

/** Runs the benchmark; answers the exit code: 0 done, 1 a run failed, 2 a refused command line. */
export async function main(args: readonly string[]): Promise<number> {
  const parsed = parseFlags(args);
  if (!parsed.ok) {
    fail(parsed.message);
    return 2;
  }
  const { flags } = parsed;
  const problem = await unmet(flags);
  if (problem) {
    fail(problem);
    return 1;
  }
  const cores = await readCores();
  if (!cores.ok) {
    fail(cores.message);
    return 1;
  }
  // The harness seeds and samples on the stand-ins' cores, never beside an install; its children inherit them.
  const pinned =
    await Bun.$`taskset -a -c -p ${cores.cores.standIns} ${process.pid}`
      .nothrow()
      .quiet();
  if (pinned.exitCode !== 0) {
    fail("taskset could not pin the harness to the stand-ins' cores");
    return 1;
  }
  const previous = lastRow(
    await Bun.file(`${bench}/history.jsonl`)
      .text()
      .catch(() => "")
  );
  const prepared = await invocationOf(
    flags,
    cores.cores,
    previous?.monitorsThatFit ?? null
  );
  if (!prepared.ok) {
    fail(prepared.message);
    return 1;
  }
  const { invocation } = prepared;
  const folder = `${bench}/results/${invocation.stamp}`;
  await Bun.$`mkdir -p ${folder}`;
  const viewer = await buildViewer();
  const band = await storedBand();
  const results: RunResult[] = [];
  for (let run = 1; run <= flags.runs; run += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: runs share the machine and must not overlap
      const result = await runOnce(invocation, run, folder);
      results.push(result);
      await Bun.write(
        `${folder}/run-${run}.json`,
        `${JSON.stringify(result, null, 2)}\n`
      );
      await Bun.write(
        `${folder}/run-${run}.html`,
        reportHtml(viewer, { band, previous, result, row: rowValues(result) })
      );
      say(`wrote ${folder}/run-${run}.json and run-${run}.html`);
    } catch (error) {
      fail(
        `run ${run} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return 1;
    }
  }
  const refused =
    results.length > 1 ? await writeBand(results, folder) : undefined;
  if (refused) {
    fail(refused);
    return 1;
  }
  if (flags.wiring || invocation.dirty) {
    say(
      "a wiring run or a dirty tree: these files check the harness; never quote their numbers"
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}

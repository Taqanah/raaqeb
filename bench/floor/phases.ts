/**
 * The parts of one run, each in containers of its own on a network of its
 * own: the fixed run, the accelerated day, the capacity sweep and
 * the throughput sweep. Every part seeds a fresh data directory, starts the
 * stand-ins it needs on the stand-ins' cores, then the install at 240 MB on
 * its one core, samples it from the host, stops it, reads its OOM state and
 * logs before removing it, and reads what it wrote. Parts may run at once,
 * so each owns its containers and its cleanup, and installs start at least
 * `startGapMs` apart. Docker on Linux only; the wiring run is its test.
 */
import {
  generateInstallKey,
  type InstallKey,
  importInstallKey,
} from "@/server/boot/installkey.ts";
import { sealingCutoff } from "@/server/scheduler/schedule.ts";
import { runSql } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  defaultDatabaseLocation,
} from "@/server/storage/storage.ts";
import {
  appArgs,
  appPort,
  containerNames,
  databaseUrls,
  loadArgs,
  mailpitArgs,
  mailpitPorts,
  mysqlArgs,
  type Names,
  partId,
  postgresArgs,
  postgresUrl,
  readinessArgs,
  redisArgs,
  targetArgs,
  targetPort,
  throughputArgs,
} from "./container.ts";
import {
  coldStart,
  containerLog,
  docker,
  oomVerdict,
  sampleHost,
  started,
} from "./docker.ts";
import type { Flags, SweepLengths } from "./flags.ts";
import {
  capacityFleet,
  type FleetMember,
  fixedFleet,
  heartbeatEveryMs,
  type TargetAddress,
} from "./fleet.ts";
import { dayIntervalMs } from "./floor.ts";
import type { Cores, Machine } from "./host.ts";
import {
  atCeiling,
  type CompressedBytes,
  compressedBytes,
  diskPerMonitorDay,
  latenessByMinute,
  latenessOf,
  medianLateness,
  monitorsThatFit,
  nextCapacityCount,
  quarterMeans,
  scriptUrls,
  stepFits,
} from "./measure.ts";
import {
  type CapacityStep,
  type CapacitySweep,
  type ContainerRun,
  type DayRun,
  type FixedRun,
  type HostSample,
  type InsideSample,
  insideSamples,
  type LoadSummary,
  loadSummary,
  type Sends,
  type Span,
  summarizePhase,
  type Throughput,
  type ThroughputPath,
  type Variant,
} from "./results.ts";
import { benchOperator, type Seeded, seedInstall } from "./seed.ts";

/** What every part of one invocation shares. */
export interface Invocation {
  /** The harness folder on the host. */
  readonly bench: string;
  readonly commit: string;
  readonly cores: Cores;
  readonly dirty: boolean;
  /** The fixtures folder holding the test certificate the target serves. */
  readonly fixtures: string;
  readonly flags: Flags;
  /** The image each variant runs; the stand-in when it is `undefined`. */
  readonly images: Readonly<Record<Variant, string | undefined>>;
  readonly links: readonly string[];
  readonly machine: Machine;
  /** The previous release's count that fit, where the capacity sweep starts; nothing with no history. */
  readonly previousFit: number | null;
  /** The checkout's root on the host. */
  readonly repo: string;
  readonly stamp: string;
  readonly sweeps: SweepLengths;
  readonly user: string;
}

/** One part's place in the invocation: the run, the variant, and the folder its logs go to. */
export interface Part {
  /** The one CPU the part's install runs on. */
  readonly cpu: number;
  readonly folder: string;
  readonly invocation: Invocation;
  readonly run: number;
  readonly variant: Variant;
}

/** The capacity sweep's interval: the product's shortest, so the count reads as what an install holds. */
const capacityIntervalMs = 20_000;

/** How long a throughput part waits after its cold start: every first check spread and settled, so the counter is quiet. */
const throughputSettleMs = 45_000;

/** How long the per-change path waits after `/fail` starts failing: the outage opened, the incident in steady state. */
const failSettleMs = 5000;

/** The least time between two installs' starts, so cold starts of parts run at once never meet. */
const startGapMs = 20_000;

/** How long a database server has to take connections before the part fails. */
const readyLimitMs = 120_000;

const dayMs = 86_400_000;

/** A part's containers, network and data directory, and what the seed and the install were given. */
interface Stage {
  readonly dataDir: string;
  /** Boot settings the install gets beyond the harness's own. */
  readonly env: Readonly<Record<string, string>>;
  readonly key: InstallKey;
  /** The database as the host reaches it, for seeding and reading. */
  readonly location: DatabaseLocation;
  /** Mailpit's API on loopback, when the part runs it. */
  readonly mailpit: string | undefined;
  readonly names: Names;
  readonly part: Part;
  /** Settles once every database server the part started takes connections. */
  readonly ready: Promise<void>;
  readonly target: TargetAddress;
  /** The target's HTTP port on loopback, for the sink's count. */
  readonly targetOrigin: string;
}

/** The cleanups of every part under way; parts may run at once. */
const removals = new Set<() => Promise<void>>();

/** Removes every container and network of the parts under way; the interrupt handler calls it. */
export async function removeCurrent(): Promise<void> {
  await Promise.all([...removals].map((removal) => removal()));
}

async function remove(names: Names, dataDir: string): Promise<void> {
  await Bun.$`docker rm -f ${names.load} ${names.app} ${names.target} ${names.mailpit} ${names.postgres} ${names.mysql} ${names.redis}`
    .nothrow()
    .quiet();
  await Bun.$`docker network rm ${names.network}`.nothrow().quiet();
  await Bun.$`rm -rf ${dataDir}`.nothrow().quiet();
}

/** The loopback origin Docker publishes a container's port at. */
async function published(name: string, port: number): Promise<string> {
  const [line] = (await docker(["port", name, String(port)])).split("\n");
  return `http://${line}`;
}

/** Polls each database server until it takes connections over TCP; throws past the limit, and stops once `ended` says its part is over. */
async function databasesReady(
  names: Names,
  ended: () => boolean
): Promise<void> {
  const deadline = Date.now() + readyLimitMs;
  await Promise.all(
    readinessArgs(names).map(async (args) => {
      // A part that ended before its install started leaves no polls behind on the machine the others measure on.
      while (
        !(
          ended() ||
          // biome-ignore lint/performance/noAwaitInLoops: each poll waits for the one before it
          (await docker(args).then(
            () => true,
            () => false
          ))
        )
      ) {
        if (Date.now() > deadline) {
          throw new Error(
            `${args[1]} took no connection in ${readyLimitMs} ms`
          );
        }
        await Bun.sleep(500);
      }
    })
  );
}

/** What a part needs beside the target: Mailpit for the email channel, the database servers for the database monitors. */
interface Needs {
  readonly databases: boolean;
  readonly mail: boolean;
}

/** Runs one part's work over a fresh network, target, database and data directory, removing them all after. */
async function staged<T>(
  part: Part,
  label: string,
  needs: Needs,
  work: (stage: Stage) => Promise<T>
): Promise<T> {
  const { invocation } = part;
  const names = containerNames(
    partId(invocation.stamp, part.run, part.variant, label)
  );
  // On disk beside the results, never under /tmp: a tmpfs page the install writes is charged to its memory and cannot be reclaimed.
  await Bun.$`mkdir -p ${invocation.bench}/results`;
  const dataDir = (
    await Bun.$`mktemp -d -p ${invocation.bench}/results .data-XXXXXX`.text()
  ).trim();
  let ended = false;
  const removal = () => remove(names, dataDir);
  removals.add(removal);
  try {
    await docker(["network", "create", names.network]);
    const cpus = invocation.cores.standIns;
    await docker(
      targetArgs(names, invocation.bench, invocation.fixtures, cpus)
    );
    const ip = await docker([
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      names.target,
    ]);
    const postgres = part.variant === "postgres";
    if (postgres || needs.databases) {
      await docker(postgresArgs(names, cpus));
    }
    if (needs.databases) {
      await docker(mysqlArgs(names, cpus));
      await docker(redisArgs(names, cpus));
    }
    // Waited for by the install's start, so seeding runs while the servers boot.
    const ready = needs.databases
      ? databasesReady(names, () => ended)
      : Promise.resolve();
    ready.catch(() => undefined);
    let location: DatabaseLocation = defaultDatabaseLocation(dataDir);
    if (postgres) {
      const origin = await published(names.postgres, 5432);
      location = {
        backend: "postgres",
        url: `postgres://raaqeb:raaqeb@${origin.slice("http://".length)}/raaqeb`,
      };
    }
    if (needs.mail) {
      await docker(mailpitArgs(names, cpus));
    }
    const keyText = generateInstallKey();
    const key = await importInstallKey(keyText);
    if (!key) {
      throw new Error("a generated install key did not import");
    }
    return await work({
      dataDir,
      env: {
        RAAQEB_SECRET_KEY: keyText,
        ...(postgres ? { DATABASE_URL: postgresUrl(names) } : {}),
      },
      key,
      location,
      mailpit: needs.mail
        ? await published(names.mailpit, mailpitPorts.api)
        : undefined,
      names,
      part,
      ready,
      target: { host: names.target, ip },
      targetOrigin: await published(names.target, targetPort),
    });
  } finally {
    ended = true;
    await removal();
    removals.delete(removal);
  }
}

/** A started install: its origin on loopback and its cold start. */
interface Running {
  readonly coldStartMs: number | null;
  readonly host: ReturnType<typeof sampleHost>;
  readonly origin: string;
  /** Stops sending heartbeats. */
  readonly quiet: () => void;
}

/** When the next install may start. */
let nextStartAt = 0;

/** Waits for this install's turn to start, `startGapMs` after the one before. */
async function startTurn(): Promise<void> {
  const at = Math.max(Date.now(), nextStartAt);
  nextStartAt = at + startGapMs;
  await Bun.sleep(at - Date.now());
}

/** Starts the install over the seeded database, samples it from the host, waits for its first 200, and sends the heartbeat monitors theirs. */
async function startApp(stage: Stage, seeded: Seeded): Promise<Running> {
  const { invocation, variant } = stage.part;
  await stage.ready;
  await startTurn();
  await docker(
    appArgs({
      bench: invocation.bench,
      cpu: stage.part.cpu,
      dataDir: stage.dataDir,
      env: stage.env,
      image: invocation.images[variant],
      links: invocation.links,
      names: stage.names,
      passThrough: invocation.flags.passThrough,
      repo: invocation.repo,
      user: invocation.user,
    })
  );
  const app = await started(stage.names.app, appPort);
  const host = sampleHost(app.directory, app.pid);
  const coldStartMs = await coldStart(app.origin, app.startedAt);
  // Every heartbeat monitor hears one twice per period, so none goes late.
  const beat = () => {
    for (const token of seeded.heartbeatTokens) {
      fetch(`${app.origin}/api/heartbeat/${token}`).catch(() => undefined);
    }
  };
  beat();
  const timer = setInterval(beat, heartbeatEveryMs / 2);
  return {
    coldStartMs,
    host,
    origin: app.origin,
    quiet: () => clearInterval(timer),
  };
}

/** What a stopped install leaves: everything a container run reports. */
interface Stopped extends ContainerRun {
  readonly hostSamples: readonly HostSample[];
  readonly inside: readonly InsideSample[];
}

/** Stops the install, reads its OOM state and logs before anything removes it, and writes the log beside the results. */
async function stopApp(
  stage: Stage,
  running: Running,
  label: string
): Promise<Stopped> {
  running.quiet();
  const samples = await running.host.stop();
  await Bun.$`docker stop -t 10 ${stage.names.app}`.nothrow().quiet();
  const { exitCode, oom } = await oomVerdict(stage.names.app, samples);
  const log = await containerLog(stage.names.app);
  const { folder, run, variant } = stage.part;
  await Bun.write(`${folder}/run-${run}-${variant}-${label}.log`, log);
  const inside = insideSamples(log);
  const peaks = samples.map((sample) => sample.memoryPeak);
  return {
    coldStartMs: running.coldStartMs,
    exitCode,
    hostSamples: samples,
    inside,
    memoryPeak: peaks.length === 0 ? null : Math.max(...peaks),
    oom,
    samples: { host: samples, inside },
  };
}

/** The part's container run, without the copies of its samples kept for reading. */
function containerRun(stopped: Stopped): ContainerRun {
  return {
    coldStartMs: stopped.coldStartMs,
    exitCode: stopped.exitCode,
    memoryPeak: stopped.memoryPeak,
    oom: stopped.oom,
    samples: stopped.samples,
  };
}

/** The checks' start times in a span, of the monitors that run at one interval, in the scheduler's list order. */
async function startedChecks(
  stage: Stage,
  monitorIds: readonly string[],
  from: number,
  to: number
) {
  const rows = await runSql(
    stage.location,
    "SELECT monitor_id, started_at FROM checks WHERE started_at >= ? AND started_at < ?",
    [from, to]
  );
  const wanted = new Set(monitorIds);
  return rows
    .map((row) => ({
      monitorId: String(row.monitor_id),
      startedAt: Number(row.started_at),
    }))
    .filter((row) => wanted.has(row.monitorId));
}

/** The ids of the members that run at the fleet's interval, in creation order. The scheduler spreads a failing member's first run too, so a part that judges lateness must not hold one; none does. */
function onInterval(fleet: readonly FleetMember[], seeded: Seeded): string[] {
  return seeded.monitorIds.filter((_, index) => {
    const role = fleet[index]?.role;
    return role !== "heartbeat" && role !== "fail";
  });
}

/** What the stand-ins received; `null` for one that could not be asked. */
async function sends(stage: Stage): Promise<Sends> {
  const count = async (url: string, key: string): Promise<number | null> => {
    try {
      const body: unknown = await (await fetch(url)).json();
      const value =
        typeof body === "object" && body !== null
          ? Object.entries(body).find(([name]) => name === key)?.[1]
          : undefined;
      return typeof value === "number" ? value : null;
    } catch {
      return null;
    }
  };
  return {
    email: stage.mailpit
      ? await count(`${stage.mailpit}/api/v1/messages?limit=1`, "total")
      : null,
    webhook: await count(`${stage.targetOrigin}/sink`, "received"),
  };
}

/** Every same-origin script the public page at `/` loads, compressed with gzip and with zstd; nothing when the page does not answer. */
async function publicJavaScript(
  origin: string
): Promise<CompressedBytes | null> {
  try {
    const html = await (await fetch(`${origin}/`)).text();
    const urls = scriptUrls(html);
    if (urls.length === 0) {
      return null;
    }
    const scripts = await Promise.all(
      urls.map(async (url) => await (await fetch(`${origin}${url}`)).bytes())
    );
    return compressedBytes(scripts);
  } catch {
    return null;
  }
}

/** `oha`'s run, read; nothing when it failed or wrote something else. */
async function oha(args: readonly string[]): Promise<LoadSummary | null> {
  return await docker(args).then(
    (output) => loadSummary(JSON.parse(output)) ?? null,
    () => null
  );
}

/** Bytes in a SQLite install's data directory; nothing on Postgres. */
async function dataBytes(stage: Stage): Promise<number | null> {
  if (stage.location.backend !== "sqlite") {
    return null;
  }
  const text = await Bun.$`du -sb ${stage.dataDir}`.nothrow().quiet().text();
  return Number(text.split("\t")[0]) || null;
}

/** The fixed run, and the public page's JavaScript read while it runs. */
export function runFixed(part: Part): Promise<{
  fixed: FixedRun;
  publicJavaScriptBytes: number | null;
  publicJavaScriptZstdBytes: number | null;
}> {
  const { flags } = part.invocation;
  return staged(
    part,
    "fixed",
    { databases: true, mail: true },
    async (stage) => {
      const fleet = fixedFleet({
        failing: false,
        intervalMs: flags.intervalSeconds * 1000,
        databases: databaseUrls(stage.names),
        monitors: flags.monitors,
        quiet: false,
        target: stage.target,
      });
      const seeded = await seedInstall(stage.location, {
        channels: {
          smtpHost: stage.names.mailpit,
          smtpPort: mailpitPorts.smtp,
          webhookUrl: `http://${stage.names.target}:${targetPort}/sink`,
        },
        draftPage: false,
        fleet,
        history: undefined,
        incidents: true,
        key: stage.key,
      });
      const running = await startApp(stage, seeded);
      // Read before the idle phase, so its requests are not the idle phase's.
      const publicJavaScriptSize = await publicJavaScript(running.origin);
      const idleFrom = Date.now();
      await Bun.sleep(flags.idleSeconds * 1000);
      const loadFrom = Date.now();
      const load = await oha(
        loadArgs(
          stage.names,
          flags.loadSeconds,
          flags.rate,
          part.invocation.cores.standIns
        )
      );
      const loadTo = Date.now();
      const stopped = await stopApp(stage, running, "fixed");
      const intervalMs = flags.intervalSeconds * 1000;
      const order = onInterval(fleet, seeded);
      const rows = await startedChecks(stage, order, 0, loadTo);
      return {
        fixed: {
          ...containerRun(stopped),
          dataBytes: await dataBytes(stage),
          lateness: latenessByMinute(
            latenessOf(rows, order, intervalMs),
            idleFrom,
            loadTo,
            intervalMs
          ),
          load,
          phases: {
            idle: summarizePhase(
              { from: idleFrom, to: loadFrom },
              stopped.hostSamples,
              stopped.inside
            ),
            load: summarizePhase(
              { from: loadFrom, to: loadTo },
              stopped.hostSamples,
              stopped.inside
            ),
          },
          sends: await sends(stage),
        },
        publicJavaScriptBytes: publicJavaScriptSize?.gzip ?? null,
        publicJavaScriptZstdBytes: publicJavaScriptSize?.zstd ?? null,
      };
    }
  );
}

/** The accelerated day over a seeded yesterday. */
export function runDay(part: Part): Promise<DayRun> {
  const { flags } = part.invocation;
  return staged(part, "day", { databases: true, mail: true }, async (stage) => {
    const fleet = fixedFleet({
      databases: databaseUrls(stage.names),
      failing: false,
      intervalMs: dayIntervalMs,
      monitors: flags.dayMonitors,
      quiet: false,
      target: stage.target,
    });
    // The last closed day the nightly job may seal now, so the install seals it as it starts.
    const yesterday = sealingCutoff(Date.now()) - dayMs;
    const seeded = await seedInstall(stage.location, {
      channels: {
        smtpHost: stage.names.mailpit,
        smtpPort: mailpitPorts.smtp,
        webhookUrl: `http://${stage.names.target}:${targetPort}/sink`,
      },
      draftPage: false,
      fleet,
      history: {
        dayStart: yesterday,
        intervalMs: capacityIntervalMs,
        // Yesterday as the fixed run's install would hold it; the day's larger fleet would only lengthen the seeding.
        monitors: flags.monitors,
      },
      incidents: true,
      key: stage.key,
    });
    const running = await startApp(stage, seeded);
    const from = Date.now();
    await Bun.sleep(flags.daySeconds * 1000);
    const to = Date.now();
    const stopped = await stopApp(stage, running, "day");
    const order = onInterval(fleet, seeded);
    // ponytail: a day that crosses 00:15 UTC has its own first rows sealed out of the head table, which this read misses; start a release run away from midnight.
    const rows = await startedChecks(stage, order, yesterday + dayMs, to);
    const sealed = await runSql(
      stage.location,
      "SELECT COUNT(*) AS days FROM sealed_days WHERE day = ?",
      [yesterday]
    );
    const sealedMonitorDays = Number(sealed[0]?.days ?? 0);
    const tables =
      stage.location.backend === "sqlite"
        ? (
            await runSql(
              stage.location,
              "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name"
            )
          ).map((row) => ({ bytes: Number(row.bytes), name: String(row.name) }))
        : [];
    return {
      ...containerRun(stopped),
      checks: rows.filter((row) => row.startedAt >= from).length,
      diskBytesPerMonitorPerDay: diskPerMonitorDay(tables, sealedMonitorDays),
      lateness: latenessByMinute(
        latenessOf(rows, order, dayIntervalMs),
        from,
        to,
        dayIntervalMs
      ),
      phase: summarizePhase({ from, to }, stopped.hostSamples, stopped.inside),
      quarters: quarterMeans(
        stopped.hostSamples.flatMap((sample) =>
          sample.vmRss === null ? [] : [{ at: sample.at, value: sample.vmRss }]
        ),
        from,
        to
      ),
      sealedMonitorDays,
      sends: await sends(stage),
    };
  });
}

/** One count of the capacity sweep: fits when the container lived and the median lateness over its measured span stayed within one interval and one tick. */
function capacityStep(part: Part, monitors: number): Promise<CapacityStep> {
  const { sweeps } = part.invocation;
  return staged(
    part,
    `capacity-${monitors}`,
    { databases: false, mail: false },
    async (stage) => {
      const fleet = capacityFleet(monitors, capacityIntervalMs, stage.target);
      const seeded = await seedInstall(stage.location, {
        channels: undefined,
        draftPage: false,
        fleet,
        history: undefined,
        incidents: false,
        key: stage.key,
      });
      const running = await startApp(stage, seeded).catch(() => undefined);
      if (!running) {
        // The install died before the host could read it, the likeliest sign of a kill at the limit.
        const { oom } = await oomVerdict(stage.names.app, []);
        return {
          cpuShare: null,
          fits: false,
          medianLatenessMs: null,
          memoryPeak: null,
          monitors,
          oom,
          vmRssMax: null,
        };
      }
      await Bun.sleep((sweeps.capacityWarm + sweeps.capacityMeasure) * 1000);
      const to = Date.now();
      const stopped = await stopApp(stage, running, `capacity-${monitors}`);
      const order = onInterval(fleet, seeded);
      const rows = await startedChecks(stage, order, 0, to);
      const medianLatenessMs = medianLateness(
        latenessOf(rows, order, capacityIntervalMs),
        to - sweeps.capacityMeasure * 1000,
        to
      );
      const rss = stopped.hostSamples.flatMap((sample) =>
        sample.vmRss === null ? [] : [sample.vmRss]
      );
      const measured = { from: to - sweeps.capacityMeasure * 1000, to };
      return {
        cpuShare: summarizePhase(measured, stopped.hostSamples, []).cpuShare,
        fits: stepFits(
          {
            coldStartMs: running.coldStartMs,
            medianLatenessMs,
            oom: stopped.oom,
          },
          capacityIntervalMs
        ),
        medianLatenessMs,
        memoryPeak: stopped.memoryPeak,
        monitors,
        oom: stopped.oom,
        vmRssMax: rss.length === 0 ? null : Math.max(...rss),
      };
    }
  );
}

/** The capacity sweep from the previous release's count, or its own first: doubling while counts fit, halving while none does. */
export async function runCapacity(part: Part): Promise<CapacitySweep> {
  const { flags, previousFit, sweeps } = part.invocation;
  const bounds = {
    ceiling: sweeps.capacityMonitors,
    // A wiring run stays small whatever the history says.
    first: flags.wiring
      ? sweeps.capacityFirst
      : (previousFit ?? sweeps.capacityFirst),
    floor: flags.monitors,
  };
  const steps: CapacityStep[] = [];
  for (
    let monitors = nextCapacityCount(steps, bounds);
    monitors !== undefined;
    monitors = nextCapacityCount(steps, bounds)
  ) {
    // biome-ignore lint/performance/noAwaitInLoops: each count waits for the one before it, and decides the next
    steps.push(await capacityStep(part, monitors));
  }
  return {
    atCeiling: atCeiling(steps, sweeps.capacityMonitors),
    intervalSeconds: capacityIntervalMs / 1000,
    monitorsThatFit: monitorsThatFit(steps),
    steps,
  };
}

/** The operator's session cookie, signed in over HTTP as a browser would; nothing when sign-in did not answer. */
async function signIn(origin: string): Promise<string | undefined> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    body: JSON.stringify(benchOperator),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }).catch(() => undefined);
  const cookies = response?.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return response?.ok && cookies ? cookies : undefined;
}

/** The throughput sweep of the public page's four paths, in one install: the quiet paths first, then the incident `/fail` starts. */
export function runThroughput(part: Part): Promise<Throughput> {
  const { flags, sweeps } = part.invocation;
  const seconds = sweeps.throughput;
  const cpus = part.invocation.cores.standIns;
  return staged(
    part,
    "throughput",
    { databases: true, mail: false },
    async (stage) => {
      const path = (url: string, headers: readonly string[] = []) =>
        throughputArgs(stage.names, url, seconds, headers, cpus);
      const fleet = fixedFleet({
        databases: databaseUrls(stage.names),
        failing: true,
        intervalMs: capacityIntervalMs,
        monitors: flags.monitors,
        quiet: true,
        target: stage.target,
      });
      const seeded = await seedInstall(stage.location, {
        channels: undefined,
        draftPage: true,
        fleet,
        history: undefined,
        incidents: true,
        key: stage.key,
      });
      const running = await startApp(stage, seeded);
      await Bun.sleep(throughputSettleMs);
      // Each path's span runs from oha's start to its end, so its container's start and stop add about a second to the load.
      const spans: Partial<Record<ThroughputPath, Span>> = {};
      const held = async (
        name: ThroughputPath,
        args: string[]
      ): Promise<LoadSummary | null> => {
        const from = Date.now();
        const load = await oha(args);
        // A path oha did not report has no load to set the install's CPU beside.
        if (load) {
          spans[name] = { from, to: Date.now() };
        }
        return load;
      };
      const hit = await held("hit", path("/"));
      const document = `/api/pages/${seeded.pageId}/overview`;
      const etag = (await fetch(`${running.origin}${document}`)).headers.get(
        "etag"
      );
      const notModified = etag
        ? await held("notModified", path(document, [`If-None-Match: ${etag}`]))
        : null;
      const cookie = await signIn(running.origin);
      const uncached =
        cookie && seeded.draftPath
          ? await held(
              "uncached",
              path(seeded.draftPath, [`Cookie: ${cookie}`])
            )
          : null;
      // A switch the target did not take would measure the quiet page as the incident's.
      const switched = await fetch(`${stage.targetOrigin}/fail`, {
        method: "POST",
      }).then(
        (response) => response.ok,
        () => false
      );
      await Bun.sleep(failSettleMs);
      const perChange = switched ? await held("perChange", path("/")) : null;
      const stopped = await stopApp(stage, running, "throughput");
      const share = (name: ThroughputPath) => {
        const span = spans[name];
        return span
          ? summarizePhase(span, stopped.hostSamples, []).cpuShare
          : null;
      };
      return {
        cpuShare: {
          hit: share("hit"),
          notModified: share("notModified"),
          perChange: share("perChange"),
          uncached: share("uncached"),
        },
        memoryPeak: stopped.memoryPeak,
        oom: stopped.oom,
        paths: { hit, notModified, perChange, uncached },
        seconds,
      };
    }
  );
}

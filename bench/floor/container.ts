/**
 * The containers of one run, as `docker` arguments: the install
 * at `--memory=240m --cpus=1` with the sampler preloaded, the synthetic
 * target, and `oha` holding one arrival rate against the install, all on a
 * network of their own. With `--stand-in` the install runs in a stand-in:
 * the pinned Bun image running this checkout's built entry over its build,
 * sources and dependencies, mounted read-only. Without it the shipped image
 * (`bun run image`) is the default.
 */

import { type DatabaseUrls, targetPorts } from "./fleet.ts";

/** The stand-in: the Bun release the repo pins, on Debian slim. */
export const standInImage = "oven/bun:1.4.3-slim";

/** The load generator, pinned exactly. */
export const ohaImage = "ghcr.io/hatoo/oha:1.16.0";

/** The port the install listens on inside the network. */
export const appPort = 3000;

/** The port the synthetic target listens on. */
export const targetPort = targetPorts.http;

/** The sampler's interval inside the install. */
export const sampleEveryMs = 2000;

/** What the load phase requests: the default status page at the bare host, answered from the memo. */
export const loadPath = "/";

/** Where the harness folder is mounted in the install's and the target's containers. */
export const benchMount = "/bench";

/** The names of one run's network and containers. */
export interface Names {
  readonly app: string;
  /** The `oha` container, named so an interrupted run can remove it before its network. */
  readonly load: string;
  readonly mailpit: string;
  /** The MySQL server the database monitors check. */
  readonly mysql: string;
  readonly network: string;
  /** The install's database in the Postgres variant, and the server the Postgres monitors check in every variant. */
  readonly postgres: string;
  /** The Redis server the database monitors check. */
  readonly redis: string;
  readonly target: string;
}

/** The install's container. */
export interface AppOptions {
  /** The harness folder on the host, mounted read-only for the sampler. */
  readonly bench: string;
  /** The one CPU the install runs on. */
  readonly cpu: number;
  /** The data directory on the host, seeded before the start. */
  readonly dataDir: string;
  /** Boot settings beyond the harness's own: the install key, a Postgres URL. */
  readonly env: Readonly<Record<string, string>>;
  /** A shipped image to measure; none means the stand-in. */
  readonly image: string | undefined;
  /** Directories outside the checkout that `node_modules` links into (Bun's isolated store). */
  readonly links: readonly string[];
  readonly names: Names;
  readonly passThrough: readonly string[];
  /** The checkout's root on the host. */
  readonly repo: string;
  /** `uid:gid` on the host, so the harness can delete what the install writes. */
  readonly user: string;
}

/** A run's stamp from its start: UTC to the second, sorting in time order, usable in a Docker name. */
export function runStamp(now: Date): string {
  return `${now.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

/** The directories that the absolute links of a `find -printf %l` listing point into, each once. */
export function linkDirectories(listing: string): string[] {
  const directories = listing
    .split("\n")
    .filter((target) => target.startsWith("/"))
    .map((target) => target.slice(0, target.lastIndexOf("/")));
  return [...new Set(directories)];
}

/** The id of one part's containers: short enough that the longest name stays one DNS label (63 characters), which a monitor's URL names. */
export function partId(
  stamp: string,
  run: number,
  variant: string,
  label: string
): string {
  // The stamp without separators and the variant's initial keep the longest name, Postgres's, within one label.
  return `${stamp.replaceAll("-", "")}-${run}-${variant.slice(0, 1)}-${label}`;
}

/** The names of a run, from an id unique on this machine. */
export function containerNames(runId: string): Names {
  return {
    app: `raaqeb-bench-app-${runId}`,
    load: `raaqeb-bench-load-${runId}`,
    mailpit: `raaqeb-bench-mailpit-${runId}`,
    mysql: `raaqeb-bench-mysql-${runId}`,
    network: `raaqeb-bench-${runId}`,
    postgres: `raaqeb-bench-postgres-${runId}`,
    redis: `raaqeb-bench-redis-${runId}`,
    target: `raaqeb-bench-target-${runId}`,
  };
}

/** The parts of the checkout the stand-in runs from. */
const checkoutParts = [
  "dist",
  "src",
  "node_modules",
  "package.json",
  "bunfig.toml",
  "tsconfig.json",
] as const;

/** `docker run` arguments of the install, detached, its port published on loopback for the harness. */
export function appArgs(options: AppOptions): string[] {
  const { image, names, repo } = options;
  const standIn =
    image === undefined
      ? [
          ...checkoutParts.flatMap((part) => [
            "-v",
            `${repo}/${part}:/app/${part}:ro`,
          ]),
          ...options.links.flatMap((link) => ["-v", `${link}:${link}:ro`]),
          "-w",
          "/app",
        ]
      : [];
  const entry =
    image === undefined
      ? [standInImage, "bun", "dist/server/server.js", "serve"]
      : [image];
  return [
    "run",
    "-d",
    "--name",
    names.app,
    "--network",
    names.network,
    "--memory=240m",
    "--memory-swap=240m",
    "--cpus=1",
    "--cpuset-cpus",
    String(options.cpu),
    "--user",
    options.user,
    "-p",
    `127.0.0.1::${appPort}`,
    "-e",
    "RAAQEB_DATA_DIR=/data",
    "-e",
    "RAAQEB_HOST=0.0.0.0",
    "-e",
    `RAAQEB_PORT=${appPort}`,
    "-e",
    `RAAQEB_BENCH_SAMPLE_MS=${sampleEveryMs}`,
    "-e",
    `BUN_OPTIONS=--preload ${benchMount}/sampler.ts`,
    ...Object.entries(options.env).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]),
    "-v",
    `${options.dataDir}:/data`,
    "-v",
    `${options.bench}:${benchMount}:ro`,
    ...standIn,
    ...entry,
    ...options.passThrough,
  ];
}

/** `docker run` arguments of the synthetic target, with the test certificate mounted and its HTTP port published on loopback for the sink's count. */
export function targetArgs(
  names: Names,
  bench: string,
  fixtures: string,
  cpus: string
): string[] {
  return [
    "run",
    "-d",
    "--name",
    names.target,
    "--network",
    names.network,
    "--cpuset-cpus",
    cpus,
    "-p",
    `127.0.0.1::${targetPort}`,
    "-v",
    `${bench}:${benchMount}:ro`,
    "-v",
    `${fixtures}:${fixturesMount}:ro`,
    standInImage,
    "bun",
    `${benchMount}/target.ts`,
  ];
}

/** The URL the seeded monitors check. */
export function targetUrl(names: Names): string {
  return `http://${names.target}:${targetPort}/`;
}

/** `docker run` arguments of `oha` for the load phase; it writes its JSON to standard output. */
export function loadArgs(
  names: Names,
  seconds: number,
  rate: number,
  cpus: string
): string[] {
  return [
    "run",
    "--rm",
    "--name",
    names.load,
    "--network",
    names.network,
    "--cpuset-cpus",
    cpus,
    ohaImage,
    "-z",
    `${seconds}s`,
    "-q",
    String(rate),
    "--latency-correction",
    "-w",
    "--no-tui",
    "--output-format",
    "json",
    `http://${names.app}:${appPort}${loadPath}`,
  ];
}

/** The suffix `bun run image` gives a revision built from a tree with changes. */
const dirtySuffix = "-dirty";

/** The connections `oha` holds open on a throughput path: enough to keep one CPU busy. */
const throughputConnections = 16;

/** Mailpit, the email channel's sink, pinned as in the test compose file. */
export const mailpitImage = "axllent/mailpit:v1.31.2";

/** Postgres for the second database variant, pinned as in the test compose file. */
export const postgresImage = "postgres:18.6-alpine";

/** The Alpine release the musl variant runs on, as the installer's check does. */
export const alpineImage = "alpine:3.22";

/** Mailpit's SMTP port and its API's. */
export const mailpitPorts = { api: 8025, smtp: 1025 } as const;

/** Where the committed self-signed test certificate is mounted in the target's container. */
export const fixturesMount = "/fixtures";

/** The binaries of the host's architecture in `dist/bin`: the glibc one the shipped image holds and the musl one the musl variant runs. */
export function binaryNames(arch: string): {
  readonly glibc: string;
  readonly musl: string;
} {
  return {
    glibc: `raaqeb-linux-${arch}`,
    musl: `raaqeb-linux-${arch}-musl`,
  };
}

/** The image the harness builds for the musl variant from a version's musl binary. */
export function muslImage(version: string): string {
  return `raaqeb-bench-musl:${version}`;
}

/** The musl variant's Dockerfile: Alpine with the two libraries the musl binary links, and the binary from the build context. */
export function muslDockerfile(binary: string): string {
  return [
    `FROM ${alpineImage}`,
    "RUN apk add --no-cache libstdc++ libgcc",
    `COPY ${binary} /usr/local/bin/raaqeb`,
    'ENTRYPOINT ["/usr/local/bin/raaqeb"]',
    'CMD ["serve"]',
    "",
  ].join("\n");
}

/** The commit an image's revision label names, and whether its tree was dirty. */
export function imageRevision(label: string): {
  readonly commit: string;
  readonly dirty: boolean;
} {
  // `docker inspect` prints "<no value>" for a label the image lacks.
  if (label === "" || label === "<no value>") {
    return { commit: "unknown", dirty: false };
  }
  const dirty = label.endsWith(dirtySuffix);
  return {
    commit: dirty ? label.slice(0, -dirtySuffix.length) : label,
    dirty,
  };
}

/** `docker run` arguments of Mailpit, its API published on loopback for the harness. */
export function mailpitArgs(names: Names, cpus: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    names.mailpit,
    "--network",
    names.network,
    "--cpuset-cpus",
    cpus,
    "-e",
    "MP_SMTP_AUTH_ACCEPT_ANY=1",
    "-e",
    "MP_SMTP_AUTH_ALLOW_INSECURE=1",
    "-p",
    `127.0.0.1::${mailpitPorts.api}`,
    mailpitImage,
  ];
}

/** `docker run` arguments of Postgres on tmpfs, its port published on loopback for seeding. */
export function postgresArgs(names: Names, cpus: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    names.postgres,
    "--network",
    names.network,
    "--cpuset-cpus",
    cpus,
    "--tmpfs",
    "/var/lib/postgresql",
    "-e",
    "POSTGRES_USER=raaqeb",
    "-e",
    "POSTGRES_PASSWORD=raaqeb",
    "-e",
    "POSTGRES_DB=raaqeb",
    "-p",
    "127.0.0.1::5432",
    postgresImage,
  ];
}

/** The Postgres URL the install connects with on the run's network. */
export function postgresUrl(names: Names): string {
  return `postgres://raaqeb:raaqeb@${names.postgres}:5432/raaqeb`;
}

/** `docker run` arguments of `oha` for a throughput path: as many requests as it answers over a fixed count of connections, with the path's headers. */
export function throughputArgs(
  names: Names,
  path: string,
  seconds: number,
  headers: readonly string[],
  cpus: string
): string[] {
  return [
    "run",
    "--rm",
    "--name",
    names.load,
    "--network",
    names.network,
    "--cpuset-cpus",
    cpus,
    ohaImage,
    "-z",
    `${seconds}s`,
    "-c",
    String(throughputConnections),
    ...headers.flatMap((header) => ["-H", header]),
    "-w",
    "--no-tui",
    "--output-format",
    "json",
    `http://${names.app}:${appPort}${path}`,
  ];
}

/** The one password of every database server a run starts; nothing outside the run's network reaches them. */
const databasePassword = "raaqeb";

/** MySQL and Redis for the database monitors, pinned as in the test compose file. */
export const mysqlImage = "mysql:8.4.11";
export const redisImage = "redis:8.10.2-alpine";

/** `docker run` arguments of MySQL on tmpfs, reached by name on the run's network. */
export function mysqlArgs(names: Names, cpus: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    names.mysql,
    "--network",
    names.network,
    "--cpuset-cpus",
    cpus,
    "--tmpfs",
    "/var/lib/mysql",
    "-e",
    `MYSQL_ROOT_PASSWORD=${databasePassword}`,
    "-e",
    "MYSQL_DATABASE=raaqeb",
    "-e",
    "MYSQL_USER=raaqeb",
    "-e",
    `MYSQL_PASSWORD=${databasePassword}`,
    mysqlImage,
  ];
}

/** `docker run` arguments of Redis with a password and nothing written to disk. */
export function redisArgs(names: Names, cpus: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    names.redis,
    "--network",
    names.network,
    "--cpuset-cpus",
    cpus,
    redisImage,
    "redis-server",
    "--requirepass",
    databasePassword,
    "--save",
    "",
    "--appendonly",
    "no",
  ];
}

/** The URLs the database monitors connect with, each server by its name on the run's network. */
export function databaseUrls(names: Names): DatabaseUrls {
  return {
    // MySQL 8.4 signs in over TLS or not at all for a client that will not fetch its RSA key, as Bun will not.
    mysql: `mysql://raaqeb:${databasePassword}@${names.mysql}:3306/raaqeb?sslmode=require`,
    postgres: postgresUrl(names),
    redis: `redis://:${databasePassword}@${names.redis}:6379`,
  };
}

/** One `docker exec` per database server that exits 0 once the server takes connections over TCP. */
export function readinessArgs(names: Names): string[][] {
  // Each image's init runs a first server on the socket alone, so only TCP proves the real one is up.
  return [
    ["exec", names.postgres, "pg_isready", "-h", "127.0.0.1", "-U", "raaqeb"],
    [
      "exec",
      names.mysql,
      "mysqladmin",
      "ping",
      "-h",
      "127.0.0.1",
      "-u",
      "raaqeb",
      `-p${databasePassword}`,
      "--silent",
    ],
    [
      "exec",
      names.redis,
      "redis-cli",
      "-a",
      databasePassword,
      "--no-auth-warning",
      "ping",
    ],
  ];
}

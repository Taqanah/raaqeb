import { describe, expect, test } from "bun:test";
import { connectionUrlFits } from "@/shared/schemas/monitor.ts";
import {
  type AppOptions,
  alpineImage,
  appArgs,
  appPort,
  binaryNames,
  containerNames,
  databaseUrls,
  imageRevision,
  linkDirectories,
  loadArgs,
  loadPath,
  mailpitArgs,
  mailpitImage,
  mailpitPorts,
  muslDockerfile,
  muslImage,
  mysqlArgs,
  mysqlImage,
  ohaImage,
  partId,
  postgresArgs,
  postgresImage,
  postgresUrl,
  readinessArgs,
  redisArgs,
  redisImage,
  runStamp,
  sampleEveryMs,
  standInImage,
  targetArgs,
  targetPort,
  targetUrl,
  throughputArgs,
} from "./container.ts";
import { targetPorts } from "./fleet.ts";

const names = containerNames("20260923-101500-1");

/** The names Docker accepts for a container or a network. */
const dockerName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The performance cores the stand-ins run on. */
const cpus = "0-11";

const standIn: AppOptions = {
  bench: "/home/op/raaqeb/bench/floor",
  cpu: 14,
  dataDir: "/tmp/tmp.abc/data",
  env: {},
  image: undefined,
  links: ["/home/op/.bun/install/cache/links"],
  names,
  passThrough: [],
  repo: "/home/op/raaqeb",
  user: "1000:1000",
};

/** Every value that follows `flag` in `args`. */
function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag ? [args[index + 1] ?? ""] : []
  );
}

describe("the install's container", () => {
  test("is held to 240 MB with no swap and one CPU", () => {
    const args = appArgs(standIn);
    expect(args).toContain("--memory=240m");
    expect(args).toContain("--memory-swap=240m");
    expect(args).toContain("--cpus=1");
  });

  test("runs on its one CPU alone", () => {
    expect(valuesOf(appArgs(standIn), "--cpuset-cpus")).toEqual(["14"]);
    expect(
      valuesOf(appArgs({ ...standIn, image: "raaqeb:0.1.0" }), "--cpuset-cpus")
    ).toEqual(["14"]);
  });

  test("preloads the sampler and turns it on", () => {
    const env = valuesOf(appArgs(standIn), "-e");
    expect(env).toContain("BUN_OPTIONS=--preload /bench/sampler.ts");
    expect(env).toContain(`RAAQEB_BENCH_SAMPLE_MS=${sampleEveryMs}`);
  });

  test("listens on every interface at its port with its data directory at /data", () => {
    const args = appArgs(standIn);
    const env = valuesOf(args, "-e");
    expect(env).toContain("RAAQEB_HOST=0.0.0.0");
    expect(env).toContain(`RAAQEB_PORT=${appPort}`);
    expect(env).toContain("RAAQEB_DATA_DIR=/data");
    expect(valuesOf(args, "-v")).toContain("/tmp/tmp.abc/data:/data");
  });

  test("publishes its port on loopback only, for the harness's health polls", () => {
    expect(valuesOf(appArgs(standIn), "-p")).toEqual([`127.0.0.1::${appPort}`]);
  });

  test("runs as the host user, on the run's network, under the run's name, detached", () => {
    const args = appArgs(standIn);
    expect(args[0]).toBe("run");
    expect(args).toContain("-d");
    expect(valuesOf(args, "--user")).toEqual(["1000:1000"]);
    expect(valuesOf(args, "--network")).toEqual([names.network]);
    expect(valuesOf(args, "--name")).toEqual([names.app]);
  });

  test("the harness folder is mounted read-only", () => {
    expect(valuesOf(appArgs(standIn), "-v")).toContain(
      "/home/op/raaqeb/bench/floor:/bench:ro"
    );
  });

  test("the stand-in mounts the checkout's build, sources and dependencies read-only and runs the entry", () => {
    const args = appArgs(standIn);
    const mounts = valuesOf(args, "-v");
    for (const part of [
      "dist",
      "src",
      "node_modules",
      "package.json",
      "bunfig.toml",
      "tsconfig.json",
    ]) {
      expect(mounts).toContain(`/home/op/raaqeb/${part}:/app/${part}:ro`);
    }
    expect(valuesOf(args, "-w")).toEqual(["/app"]);
    expect(args.slice(-4)).toEqual([
      standInImage,
      "bun",
      "dist/server/server.js",
      "serve",
    ]);
  });

  test("the store Bun's node_modules links into is mounted at its own path", () => {
    expect(valuesOf(appArgs(standIn), "-v")).toContain(
      "/home/op/.bun/install/cache/links:/home/op/.bun/install/cache/links:ro"
    );
  });

  test("words for raaqeb serve follow the entry", () => {
    const args = appArgs({
      ...standIn,
      passThrough: ["--trusted-proxies", "10.0.0.1"],
    });
    expect(args.slice(-3)).toEqual(["serve", "--trusted-proxies", "10.0.0.1"]);
  });

  test("a shipped image runs its own entry, with nothing of the checkout mounted", () => {
    const args = appArgs({
      ...standIn,
      image: "ghcr.io/example/raaqeb:1.0.0",
      passThrough: ["--trusted-proxies", "10.0.0.1"],
    });
    const mounts = valuesOf(args, "-v");
    expect(mounts.some((mount) => mount.includes(":/app/"))).toBe(false);
    expect(mounts.some((mount) => mount.includes("/links"))).toBe(false);
    expect(mounts).toContain("/home/op/raaqeb/bench/floor:/bench:ro");
    expect(valuesOf(args, "-w")).toEqual([]);
    expect(args.slice(-3)).toEqual([
      "ghcr.io/example/raaqeb:1.0.0",
      "--trusted-proxies",
      "10.0.0.1",
    ]);
  });

  test("boot settings the run gives, such as the install key and a Postgres URL, reach the install", () => {
    const env = valuesOf(
      appArgs({
        ...standIn,
        env: {
          DATABASE_URL: "postgres://raaqeb:raaqeb@db:5432/raaqeb",
          RAAQEB_SECRET_KEY: "k".repeat(43),
        },
      }),
      "-e"
    );
    expect(env).toContain(
      "DATABASE_URL=postgres://raaqeb:raaqeb@db:5432/raaqeb"
    );
    expect(env).toContain(`RAAQEB_SECRET_KEY=${"k".repeat(43)}`);
  });

  test("a shipped image keeps the 240 MB and one CPU limits and the sampler", () => {
    const args = appArgs({ ...standIn, image: "ghcr.io/example/raaqeb:1.0.0" });
    expect(args).toContain("--memory=240m");
    expect(args).toContain("--cpus=1");
    expect(valuesOf(args, "-e")).toContain(
      "BUN_OPTIONS=--preload /bench/sampler.ts"
    );
  });
});

describe("the other containers of a run", () => {
  test("each run's names are its own", () => {
    const other = containerNames("20260923-101500-2");
    const all = Object.values(names);
    expect(new Set(all).size).toBe(8);
    expect(Object.values(other).filter((name) => all.includes(name))).toEqual(
      []
    );
    for (const name of Object.values(other)) {
      expect(name).toMatch(dockerName);
    }
  });

  test("the target runs from the mounted harness folder on the run's network", () => {
    const args = targetArgs(
      names,
      "/home/op/raaqeb/bench/floor",
      "/home/op/raaqeb/src/server/checks/fixtures",
      cpus
    );
    expect(args[0]).toBe("run");
    expect(args).toContain("-d");
    expect(valuesOf(args, "--name")).toEqual([names.target]);
    expect(valuesOf(args, "--network")).toEqual([names.network]);
    expect(valuesOf(args, "-v")).toEqual([
      "/home/op/raaqeb/bench/floor:/bench:ro",
      "/home/op/raaqeb/src/server/checks/fixtures:/fixtures:ro",
    ]);
    expect(args.slice(-3)).toEqual([standInImage, "bun", "/bench/target.ts"]);
  });

  test("the target publishes its HTTP port on loopback, so the harness can read the webhook sink", () => {
    const args = targetArgs(names, "/b", "/f", cpus);
    expect(valuesOf(args, "-p")).toEqual([`127.0.0.1::${targetPorts.http}`]);
    expect(targetPort).toBe(targetPorts.http);
  });

  test("Mailpit takes any login, runs on the run's network and publishes its API on loopback", () => {
    const args = mailpitArgs(names, cpus);
    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(valuesOf(args, "--name")).toEqual([names.mailpit]);
    expect(valuesOf(args, "--network")).toEqual([names.network]);
    expect(valuesOf(args, "-p")).toEqual([`127.0.0.1::${mailpitPorts.api}`]);
    expect(valuesOf(args, "-e")).toContain("MP_SMTP_AUTH_ACCEPT_ANY=1");
    expect(args.at(-1)).toBe(mailpitImage);
  });

  test("Postgres keeps its data on tmpfs, publishes its port on loopback for seeding, and the install reaches it by name", () => {
    const args = postgresArgs(names, cpus);
    expect(valuesOf(args, "--name")).toEqual([names.postgres]);
    expect(valuesOf(args, "--network")).toEqual([names.network]);
    expect(valuesOf(args, "--tmpfs")).toEqual(["/var/lib/postgresql"]);
    expect(valuesOf(args, "-p")).toEqual(["127.0.0.1::5432"]);
    expect(valuesOf(args, "-e")).toEqual([
      "POSTGRES_USER=raaqeb",
      "POSTGRES_PASSWORD=raaqeb",
      "POSTGRES_DB=raaqeb",
    ]);
    expect(args.at(-1)).toBe(postgresImage);
    expect(postgresUrl(names)).toBe(
      `postgres://raaqeb:raaqeb@${names.postgres}:5432/raaqeb`
    );
  });

  test("a throughput path runs oha closed-loop over sixteen connections with the path's headers", () => {
    const args = throughputArgs(
      names,
      "/api/pages/p1/overview",
      30,
      ['If-None-Match: "abc"'],
      cpus
    );
    expect(valuesOf(args, "--name")).toEqual([names.load]);
    expect(valuesOf(args, "-z")).toEqual(["30s"]);
    expect(valuesOf(args, "-c")).toEqual(["16"]);
    expect(valuesOf(args, "-q")).toEqual([]);
    expect(valuesOf(args, "-H")).toEqual(['If-None-Match: "abc"']);
    expect(valuesOf(args, "--output-format")).toEqual(["json"]);
    expect(args).toContain("-w");
    expect(args.at(-1)).toBe(
      `http://${names.app}:${appPort}/api/pages/p1/overview`
    );
  });

  test("every stand-in and oha run on the stand-ins' cores, never on an install's", () => {
    for (const args of [
      targetArgs(names, "/b", "/f", cpus),
      mailpitArgs(names, cpus),
      postgresArgs(names, cpus),
      mysqlArgs(names, cpus),
      redisArgs(names, cpus),
      loadArgs(names, 300, 20, cpus),
      throughputArgs(names, "/", 30, [], cpus),
    ]) {
      expect(valuesOf(args, "--cpuset-cpus")).toEqual([cpus]);
    }
  });

  test("MySQL keeps its data on tmpfs and signs the monitors in with a password, at the version the test compose file pins", async () => {
    const args = mysqlArgs(names, cpus);
    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(valuesOf(args, "--name")).toEqual([names.mysql]);
    expect(valuesOf(args, "--network")).toEqual([names.network]);
    expect(valuesOf(args, "--tmpfs")).toEqual(["/var/lib/mysql"]);
    expect(valuesOf(args, "-e")).toEqual([
      "MYSQL_ROOT_PASSWORD=raaqeb",
      "MYSQL_DATABASE=raaqeb",
      "MYSQL_USER=raaqeb",
      "MYSQL_PASSWORD=raaqeb",
    ]);
    expect(args.at(-1)).toBe(mysqlImage);
    const compose = await Bun.file(
      `${import.meta.dir}/../../compose.yaml`
    ).text();
    expect(compose).toContain(`image: ${mysqlImage}`);
    expect(compose).toContain(`image: ${redisImage}`);
  });

  test("Redis asks for a password and writes nothing to disk", () => {
    const args = redisArgs(names, cpus);
    expect(valuesOf(args, "--name")).toEqual([names.redis]);
    expect(valuesOf(args, "--network")).toEqual([names.network]);
    const image = args.indexOf(redisImage);
    expect(image).toBeGreaterThan(0);
    expect(args.slice(image + 1)).toEqual([
      "redis-server",
      "--requirepass",
      "raaqeb",
      "--save",
      "",
      "--appendonly",
      "no",
    ]);
  });

  test("the database monitors reach each server by its name, with a URL the product accepts, MySQL's over TLS since MySQL 8.4's default sign-in refuses a plain connection that cannot fetch the server's key", () => {
    const urls = databaseUrls(names);
    expect(urls).toEqual({
      mysql: `mysql://raaqeb:raaqeb@${names.mysql}:3306/raaqeb?sslmode=require`,
      postgres: `postgres://raaqeb:raaqeb@${names.postgres}:5432/raaqeb`,
      redis: `redis://:raaqeb@${names.redis}:6379`,
    });
    for (const kind of ["mysql", "postgres", "redis"] as const) {
      expect(connectionUrlFits(kind, urls[kind])).toBe(true);
    }
  });

  test("each database server is asked over TCP whether it takes connections, once per server", () => {
    const checks = readinessArgs(names);
    expect(checks.map((args) => args.slice(0, 2))).toEqual([
      ["exec", names.postgres],
      ["exec", names.mysql],
      ["exec", names.redis],
    ]);
    for (const args of checks.slice(0, 2)) {
      expect(args.join(" ")).toContain("127.0.0.1");
    }
    expect(checks[2]).toContain("ping");
  });

  test("the seeded monitors check the target by its name on the network", () => {
    expect(targetUrl(names)).toBe(`http://${names.target}:${targetPort}/`);
  });

  test("oha holds one arrival rate for the phase, waits for requests in flight at the end, and writes JSON", () => {
    const args = loadArgs(names, 300, 20, cpus);
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(valuesOf(args, "--name")).toEqual([names.load]);
    expect(valuesOf(args, "--network")).toEqual([names.network]);
    expect(valuesOf(args, "-z")).toEqual(["300s"]);
    expect(valuesOf(args, "-q")).toEqual(["20"]);
    expect(args).toContain("--latency-correction");
    expect(args).toContain("-w");
    expect(args).toContain("--no-tui");
    expect(valuesOf(args, "--output-format")).toEqual(["json"]);
    expect(args).toContain(ohaImage);
    expect(args.at(-1)).toBe(`http://${names.app}:${appPort}${loadPath}`);
  });

  test("the longest part's names stay one DNS label, since a monitor's URL names the target", () => {
    const stamp = runStamp(new Date("2026-12-31T23:59:59.999Z"));
    const longest = containerNames(
      partId(stamp, 10, "postgres", "capacity-51200")
    );
    for (const name of Object.values(longest)) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(dockerName);
    }
    expect(partId(stamp, 1, "sqlite", "fixed")).not.toBe(
      partId(stamp, 2, "sqlite", "fixed")
    );
    expect(partId(stamp, 1, "sqlite", "capacity-200")).not.toBe(
      partId(stamp, 1, "sqlite", "capacity-400")
    );
  });

  test("a run's stamp makes names Docker accepts and sorts in time order", () => {
    const earlier = runStamp(new Date("2026-09-23T09:59:59.999Z"));
    const later = runStamp(new Date("2026-09-23T10:00:00.000Z"));
    expect(earlier < later).toBe(true);
    const named = containerNames(`${later}-10`);
    for (const name of [named.app, named.load, named.network, named.target]) {
      expect(name).toMatch(dockerName);
    }
  });
});

describe("the images a run measures", () => {
  test("the binaries are the host architecture's, as bun run binaries names them", () => {
    expect(binaryNames("x64")).toEqual({
      glibc: "raaqeb-linux-x64",
      musl: "raaqeb-linux-x64-musl",
    });
    expect(binaryNames("arm64")).toEqual({
      glibc: "raaqeb-linux-arm64",
      musl: "raaqeb-linux-arm64-musl",
    });
  });

  test("the musl image is named for the version", () => {
    expect(muslImage("0.1.0")).toBe("raaqeb-bench-musl:0.1.0");
  });

  test("the musl image is Alpine with the two libraries the binary links, running the binary as serve", () => {
    const text = muslDockerfile("raaqeb-linux-x64-musl");
    expect(text).toContain(`FROM ${alpineImage}`);
    expect(text).toContain("apk add --no-cache libstdc++ libgcc");
    expect(text).toContain("COPY raaqeb-linux-x64-musl /usr/local/bin/raaqeb");
    expect(text).toContain('ENTRYPOINT ["/usr/local/bin/raaqeb"]');
    expect(text).toContain('CMD ["serve"]');
  });

  test("an image with no revision label names no commit", () => {
    expect(imageRevision("")).toEqual({ commit: "unknown", dirty: false });
    expect(imageRevision("<no value>")).toEqual({
      commit: "unknown",
      dirty: false,
    });
  });

  test("an image's revision label names its commit and whether its tree was dirty", () => {
    expect(imageRevision("36ef28ad1eca")).toEqual({
      commit: "36ef28ad1eca",
      dirty: false,
    });
    expect(imageRevision("36ef28ad1eca-dirty")).toEqual({
      commit: "36ef28ad1eca",
      dirty: true,
    });
  });
});

describe("the store Bun's node_modules links into", () => {
  test("is every directory an absolute link points into, once", () => {
    expect(
      linkDirectories(
        [
          "/home/op/.bun/install/cache/links/zod@4.6.5-0b889a943ce86252",
          "/home/op/.bun/install/cache/links/react@19.3.0-1c2d",
          "/opt/other/store/left-pad@1.3.0",
          "",
        ].join("\n")
      )
    ).toEqual(["/home/op/.bun/install/cache/links", "/opt/other/store"]);
  });

  test("a relative link stays inside the checkout and needs no mount", () => {
    expect(linkDirectories("../zod@4.6.5/node_modules/zod\n")).toEqual([]);
  });
});

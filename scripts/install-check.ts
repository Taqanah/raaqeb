/**
 * `bun run install:check`: the installer runs, piped from curl as an operator
 * runs it, in two clean containers that hold only their init system and curl,
 * as a server does: Debian 13 under systemd with the x64 glibc binary, and
 * Alpine 3.22 under OpenRC with the x64 musl one. In each, the service then
 * answers /health, the data directory and the env file have their owners and
 * modes, a command runs as the raaqeb user with the env file, a killed server
 * is started again, and a second run keeps the env file and serves on the
 * port it sets. Neither has zstd for the first run, which takes the .gz; zstd
 * is added before the second, an upgrade beside the running service, which
 * takes the .zst. The binaries and the script are served from a container on
 * the run's own network. Needs Docker and `bun run binaries`, so it stays out
 * of the gate. The Debian machine is privileged, so it runs only on a GitHub
 * runner (`refusal`). arm64 is not run: this machine has no emulation.
 */
import { standInImage } from "../bench/floor/container.ts";

const repo = `${import.meta.dir}/..`;
const bin = `${repo}/dist/bin`;
const tag = `p33-${Date.now().toString(36)}`;

interface Machine {
  /** Installs zstd, between the first run and the second. */
  readonly addZstd: string;
  /** The binary the installer picks here. */
  readonly binary: string;
  /** The image the container is built from: a pinned base, its init system and curl. */
  readonly dockerfile: string;
  readonly name: string;
  /** Run once systemd or OpenRC is up, it answers 0. */
  readonly ready: string;
  /** The flags its init system needs as PID 1. */
  readonly runFlags: readonly string[];
  /** Answers the server's process id. */
  readonly serverPid: string;
}

/**
 * Why a machine may not run here: a privileged container gets the host's
 * devices and terminals, so its init system can take a desktop's console.
 * GitHub sets GITHUB_ACTIONS=true on its runners, which have no desktop;
 * act sets it too on a desktop, and ACT=true beside it.
 */
export function refusal(
  machine: Machine,
  env: Record<string, string | undefined>
): string | undefined {
  if (
    machine.runFlags.includes("--privileged") &&
    (env.GITHUB_ACTIONS !== "true" || env.ACT === "true")
  ) {
    return `${machine.name} boots its init system in a privileged container, which gets the host's devices and terminals and can take a desktop's console; it runs only on a GitHub runner, where GITHUB_ACTIONS=true`;
  }
  return undefined;
}

export const machines: readonly Machine[] = [
  {
    addZstd:
      "apt-get update -qq && apt-get install -y -qq --no-install-recommends zstd",
    binary: "raaqeb-linux-x64",
    dockerfile: `FROM debian:13@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Privileged, the container sees the host's terminals, devices and kernel settings: no unit may touch them.
RUN systemctl mask getty.target getty@.service getty@tty1.service autovt@.service serial-getty@.service console-getty.service getty-static.service systemd-logind.service systemd-udevd.service systemd-udevd-control.socket systemd-udevd-kernel.socket systemd-udev-trigger.service systemd-vconsole-setup.service systemd-sysctl.service systemd-modules-load.service modprobe@.service systemd-binfmt.service proc-sys-fs-binfmt_misc.automount systemd-tmpfiles-setup-dev.service systemd-tmpfiles-setup-dev-early.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]`,
    name: "debian",
    ready:
      'state=$(systemctl is-system-running --wait); [ "$state" = running ] || [ "$state" = degraded ]',
    // Privileged, so systemd can make its mounts under a host whose Docker AppArmor profile forbids them, as Ubuntu runners do.
    runFlags: [
      "--privileged",
      "--cgroupns=host",
      "-v",
      "/sys/fs/cgroup:/sys/fs/cgroup:rw",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
    ],
    serverPid: "systemctl show -p MainPID --value raaqeb",
  },
  {
    addZstd: "apk add --no-cache -q zstd",
    binary: "raaqeb-linux-x64-musl",
    dockerfile: `FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache openrc curl && sed -i 's/^#rc_sys=""/rc_sys="docker"/' /etc/rc.conf && sed -i '/getty/d' /etc/inittab
CMD ["/sbin/init"]`,
    name: "alpine",
    // The default runlevel is reached once openrc itself has exited (prototype).
    ready:
      '[ "$(cat /run/openrc/softlevel 2>/dev/null)" = default ] && ! pgrep -x openrc >/dev/null',
    runFlags: [],
    serverPid: "pidof raaqeb",
  },
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

async function must(command: string[], stdin?: string): Promise<string> {
  const { code, output } = await run(command, stdin);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited ${code}: ${output}`);
  }
  return output.trim();
}

/** Polls until the check answers true, or throws naming what never happened. */
async function until(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 90_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling, one attempt at a time
    if (await check().catch(() => false)) {
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function step(machine: string, line: string): void {
  process.stdout.write(`install:check: ${machine}: ${line}\n`);
}

/**
 * The release the installer downloads from: dist/bin and the script, served
 * by Bun in a container on a network of the run's own, which the machines
 * join, so no host firewall stands between them.
 */
const network = `${tag}-net`;
const files = `${tag}-files`;
const release = `http://${files}:8080`;
const serve =
  'Bun.serve({ port: 8080, fetch: async (r) => { const path = new URL(r.url).pathname; const f = Bun.file(path === "/install.sh" ? "/script/install.sh" : "/srv" + path); return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 }); } })';

async function startRelease(): Promise<void> {
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
    "-v",
    `${repo}/deploy/install.sh:/script/install.sh:ro`,
    standInImage,
    "bun",
    "-e",
    serve,
  ]);
}

/** One machine through the whole install; throws at the first thing that does not hold. */
async function checkMachine(machine: Machine): Promise<void> {
  const image = `${tag}-${machine.name}`;
  const exec = (script: string) =>
    must(["docker", "exec", image, "sh", "-c", script]);
  await must(["docker", "build", "-q", "-t", image, "-"], machine.dockerfile);
  await must([
    "docker",
    "run",
    "-d",
    "--name",
    image,
    "--network",
    network,
    ...machine.runFlags,
    image,
  ]);
  await until("the init system", async () => {
    await exec(machine.ready);
    return true;
  });
  step(machine.name, "the init system is up");

  // pipefail, so a download that fails fails the step rather than piping nothing into sh.
  const install = `set -o pipefail; curl -fsSL ${release}/install.sh | RAAQEB_DOWNLOAD_URL=${release} sh`;
  const first = await exec(install);
  process.stdout.write(`${first}\n`);
  if (!first.includes(`downloaded ${machine.binary}.gz `)) {
    throw new Error(
      `the first run took another file than ${machine.binary}.gz`
    );
  }
  step(machine.name, "the installer exited 0, having taken the .gz");

  const health = await exec("curl -fsS http://127.0.0.1:3000/health");
  if (!health.includes('"ok":true')) {
    throw new Error(`/health answered ${health}`);
  }
  await exec("raaqeb health");
  step(machine.name, "the service answers /health and raaqeb health exits 0");

  const owners = await exec(
    "stat -c '%U:%G %a' /var/lib/raaqeb /etc/raaqeb /etc/raaqeb/raaqeb.env /usr/local/bin/raaqeb"
  );
  const expected =
    "raaqeb:raaqeb 700\nroot:raaqeb 750\nroot:raaqeb 640\nroot:root 755";
  if (owners !== expected) {
    throw new Error(`owners and modes:\n${owners}`);
  }
  step(
    machine.name,
    "the data directory and the env file have their owners and modes"
  );

  const asUser = await run([
    "docker",
    "exec",
    image,
    "su",
    "-s",
    "/bin/sh",
    "raaqeb",
    "-c",
    // Before onboarding there is no database to store an address in, so the command answers 1 and says so.
    'set -a; . /etc/raaqeb/raaqeb.env; RAAQEB_DATA_DIR=/var/lib/raaqeb raaqeb set-address https://raaqeb.example.com; echo "exit $?"; id -un',
  ]);
  if (
    asUser.code !== 0 ||
    !asUser.output.includes("there is no database yet") ||
    !asUser.output.includes("exit 1") ||
    !asUser.output.split("\n").includes("raaqeb")
  ) {
    throw new Error(`the command as the raaqeb user: ${asUser.output}`);
  }
  step(machine.name, "a command runs as the raaqeb user with the env file");

  const pid = await exec(machine.serverPid);
  await exec(`kill -9 ${pid}`);
  await until("the killed server to be started again", async () => {
    const again = await exec(machine.serverPid);
    await exec("raaqeb health");
    return again !== "" && again !== pid;
  });
  step(machine.name, "a killed server is started again");

  await exec("echo RAAQEB_PORT=3001 >> /etc/raaqeb/raaqeb.env");
  await exec(machine.addZstd);
  const second = await exec(install);
  process.stdout.write(`${second}\n`);
  if (!second.includes(`downloaded ${machine.binary}.zst `)) {
    throw new Error(
      `the second run took another file than ${machine.binary}.zst`
    );
  }
  await exec("curl -fsS http://127.0.0.1:3001/health");
  await exec("grep -qx RAAQEB_PORT=3001 /etc/raaqeb/raaqeb.env");
  step(
    machine.name,
    "a second run, with zstd added, takes the .zst, keeps the env file and serves on the port it sets"
  );
}

if (import.meta.main) {
  let failed = false;
  try {
    await startRelease();
    for (const machine of machines) {
      const refused = refusal(machine, process.env);
      if (refused) {
        failed = true;
        process.stderr.write(`install:check: ${refused}\n`);
        continue;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one machine at a time, each owns port 3000 inside its container
        await checkMachine(machine);
      } catch (error) {
        failed = true;
        process.stderr.write(
          `install:check: ${machine.name} failed: ${String(error)}\n`
        );
        // The container's own output, for an init system that never came up.
        const boot = await run(["docker", "logs", `${tag}-${machine.name}`]);
        process.stderr.write(boot.output);
        const logs = await run([
          "docker",
          "exec",
          `${tag}-${machine.name}`,
          "sh",
          "-c",
          "journalctl -u raaqeb --no-pager 2>/dev/null || cat /var/log/raaqeb/raaqeb.log",
        ]);
        process.stderr.write(logs.output);
      } finally {
        await run(["docker", "rm", "-f", `${tag}-${machine.name}`]);
        await run(["docker", "rmi", `${tag}-${machine.name}`]);
      }
    }
  } catch (error) {
    failed = true;
    process.stderr.write(`install:check failed: ${String(error)}\n`);
  } finally {
    await run(["docker", "rm", "-f", files]);
    await run(["docker", "network", "rm", network]);
  }
  process.exit(failed ? 1 : 0);
}

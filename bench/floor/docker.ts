/**
 * The harness's Docker plumbing: running `docker`, reading a container from
 * the host every second, its cold start, its OOM state and its logs, read
 * before the container is removed.
 */
import { cgroupDirectory, readHost } from "./host.ts";
import type { HostSample, OomVerdict } from "./results.ts";

/** How long the install has to answer its first 200 before the run goes on without a cold start. */
const coldStartLimitMs = 120_000;

/** The host's sampling interval. */
const hostEveryMs = 1000;

/** Runs `docker` and answers its standard output; throws with its standard error on a failure. */
export async function docker(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args[0]} failed: ${err.trim()}`);
  }
  return out.trim();
}

/** A started container as the host sees it. */
export interface Started {
  /** The cgroup v2 directory the host reads. */
  readonly directory: string;
  /** The loopback origin Docker publishes its port at. */
  readonly origin: string;
  readonly pid: number;
  /** Docker's own record of the start, so container creation is not the cold start. */
  readonly startedAt: number;
}

/** Reads a started container's process, cgroup, start time and the loopback address of `port`. */
export async function started(name: string, port: number): Promise<Started> {
  const [pidText, startedText] = (
    await docker(["inspect", "-f", "{{.State.Pid}} {{.State.StartedAt}}", name])
  ).split(" ");
  const pid = Number(pidText);
  const directory = cgroupDirectory(
    await Bun.file(`/proc/${pid}/cgroup`).text()
  );
  if (!directory) {
    throw new Error("the install's process has no cgroup v2 directory");
  }
  const published = await docker(["port", name, String(port)]);
  return {
    directory,
    origin: `http://${published.split("\n")[0]}`,
    pid,
    startedAt: Date.parse(startedText ?? ""),
  };
}

/** Polls GET /health until it answers 200; the milliseconds that took, or nothing past the limit. */
export async function coldStart(
  origin: string,
  startedAt: number
): Promise<number | null> {
  while (Date.now() - startedAt < coldStartLimitMs) {
    // biome-ignore lint/performance/noAwaitInLoops: each poll waits for the one before it
    const status = await fetch(`${origin}/health`).then(
      (response) => response.status,
      () => 0
    );
    if (status === 200) {
      return Date.now() - startedAt;
    }
    await Bun.sleep(50);
  }
  return null;
}

/** Reads the host's view every second until `stop` is called; answers the samples. */
export function sampleHost(directory: string, pid: number) {
  const samples: HostSample[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const at = Date.now();
      // biome-ignore lint/performance/noAwaitInLoops: one reading a second, in order
      const reading = await readHost(directory, pid);
      if (reading) {
        samples.push({ ...reading, at });
      }
      await Bun.sleep(Math.max(0, at + hostEveryMs - Date.now()));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return samples;
    },
  };
}

/** Whether the kernel killed the install, from Docker's record and the cgroup's counter. */
export async function oomVerdict(
  name: string,
  samples: readonly HostSample[]
): Promise<{ exitCode: number | null; oom: OomVerdict }> {
  const counted = samples.some((sample) => sample.oomKills > 0);
  try {
    const [killed, code] = (
      await docker([
        "inspect",
        "-f",
        "{{.State.OOMKilled}} {{.State.ExitCode}}",
        name,
      ])
    ).split(" ");
    return {
      exitCode: Number(code),
      oom: killed === "true" || counted ? "killed" : "none",
    };
  } catch {
    return { exitCode: null, oom: counted ? "killed" : "not-captured" };
  }
}

/** A container's log lines: standard output, then standard error on lines of their own. */
export async function containerLog(name: string): Promise<string> {
  const child = Bun.spawn(["docker", "logs", name], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // A last output line with no break must not run into the first error line.
  return `${out}\n${err}`;
}

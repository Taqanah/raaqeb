/**
 * The host's view: the container's cgroup v2 files and PID 1's
 * `/proc` status, read from outside with no product code, and the machine
 * itself, which every result names so a band is never compared across
 * machines. A read costs about a millisecond, where `docker stats` costs one
 * to two seconds.
 */
import type { Variant } from "./results.ts";

/** The machine a run measured on. */
export interface Machine {
  readonly cores: number;
  /** The CPU's model name from `/proc/cpuinfo`. */
  readonly cpu: string;
  /** The kernel release. */
  readonly kernel: string;
  /** MemTotal in bytes. */
  readonly memoryBytes: number;
}

/** One reading of the container from the host. */
export interface HostReading {
  /** `cpu.stat` throttled_usec: time the one-CPU quota held the container back. */
  readonly cpuThrottledUsec: number;
  /** `cpu.stat` usage_usec: CPU time since the container started. */
  readonly cpuUsageUsec: number;
  /** `memory.current` in bytes: everything charged to the cgroup, page cache included. */
  readonly memoryCurrent: number;
  /** `memory.peak` in bytes since the container started. */
  readonly memoryPeak: number;
  /** `memory.events` oom_kill: how many processes the kernel killed at the limit. */
  readonly oomKills: number;
  /** PID 1's VmRSS in bytes; `null` when it could not be read. */
  readonly vmRss: number | null;
}

const vmRssLine = /^VmRSS:\s+(\d+) kB$/m;
const modelNameLine = /^model name\s*: (.+)$/m;
const memTotalLine = /^MemTotal:\s+(\d+) kB$/m;

/** The cgroup v2 directory named by a `/proc/<pid>/cgroup` file, under `/sys/fs/cgroup`. */
export function cgroupDirectory(procCgroup: string): string | undefined {
  const line = procCgroup.split("\n").find((entry) => entry.startsWith("0::"));
  return line === undefined ? undefined : `/sys/fs/cgroup${line.slice(3)}`;
}

/** One counter of a flat keyed file such as `cpu.stat` or `memory.events`; nothing when absent. */
export function keyedValue(text: string, key: string): number | undefined {
  for (const line of text.split("\n")) {
    const [name, value] = line.split(" ");
    if (name === key && value !== undefined) {
      return Number(value);
    }
  }
  return undefined;
}

/** VmRSS of a `/proc/<pid>/status` file, in bytes. */
export function vmRssBytes(status: string): number | undefined {
  const kilobytes = vmRssLine.exec(status)?.[1];
  return kilobytes === undefined ? undefined : Number(kilobytes) * 1024;
}

/** The machine from `/proc/cpuinfo`, `/proc/meminfo` and the kernel release. */
export function machineOf(input: {
  readonly cores: number;
  readonly cpuinfo: string;
  readonly kernel: string;
  readonly meminfo: string;
}): Machine {
  const cpu = modelNameLine.exec(input.cpuinfo)?.[1] ?? "unknown";
  const kilobytes = memTotalLine.exec(input.meminfo)?.[1] ?? "0";
  return {
    cores: input.cores,
    cpu: cpu.trim(),
    kernel: input.kernel.trim(),
    memoryBytes: Number(kilobytes) * 1024,
  };
}

/** Reads the container's cgroup directory and its PID 1 once; nothing when the cgroup is gone. */
export async function readHost(
  directory: string,
  pid: number
): Promise<HostReading | undefined> {
  const read = (path: string) =>
    Bun.file(path)
      .text()
      .catch(() => undefined);
  const [current, peak, cpu, events, status] = await Promise.all([
    read(`${directory}/memory.current`),
    read(`${directory}/memory.peak`),
    read(`${directory}/cpu.stat`),
    read(`${directory}/memory.events`),
    read(`/proc/${pid}/status`),
  ]);
  if (
    current === undefined ||
    peak === undefined ||
    cpu === undefined ||
    events === undefined
  ) {
    return undefined;
  }
  return {
    cpuThrottledUsec: keyedValue(cpu, "throttled_usec") ?? 0,
    cpuUsageUsec: keyedValue(cpu, "usage_usec") ?? 0,
    memoryCurrent: Number(current),
    memoryPeak: Number(peak),
    oomKills: keyedValue(events, "oom_kill") ?? 0,
    vmRss: (status === undefined ? undefined : vmRssBytes(status)) ?? null,
  };
}

/** The CPUs of a kernel CPU list such as `0-3,8,10-11`, in order. */
export function cpuList(text: string): number[] {
  return text
    .trim()
    .split(",")
    .filter((part) => part !== "")
    .flatMap((part) => {
      const [first, last = first] = part.split("-").map(Number);
      return first === undefined || last === undefined
        ? []
        : Array.from({ length: last - first + 1 }, (_, index) => first + index);
    });
}

/**
 * Where the run's containers go: every measured install on a core of its
 * own among `measured`, the stand-ins, `oha` and the harness on `standIns`.
 * On a hybrid CPU the installs take the efficiency cores, never a
 * performance core.
 */
export interface Cores {
  /** `efficiency` on a hybrid CPU; `uniform` when every core is of one kind. */
  readonly kind: "efficiency" | "uniform";
  /** The CPUs a measured install may run on. */
  readonly measured: readonly number[];
  /** The CPU list the stand-ins run on, as `--cpuset-cpus` and `taskset` take it. */
  readonly standIns: string;
}

export type CoresResult =
  | { readonly cores: Cores; readonly ok: true }
  | { readonly message: string; readonly ok: false };

/** How many installs run at once in the parallel block: the day and three fixed runs. */
export const installsAtOnce = 4;

/** The cores of this machine from `/sys/devices/cpu_atom/cpus` (absent on a CPU of one kind), `/sys/devices/system/cpu/online` and each online CPU's `topology/thread_siblings_list`, where a CPU listed in none is a core of its own. */
export function coresOf(input: {
  readonly atom: string | undefined;
  readonly online: string;
  readonly siblings?: readonly string[];
}): CoresResult {
  const online = cpuList(input.online);
  if (input.atom !== undefined) {
    const atom = new Set(cpuList(input.atom));
    const measured = online.filter((cpu) => atom.has(cpu));
    const performance = online.filter((cpu) => !atom.has(cpu));
    if (performance.length === 0) {
      return {
        message:
          "the stand-ins run on the performance cores, and none is online",
        ok: false,
      };
    }
    if (measured.length < installsAtOnce) {
      return {
        message: `the installs run on efficiency cores only, ${installsAtOnce} at once, and this CPU has ${measured.length} online`,
        ok: false,
      };
    }
    return {
      cores: {
        kind: "efficiency",
        measured,
        standIns: performance.join(","),
      },
      ok: true,
    };
  }
  // One entry a physical core, its threads in order, so an install never shares a core with a stand-in.
  const cores = new Map<string, number[]>();
  for (const cpu of online) {
    const threads = (input.siblings ?? [])
      .map(cpuList)
      .find((group) => group.includes(cpu)) ?? [cpu];
    cores.set(threads.join(","), threads);
  }
  const whole = [...cores.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  if (whole.length <= installsAtOnce) {
    return {
      message: `the installs take ${installsAtOnce} cores of their own and the stand-ins need one more; this machine has ${whole.length}`,
      ok: false,
    };
  }
  return {
    cores: {
      kind: "uniform",
      measured: whole.slice(-installsAtOnce).map((threads) => threads[0] ?? 0),
      standIns: whole
        .slice(0, -installsAtOnce)
        .flat()
        .sort((a, b) => a - b)
        .join(","),
    },
    ok: true,
  };
}

/** The core each install of a run takes: the day and each fixed run one of their own, spread across the measured cores; the parts that run alone take the day's. */
export interface Placement {
  readonly alone: number;
  readonly day: number;
  readonly fixed: Readonly<Record<Variant, number>>;
}

export function placementOf(measured: readonly number[]): Placement {
  // Evenly spaced, so a hybrid CPU's clusters of efficiency cores share the installs out.
  const pick = (slot: number) =>
    measured[Math.floor((slot * measured.length) / installsAtOnce)] ?? 0;
  return {
    alone: pick(0),
    day: pick(0),
    fixed: { musl: pick(3), postgres: pick(2), sqlite: pick(1) },
  };
}

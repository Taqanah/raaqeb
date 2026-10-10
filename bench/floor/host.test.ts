import { afterEach, describe, expect, test } from "bun:test";
import {
  type Cores,
  cgroupDirectory,
  coresOf,
  cpuList,
  installsAtOnce,
  keyedValue,
  machineOf,
  placementOf,
  readHost,
  vmRssBytes,
} from "./host.ts";

const cpuStat = `usage_usec 341186
user_usec 293406
system_usec 47779
nr_periods 120
nr_throttled 4
throttled_usec 9120
nr_bursts 0
burst_usec 0
`;

const memoryEvents = `low 0
high 0
max 3
oom 1
oom_kill 1
oom_group_kill 0
sock_throttled 0
`;

describe("the container's cgroup, read from the host", () => {
  test("a cgroup v2 entry names its directory under /sys/fs/cgroup", () => {
    expect(
      cgroupDirectory("0::/system.slice/docker-834168b24eb0.scope\n")
    ).toBe("/sys/fs/cgroup/system.slice/docker-834168b24eb0.scope");
  });

  test("a process with only cgroup v1 entries has no v2 directory", () => {
    expect(
      cgroupDirectory(
        "12:memory:/docker/834168b24eb0\n11:cpu:/docker/834168b24eb0\n"
      )
    ).toBeUndefined();
  });

  test("a counter is read by its exact key, not by a longer key it starts", () => {
    expect(keyedValue(cpuStat, "usage_usec")).toBe(341_186);
    expect(keyedValue(cpuStat, "throttled_usec")).toBe(9120);
    expect(keyedValue(memoryEvents, "oom_kill")).toBe(1);
    expect(keyedValue("oom_kill 1\noom_group_kill 0\noom 2\n", "oom")).toBe(2);
  });

  test("a counter the file does not carry is absent, not zero", () => {
    expect(keyedValue(cpuStat, "missing_usec")).toBeUndefined();
  });

  test("VmRSS is read in bytes from its kilobytes", () => {
    const status =
      "Name:\tbun\nVmHWM:\t  117412 kB\nVmRSS:\t  109160 kB\nRssAnon:\t   80000 kB\n";
    expect(vmRssBytes(status)).toBe(109_160 * 1024);
  });

  test("a status without VmRSS, such as a zombie's, has none", () => {
    expect(vmRssBytes("Name:\tbun\nState:\tZ (zombie)\n")).toBeUndefined();
  });
});

describe("the machine a run measured on", () => {
  test("names the CPU model, the cores, the memory and the kernel", () => {
    expect(
      machineOf({
        cores: 16,
        cpuinfo:
          "processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 7 7840HS w/ Radeon 780M Graphics\n\nprocessor\t: 1\nmodel name\t: AMD Ryzen 7 7840HS w/ Radeon 780M Graphics\n",
        kernel: "7.2.6-1-cachyos\n",
        meminfo: "MemTotal:       32562248 kB\nMemFree:         1234 kB\n",
      })
    ).toEqual({
      cores: 16,
      cpu: "AMD Ryzen 7 7840HS w/ Radeon 780M Graphics",
      kernel: "7.2.6-1-cachyos",
      memoryBytes: 32_562_248 * 1024,
    });
  });
});

describe("one reading of a live cgroup", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      // biome-ignore lint/performance/noAwaitInLoops: one temp directory a test
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  async function cgroup(files: Record<string, string>): Promise<string> {
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of small files
      await Bun.write(`${dir}/${name}`, text);
    }
    return dir;
  }

  test("reads memory, CPU and OOM kills from the cgroup and VmRSS of the process", async () => {
    const dir = await cgroup({
      "cpu.stat": cpuStat,
      "memory.current": "97333248\n",
      "memory.events": memoryEvents,
      "memory.peak": "108126208\n",
    });
    const reading = await readHost(dir, process.pid);
    expect(reading).toMatchObject({
      cpuThrottledUsec: 9120,
      cpuUsageUsec: 341_186,
      memoryCurrent: 97_333_248,
      memoryPeak: 108_126_208,
      oomKills: 1,
    });
    expect(reading?.vmRss).toBeGreaterThan(0);
  });

  test("a process that is gone leaves VmRSS unread while the cgroup still answers", async () => {
    const dir = await cgroup({
      "cpu.stat": cpuStat,
      "memory.current": "1\n",
      "memory.events": memoryEvents,
      "memory.peak": "2\n",
    });
    const reading = await readHost(dir, 2 ** 22 + 7);
    expect(reading?.memoryCurrent).toBe(1);
    expect(reading?.vmRss).toBeNull();
  });

  test("a cgroup that is gone gives no reading", async () => {
    expect(
      await readHost("/sys/fs/cgroup/raaqeb-bench-gone.scope", process.pid)
    ).toBeUndefined();
  });
});

describe("the machine's cores", () => {
  /** The cores of a machine that has them; fails the test on a refusal. */
  function cores(input: Parameters<typeof coresOf>[0]): Cores {
    const result = coresOf(input);
    if (!result.ok) {
      throw new Error(result.message);
    }
    return result.cores;
  }

  test("a kernel CPU list reads ranges and single CPUs in order", () => {
    expect(cpuList("0-3,8,10-11\n")).toEqual([0, 1, 2, 3, 8, 10, 11]);
    expect(cpuList("5")).toEqual([5]);
  });

  test("on a hybrid CPU the installs take the efficiency cores and the stand-ins every performance core", () => {
    const hybrid = cores({ atom: "12-19\n", online: "0-19\n" });
    expect(hybrid.kind).toBe("efficiency");
    expect(hybrid.measured).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(cpuList(hybrid.standIns)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  test("an offline efficiency core is never measured on", () => {
    const hybrid = cores({ atom: "12-19", online: "0-17" });
    expect(hybrid.measured).toEqual([12, 13, 14, 15, 16, 17]);
  });

  test("a hybrid CPU with fewer efficiency cores than installs at once is refused, never placed on a performance core", () => {
    const result = coresOf({ atom: "12-14", online: "0-14" });
    expect(result.ok).toBe(false);
    expect(installsAtOnce).toBe(4);
  });

  test("a hybrid CPU with no performance core online is refused, since the stand-ins would have no core", () => {
    const result = coresOf({ atom: "12-19", online: "12-19" });
    expect(result.ok).toBe(false);
  });

  test("on a CPU of one kind the installs take the last cores and the stand-ins the rest", () => {
    const uniform = cores({ atom: undefined, online: "0-7" });
    expect(uniform.kind).toBe("uniform");
    expect(uniform.measured).toEqual([4, 5, 6, 7]);
    expect(cpuList(uniform.standIns)).toEqual([0, 1, 2, 3]);
  });

  test("on a CPU of one kind with two threads a core, an install's core lends no thread to the stand-ins", () => {
    // A Ryzen 7 7700: CPU n and n + 8 are the two threads of one core.
    const siblings = Array.from(
      { length: 16 },
      (_, cpu) => `${cpu % 8},${(cpu % 8) + 8}`
    );
    const uniform = cores({ atom: undefined, online: "0-15", siblings });
    expect(uniform.measured).toEqual([4, 5, 6, 7]);
    expect(cpuList(uniform.standIns)).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
  });

  test("a CPU of one kind with no core left for the stand-ins is refused", () => {
    expect(coresOf({ atom: undefined, online: "0-3" }).ok).toBe(false);
  });
});

describe("where each install runs", () => {
  test("the day and each fixed run take a core of their own, spread across the efficiency cores", () => {
    const placement = placementOf([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(placement.day).toBe(12);
    expect(placement.fixed).toEqual({ musl: 18, postgres: 16, sqlite: 14 });
  });

  test("with exactly as many cores as installs, each still runs alone on its core", () => {
    const placement = placementOf([4, 5, 6, 7]);
    const taken = [
      placement.day,
      placement.fixed.sqlite,
      placement.fixed.postgres,
      placement.fixed.musl,
    ];
    expect(new Set(taken).size).toBe(4);
    expect(taken.every((cpu) => [4, 5, 6, 7].includes(cpu))).toBe(true);
  });

  test("the parts that run alone take the day's core", () => {
    const placement = placementOf([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(placement.alone).toBe(placement.day);
  });
});

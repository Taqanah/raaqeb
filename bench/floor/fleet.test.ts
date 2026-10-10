import { describe, expect, test } from "bun:test";
import { runDockerCheck } from "@/server/checks/docker.ts";
import {
  connectionUrlFits,
  type DockerConfig,
  monitorConfigSchema,
} from "@/shared/schemas/monitor.ts";
import {
  capacityFleet,
  containerInspect,
  degradedMs,
  dnsAddress,
  dnsName,
  type FleetMember,
  type FleetOptions,
  fixedFleet,
  fixedMix,
  flapDownMs,
  flapIsDown,
  flapOffsetMs,
  flapPeriodMs,
  flappingContainer,
  heartbeatEveryMs,
  pageComponents,
  type Role,
  targetPorts,
} from "./fleet.ts";

const target = { host: "raaqeb-bench-target-1", ip: "172.18.0.2" };

const databases = {
  mysql: "mysql://raaqeb:raaqeb@raaqeb-bench-mysql-1:3306/raaqeb",
  postgres: "postgres://raaqeb:raaqeb@raaqeb-bench-postgres-1:5432/raaqeb",
  redis: "redis://:raaqeb@raaqeb-bench-redis-1:6379",
};

const options: FleetOptions = {
  databases,
  failing: false,
  intervalMs: 20_000,
  monitors: 200,
  quiet: false,
  target,
};

function count(fleet: readonly FleetMember[], role: Role): number {
  return fleet.filter((member) => member.role === role).length;
}

/** The URL an HTTP member checks, or nothing for another type. */
function urlOf(member: FleetMember): string | undefined {
  return member.fields.config.type === "http"
    ? member.fields.config.url
    : undefined;
}

describe("the flapping schedule", () => {
  test("a flapping target is down for one minute of every five", () => {
    const downs = Array.from({ length: flapPeriodMs / 1000 }, (_, second) =>
      flapIsDown(0, second * 1000)
    ).filter(Boolean).length;
    expect(downs).toBe(flapDownMs / 1000);
  });

  test("each flapping target goes down half a minute after the one before", () => {
    const firstDown = (index: number) => {
      for (let at = 0; at < flapPeriodMs; at += 1000) {
        if (flapIsDown(index, at) && !flapIsDown(index, at - 1000)) {
          return at;
        }
      }
      return -1;
    };
    const zero = firstDown(0);
    expect((firstDown(1) - zero + flapPeriodMs) % flapPeriodMs).toBe(
      flapOffsetMs
    );
  });

  test("ten flapping targets never all fail at once: two are down at any moment", () => {
    for (let at = 0; at < flapPeriodMs; at += 5000) {
      const down = Array.from({ length: fixedMix.flap }, (_, index) =>
        flapIsDown(index, at)
      ).filter(Boolean).length;
      expect(down).toBe(2);
    }
  });

  test("the schedule repeats every period", () => {
    for (let at = 0; at < flapPeriodMs; at += 7000) {
      expect(flapIsDown(3, at + flapPeriodMs * 4)).toBe(flapIsDown(3, at));
    }
  });
});

describe("the fixed run's monitors", () => {
  const fleet = fixedFleet(options);

  test("are as many as asked, mostly plain HTTP, with every role of the mix", () => {
    expect(fleet).toHaveLength(200);
    for (const [role, number] of Object.entries(fixedMix)) {
      expect(count(fleet, role as Role)).toBe(number);
    }
    const others = Object.values(fixedMix).reduce((sum, n) => sum + n, 0);
    expect(count(fleet, "ok")).toBe(200 - others);
    expect(count(fleet, "fail")).toBe(0);
  });

  test("cover every check type the product has, plus TLS expiry", () => {
    const types = new Set(fleet.map((member) => member.fields.config.type));
    expect([...types].sort()).toEqual([
      "dns",
      "docker",
      "heartbeat",
      "http",
      "mysql",
      "postgres",
      "redis",
      "tcp",
    ]);
    const https = fleet.filter((member) => member.role === "https");
    for (const member of https) {
      expect(urlOf(member)).toBe(
        `https://${target.host}:${targetPorts.https}/`
      );
      expect(member.fields.config).toMatchObject({
        ignoreTlsErrors: true,
        tlsExpiryDays: 14,
      });
    }
  });

  test("every config is one the product can read", () => {
    for (const member of fleet) {
      expect(monitorConfigSchema.safeParse(member.fields.config).success).toBe(
        true
      );
    }
  });

  test("each flapping monitor checks its own place in the schedule", () => {
    const flapping = fleet.filter((member) => member.role === "flap");
    expect(flapping.map(urlOf)).toEqual(
      flapping.map(
        (_, index) => `http://${target.host}:${targetPorts.http}/flap/${index}`
      )
    );
  });

  test("a slow monitor answers past its degraded threshold", () => {
    for (const member of fleet.filter((each) => each.role === "slow")) {
      expect(urlOf(member)).toBe(
        `http://${target.host}:${targetPorts.http}/slow`
      );
      expect(member.fields.degradedMs).toBe(degradedMs);
    }
  });

  test("TCP monitors open the target's port and DNS monitors ask the target by its address", () => {
    for (const member of fleet.filter((each) => each.role === "tcp")) {
      expect(member.fields.config).toEqual({
        host: target.host,
        port: targetPorts.tcp,
        type: "tcp",
      });
    }
    for (const member of fleet.filter((each) => each.role === "dns")) {
      expect(member.fields.config).toEqual({
        expected: dnsAddress,
        name: dnsName,
        recordType: "A",
        resolver: `${target.ip}:${targetPorts.dns}`,
        type: "dns",
      });
    }
  });

  test("heartbeat monitors expect one every twenty seconds, whatever the interval", () => {
    const fast = fixedFleet({ ...options, intervalMs: 1000 });
    for (const member of fast.filter((each) => each.role === "heartbeat")) {
      expect(member.fields.config).toEqual({
        schedule: { everyMs: heartbeatEveryMs, kind: "every" },
        type: "heartbeat",
      });
    }
  });

  test("every checked monitor runs at the interval asked, with no retries and a timeout within it", () => {
    const fast = fixedFleet({ ...options, intervalMs: 1000 });
    for (const member of fast.filter((each) => each.role !== "heartbeat")) {
      expect(member.fields.intervalMs).toBe(1000);
      expect(member.fields.retries).toBe(0);
      expect(member.fields.timeoutMs).toBeLessThanOrEqual(1000);
    }
  });

  test("the monitors that change state notify the channels, and the rest do not", () => {
    for (const member of fleet) {
      expect(member.notifies).toBe(
        member.role === "flap" ||
          member.role === "slow" ||
          member.role === "heartbeat" ||
          member.role === "docker"
      );
    }
  });

  test("each database monitor connects to its own kind of server with a URL the product accepts", () => {
    for (const kind of ["mysql", "postgres", "redis"] as const) {
      const members = fleet.filter((member) => member.role === kind);
      expect(members).toHaveLength(fixedMix[kind]);
      for (const member of members) {
        expect(member.fields.config.type).toBe(kind);
        expect(member.connectionUrl).toBe(databases[kind]);
        expect(connectionUrlFits(kind, member.connectionUrl ?? "")).toBe(true);
      }
    }
  });

  test("only database monitors carry a connection URL", () => {
    expect(
      fleet.filter((member) => member.connectionUrl !== undefined)
    ).toHaveLength(fixedMix.mysql + fixedMix.postgres + fixedMix.redis);
    for (const member of fleet) {
      const database = ["mysql", "postgres", "redis"].includes(member.role);
      expect(member.connectionUrl !== undefined).toBe(database);
    }
  });

  test("container monitors ask the target's fake Engine API for a container each, the first of them the flapping one", () => {
    const containers = fleet.filter((member) => member.role === "docker");
    expect(containers).toHaveLength(fixedMix.docker);
    expect(containers.map((member) => member.fields.config)).toEqual(
      containers.map((_, index) => ({
        container: `bench-${index}`,
        endpoint: `http://${target.host}:${targetPorts.http}`,
        type: "docker",
      }))
    );
    expect(flappingContainer).toBe("bench-0");
  });

  test("ten monitors are on the page, two flapping ones among them, so the page moves", () => {
    const onPage = fleet.filter((member) => member.onPage);
    expect(onPage).toHaveLength(pageComponents);
    expect(onPage.filter((member) => member.role === "flap")).toHaveLength(2);
  });

  test("names are unique", () => {
    expect(new Set(fleet.map((member) => member.fields.name)).size).toBe(
      fleet.length
    );
  });

  test("the mix scales with the count asked", () => {
    const small = fixedFleet({ ...options, monitors: 20 });
    expect(small).toHaveLength(20);
    expect(count(small, "flap")).toBe(1);
    expect(count(small, "https")).toBe(2);
  });

  test("a quiet fleet checks only healthy paths, so nothing it checks moves the counter", () => {
    const quiet = fixedFleet({ ...options, quiet: true });
    expect(quiet).toHaveLength(200);
    for (const member of quiet) {
      const url = urlOf(member);
      if (url !== undefined && member.role !== "https") {
        expect(url).toBe(`http://${target.host}:${targetPorts.http}/`);
      }
      const { config } = member.fields;
      if (config.type === "docker") {
        expect(config.container).not.toBe(flappingContainer);
      }
    }
  });

  test("a failing fleet of the count asked holds one monitor on the page that fails every second", () => {
    const failing = fixedFleet({ ...options, failing: true, quiet: true });
    const fail = failing.filter((member) => member.role === "fail");
    expect(failing).toHaveLength(200);
    expect(fail).toHaveLength(1);
    expect(fail[0]?.onPage).toBe(true);
    expect(fail[0]?.fields.intervalMs).toBe(1000);
    expect(fail[0] && urlOf(fail[0])).toBe(
      `http://${target.host}:${targetPorts.http}/fail`
    );
    expect(failing.filter((member) => member.onPage)).toHaveLength(
      pageComponents
    );
  });
});

describe("the fake Engine API", () => {
  /** What the product's Docker check makes of the fake daemon's answer for a container at a time. */
  async function judged(container: string, at: number) {
    const config: DockerConfig = {
      container,
      endpoint: `http://${target.host}:${targetPorts.http}`,
      type: "docker",
    };
    const outcome = await runDockerCheck(
      { config, degradedMs: undefined, id: "m1", retries: 0, timeoutMs: 1000 },
      {
        now: () => at,
        requestDocker: () =>
          Promise.resolve({
            body: containerInspect(container, at),
            status: 200,
          }),
        sleep: () => Promise.resolve(),
      }
    );
    return outcome.check.result;
  }

  /** Every fifteen seconds of one flapping period. */
  const moments = Array.from(
    { length: flapPeriodMs / 15_000 },
    (_, index) => index * 15_000
  );

  test("the flapping container is down while its schedule is down and up otherwise, as the Docker check reads it", async () => {
    const results = await Promise.all(
      moments.map((at) => judged(flappingContainer, at))
    );
    expect(results).toEqual(
      moments.map((at) => (flapIsDown(0, at) ? "down" : "up"))
    );
  });

  test("every other container runs at every moment", async () => {
    const results = await Promise.all(
      moments.flatMap((at) => [judged("bench-1", at), judged("steady-0", at)])
    );
    expect(results.every((result) => result === "up")).toBe(true);
  });

  test("answers for the container it was asked about, by the name Docker gives", () => {
    expect(containerInspect("bench-3", 0).Name).toBe("/bench-3");
  });
});

describe("the capacity sweep's monitors", () => {
  test("are plain checks of the healthy path, off the page, notifying nothing", () => {
    const fleet = capacityFleet(400, 20_000, target);
    expect(fleet).toHaveLength(400);
    for (const member of fleet) {
      expect(member.role).toBe("ok");
      expect(member.onPage).toBe(false);
      expect(member.notifies).toBe(false);
      expect(urlOf(member)).toBe(`http://${target.host}:${targetPorts.http}/`);
      expect(member.fields.intervalMs).toBe(20_000);
    }
  });
});

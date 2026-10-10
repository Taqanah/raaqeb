/**
 * The fixed run's monitors and the synthetic target's schedule.
 * Two hundred monitors across every check type plus TLS expiry, mostly
 * HTTP, a handful flapping on a phase-shifted schedule so outages, operator
 * notifications and their sends happen, two slow enough to be degraded, and
 * one container the fake Engine API reports as exited on the same schedule.
 * The target imports the schedule from here, so this file imports nothing
 * at run time: the target's container mounts the harness folder alone.
 */
import type {
  MonitorConfig,
  MonitorEventKind,
  MonitorFields,
} from "@/shared/schemas/monitor.ts";

/** The ports the synthetic target listens on inside the run's network. */
export const targetPorts = {
  dns: 5353,
  http: 8080,
  https: 8443,
  tcp: 9000,
} as const;

/** The name the DNS monitors ask for, and the address the target answers with. */
export const dnsName = "bench.test";
export const dnsAddress = "192.0.2.10";

/** A flapping monitor's target is down for `flapDownMs` of every `flapPeriodMs`, each one `flapOffsetMs` after the one before. */
export const flapPeriodMs = 300_000;
export const flapDownMs = 60_000;
export const flapOffsetMs = 30_000;

/** How long the slow path takes to answer, and the degraded threshold that makes it degraded. */
export const slowMs = 300;
export const degradedMs = 200;

/** A heartbeat monitor expects one every this long; the harness sends one twice as often. */
export const heartbeatEveryMs = 20_000;

/** What a monitor of the fleet stands for. */
export type Role =
  | "dns"
  | "docker"
  | "fail"
  | "flap"
  | "heartbeat"
  | "https"
  | "mysql"
  | "ok"
  | "postgres"
  | "redis"
  | "slow"
  | "tcp";

/** How many of each role the fixed run holds at 200 monitors; plain HTTP fills the rest. */
export const fixedMix: Readonly<Record<Exclude<Role, "fail" | "ok">, number>> =
  {
    dns: 10,
    docker: 5,
    flap: 10,
    heartbeat: 5,
    https: 20,
    mysql: 5,
    postgres: 5,
    redis: 5,
    slow: 2,
    tcp: 15,
  };

/** The container monitors' daemon answers for this one as it flaps; every other container runs. */
export const flappingContainer = "bench-0";

/** What the fake Engine API answers for `GET /containers/{name}/json`: the fields the Docker check reads. */
export interface ContainerInspect {
  readonly Name: string;
  readonly State: { readonly ExitCode: number; readonly Status: string };
}

/** The fake daemon's answer for a container at `at`: the flapping one exited while its schedule is down, any other running. */
export function containerInspect(name: string, at: number): ContainerInspect {
  const exited = name === flappingContainer && flapIsDown(0, at);
  return {
    Name: `/${name}`,
    State: exited
      ? { ExitCode: 1, Status: "exited" }
      : { ExitCode: 0, Status: "running" },
  };
}

/** The connection URLs of the run's database servers, as the install reaches them on the run's network. */
export interface DatabaseUrls {
  readonly mysql: string;
  readonly postgres: string;
  readonly redis: string;
}

/** How many components the default status page shows. */
export const pageComponents = 10;

/** One monitor of the fleet. */
export interface FleetMember {
  /** A database monitor's connection URL, its one credential; nothing for another type. */
  readonly connectionUrl: string | undefined;
  readonly fields: MonitorFields;
  /** It selects the run's email and webhook channels. */
  readonly notifies: boolean;
  /** Its component is on the status page. */
  readonly onPage: boolean;
  readonly role: Role;
}

/** Where the target answers, as the install reaches it on the run's network. */
export interface TargetAddress {
  /** The target container's name. */
  readonly host: string;
  /** The target's IP address on the network: a DNS monitor's resolver is an address, never a name. */
  readonly ip: string;
}

export interface FleetOptions {
  readonly databases: DatabaseUrls;
  /** One monitor at 1 s on the page checking `/fail`, which fails once the harness switches it: the render-per-change path's incident. */
  readonly failing: boolean;
  readonly intervalMs: number;
  readonly monitors: number;
  /** Flapping and slow monitors check the healthy path, so nothing moves the change counter. */
  readonly quiet: boolean;
  readonly target: TargetAddress;
}

/** Whether flapping monitor `index` finds its target down at `at`. */
export function flapIsDown(index: number, at: number): boolean {
  const phase = (at - index * flapOffsetMs) % flapPeriodMs;
  return (phase + flapPeriodMs) % flapPeriodMs < flapDownMs;
}

/** Every monitor event, as the form stores them by default; the run's channels hear each one. */
const allEvents: MonitorEventKind[] = [
  "down",
  "recovered",
  "degraded_started",
  "degraded_ended",
  "certificate_expiring",
];

/** The order roles are created in, and the page's share of each. */
const roleOrder = [
  "flap",
  "slow",
  "https",
  "tcp",
  "dns",
  "heartbeat",
  "postgres",
  "mysql",
  "redis",
  "docker",
] as const;
const onPageShare: Readonly<Record<Role, number>> = {
  dns: 1,
  docker: 0,
  fail: 1,
  flap: 2,
  heartbeat: 1,
  https: 1,
  mysql: 0,
  ok: pageComponents,
  postgres: 0,
  redis: 0,
  slow: 1,
  tcp: 1,
};

/** The roles that change state, so their monitor events reach the channels. */
const notifying: ReadonlySet<Role> = new Set([
  "flap",
  "slow",
  "heartbeat",
  "docker",
]);

/** The config a role checks; `quiet` points flapping and slow monitors at the healthy path. */
function configOf(
  role: Role,
  index: number,
  target: TargetAddress,
  quiet: boolean
): MonitorConfig {
  const http = (path: string, secure = false): MonitorConfig => ({
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: secure,
    method: "GET",
    type: "http",
    url: secure
      ? `https://${target.host}:${targetPorts.https}/`
      : `http://${target.host}:${targetPorts.http}${path}`,
    ...(secure ? { tlsExpiryDays: 14 } : {}),
  });
  switch (role) {
    case "docker":
      return {
        container: quiet ? `steady-${index}` : `bench-${index}`,
        endpoint: `http://${target.host}:${targetPorts.http}`,
        type: "docker",
      };
    case "mysql":
    case "postgres":
    case "redis":
      return { type: role };
    case "dns":
      return {
        expected: dnsAddress,
        name: dnsName,
        recordType: "A",
        resolver: `${target.ip}:${targetPorts.dns}`,
        type: "dns",
      };
    case "fail":
      return http("/fail");
    case "flap":
      return http(quiet ? "/" : `/flap/${index}`);
    case "heartbeat":
      return {
        schedule: { everyMs: heartbeatEveryMs, kind: "every" },
        type: "heartbeat",
      };
    case "https":
      return http("/", true);
    case "slow":
      return http(quiet ? "/" : "/slow");
    case "tcp":
      return { host: target.host, port: targetPorts.tcp, type: "tcp" };
    default:
      return http("/");
  }
}

/** One member: its fields at the interval, a timeout within it and no retries, so a 1 s monitor's checks never pile up. */
function member(
  role: Role,
  index: number,
  ordinal: number,
  intervalMs: number,
  options: {
    databases: DatabaseUrls | undefined;
    quiet: boolean;
    target: TargetAddress;
  }
): FleetMember {
  const fields: MonitorFields = {
    channels: [],
    config: configOf(role, index, options.target, options.quiet),
    events: allEvents,
    intervalMs,
    name: `Bench ${String(ordinal).padStart(5, "0")} ${role}`,
    retries: 0,
    tags: [],
    timeoutMs: Math.min(10_000, intervalMs),
    ...(role === "slow" ? { degradedMs } : {}),
  };
  const database = role === "mysql" || role === "postgres" || role === "redis";
  return {
    connectionUrl: database ? options.databases?.[role] : undefined,
    fields,
    notifies: notifying.has(role),
    onPage: false,
    role,
  };
}

/** The members with the page's share of each role marked, up to the page's size. */
function withPage(members: FleetMember[]): FleetMember[] {
  const taken = new Map<Role, number>();
  let shown = 0;
  const marked = members.map((each) => {
    const count = taken.get(each.role) ?? 0;
    const share = each.role === "ok" ? 0 : onPageShare[each.role];
    if (shown < pageComponents && count < share) {
      taken.set(each.role, count + 1);
      shown += 1;
      return { ...each, onPage: true };
    }
    return each;
  });
  return marked.map((each) => {
    if (!each.onPage && each.role === "ok" && shown < pageComponents) {
      shown += 1;
      return { ...each, onPage: true };
    }
    return each;
  });
}

/** The fixed run's monitors, the mix scaled to the count asked. */
export function fixedFleet(options: FleetOptions): FleetMember[] {
  const { intervalMs, monitors } = options;
  const roles: Role[] = options.failing ? ["fail"] : [];
  for (const role of roleOrder) {
    const count = Math.round((fixedMix[role] * monitors) / 200);
    roles.push(...Array.from({ length: count }, () => role));
  }
  roles.push(
    ...Array.from(
      { length: Math.max(0, monitors - roles.length) },
      () => "ok" as const
    )
  );
  const seen = new Map<Role, number>();
  return withPage(
    roles.map((role, ordinal) => {
      const index = seen.get(role) ?? 0;
      seen.set(role, index + 1);
      return member(
        role,
        index,
        ordinal + 1,
        role === "fail" ? 1000 : intervalMs,
        options
      );
    })
  );
}

/** The capacity sweep's monitors: plain HTTP checks of the healthy path, nothing on a page. */
export function capacityFleet(
  monitors: number,
  intervalMs: number,
  target: TargetAddress
): FleetMember[] {
  return Array.from({ length: monitors }, (_, index) =>
    member("ok", index, index + 1, intervalMs, {
      databases: undefined,
      quiet: true,
      target,
    })
  );
}

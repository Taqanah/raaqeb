/**
 * A monitor's stored shape (CONTEXT.md "Monitor"): what
 * the form posts and the list reads. The check-type part is one JSON text
 * column parsed here at the edge, a union on the check type, so
 * adding a field to one type is a schema change and never a migration. The
 * credentials of an HTTP monitor (basic auth, bearer, custom headers) and a
 * database monitor's connection URL are not here: they are one encrypted
 * column beside this one (credentials.ts), posted with the form and never
 * read back into a `Monitor`.
 */
import { z } from "zod";
import { isCronExpression } from "@/shared/domain/cron.ts";
import { parseJsonPath } from "@/shared/domain/jsonpath.ts";
import {
  defaultMongoCommand,
  mongoPort,
  mongoUrlFits,
  readOnlyCommandOf,
} from "@/shared/domain/mongodb.ts";
import type { ChannelChoice } from "./channel.ts";
import type { CaptureHeader, CheckResult } from "./check.ts";
import {
  type CredentialsView,
  connectionUrlMaxLength,
  credentialsInputSchema,
} from "./credentials.ts";
import type { HeartbeatView } from "./heartbeat.ts";
import type { OverviewDay } from "./overview.ts";
import {
  observedMaxLength,
  type ReasonName,
  type ReasonParams,
} from "./reason.ts";

export const checkTypes = [
  "http",
  "tcp",
  "dns",
  "postgres",
  "mysql",
  "redis",
  "mongodb",
  "docker",
  "heartbeat",
] as const;
export const checkTypeSchema = z.enum(checkTypes);
export type CheckType = z.infer<typeof checkTypeSchema>;

/** The check types of a database monitor (CONTEXT.md "Database monitor"). */
export const databaseCheckTypes = [
  "postgres",
  "mysql",
  "redis",
  "mongodb",
] as const;
export type DatabaseCheckType = (typeof databaseCheckTypes)[number];

/** Whether the check type is a database monitor's. */
export function isDatabaseCheckType(type: string): type is DatabaseCheckType {
  return databaseCheckTypes.some((each) => each === type);
}

/** The six monitor events (CONTEXT.md "Monitor event"), in the order the form lists them. */
export const monitorEventKinds = [
  "down",
  "recovered",
  "degraded_started",
  "degraded_ended",
  "certificate_expiring",
  "domain_expiring",
] as const;
export type MonitorEventKind = (typeof monitorEventKinds)[number];

/** A reminder repeats "still down" no more often than this and no less often than once a day. */
export const reminderMinMs = 5 * 60_000;
export const reminderMaxMs = 86_400_000;
/** A reminder switched on repeats every hour until the operator picks another interval. */
export const reminderDefaultMs = 3_600_000;

/** The schedule limits, in milliseconds. */
export const intervalMinMs = 20_000;
export const intervalMaxMs = 86_400_000;
export const timeoutMinMs = 1000;
export const timeoutMaxMs = 60_000;
export const retriesMax = 10;
export const monitorDefaults = {
  intervalMs: 60_000,
  retries: 2,
  timeoutMs: 10_000,
} as const;

export const nameMaxLength = 120;
export const descriptionMaxLength = 1000;
export const groupNameMaxLength = 60;
export const tagMaxLength = 40;
export const tagsMax = 20;
/** More channels than any install has; the bound keeps a posted list finite. */
export const channelsMax = 100;

/** A monitor's retention override in days; absent follows the install default. */
export const retentionDaysMin = 1;
export const retentionDaysMax = 3650;
/** The retention an install starts with, and the least an audit entry is kept. */
export const retentionDefaultDays = 90;

/** A name a person typed: trimmed, one line, never empty. */
const label = (max: number) => z.string().trim().min(1).max(max);

/** A Latin or an Arabic comma, between tags and between status codes: the form splits its tags on one, so a tag it saves never holds one. */
export const listSeparator = /[,،]/;

// HTTP. A status set entry is a class (`2xx`), a code (`204`) or
// a range (`200-299`); the check assertions read this grammar.
export const statusSetEntry = /^([1-5]xx|[1-5]\d\d(-[1-5]\d\d)?)$/;
export const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** Whether the text compiles as the evaluator builds it, `new RegExp(pattern)`. */
function compiles(pattern: string): boolean {
  try {
    return new RegExp(pattern) instanceof RegExp;
  } catch {
    return false;
  }
}

export const assertionSchema = z.discriminatedUnion("kind", [
  z.object({
    codes: z.array(z.string().regex(statusSetEntry)).min(1),
    kind: z.literal("status"),
  }),
  z.object({ kind: z.literal("body_contains"), text: z.string().min(1) }),
  z.object({ kind: z.literal("body_not_contains"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("json_equals"),
    path: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("json_matches"),
    path: z.string().min(1),
    // A pattern that does not compile would fail every check.
    pattern: z.string().min(1).refine(compiles),
  }),
  z.object({
    kind: z.literal("header_equals"),
    name: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("response_time_under"),
    ms: z.int().positive().max(timeoutMaxMs),
  }),
]);
export type Assertion = z.infer<typeof assertionSchema>;

/** The default success rules: status code in 2xx. */
export const defaultAssertions: readonly Assertion[] = [
  { codes: ["2xx"], kind: "status" },
];

const httpProtocol = /^https?$/;

/** A user name, a password, or both: `http://:secret@host/` carries a credential with no name. */
function hasCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/** Stored only when off, so a monitor saved before the option has it on. */
const domainExpirySchema = z.literal(false).optional();

export const captureModes = ["off", "on_failure", "always"] as const;
export const captureModeSchema = z.enum(captureModes);
export type CaptureMode = z.infer<typeof captureModeSchema>;

/** Room for a proxy's address, as for a connection URL. */
export const proxyUrlMaxLength = 2048;

/** A PEM certificate: the text starts with its armour, whose contents are the server's to read. */
const certificatePattern = /^-----BEGIN CERTIFICATE-----/;

/** Why a custom CA or a client certificate and an https proxy do not go together: Bun checks the proxy with the same CA and hands it the certificate. */
export const tlsProxyMessage =
  "a custom CA or client certificate cannot go through an https proxy";
/** Room for a leaf and a few intermediates. */
export const clientCertificateMaxLength = 16_384;
/** Room for a private CA's chain, or a handful of them. */
export const caBundleMaxLength = 65_536;

export const httpConfigSchema = z.object({
  assertions: z
    .array(assertionSchema)
    .min(1)
    .default([...defaultAssertions]),
  // Absent or text: an empty body would read back from the form as absent.
  body: z.string().min(1).max(65_536).optional(),
  /** CA certificates in PEM, which the check trusts in place of the well-known ones; public, so kept in clear. */
  caCertificates: z
    .string()
    .regex(certificatePattern)
    .max(caBundleMaxLength)
    .optional(),
  captureMode: captureModeSchema.default("off"),
  /** The client certificate in PEM (the leaf, then any intermediates) the check presents; public, so kept in clear. Its private key is a sealed credential. */
  clientCertificate: z
    .string()
    .regex(certificatePattern)
    .max(clientCertificateMaxLength)
    .optional(),
  /** The domain expiry option: absent means on, the default; `false` switches it off. */
  domainExpiry: domainExpirySchema,
  followRedirects: z.boolean().default(true),
  ignoreTlsErrors: z.boolean().default(false),
  method: z.enum(httpMethods).default("GET"),
  /** The monitor's own proxy, http or https, which overrides the install's environment (CONTEXT.md "Outbound proxy"); its user name and password are sealed in the credentials, never in this URL. */
  proxy: z
    .url({ protocol: httpProtocol })
    .max(proxyUrlMaxLength)
    .refine((url) => !(URL.canParse(url) && hasCredentials(new URL(url))), {
      message: "a proxy URL with a user name or a password is refused",
    })
    .optional(),
  /** Days before expiry that warn; absent means the option is off (default 14). */
  tlsExpiryDays: z.int().min(1).max(365).optional(),
  type: z.literal("http"),
  // A user name or a password in the URL would be a credential stored in clear; the form takes them as sealed credentials.
  // Zod runs every check even after the format failed, so the parse is guarded.
  // Not `z.httpUrl()`: it wants a domain with a top-level label, which refuses an IP address and localhost.
  url: z
    .url({ protocol: httpProtocol })
    .refine((url) => !(URL.canParse(url) && hasCredentials(new URL(url))), {
      message: "a URL with a user name or a password is refused",
    }),
});
export type HttpConfig = z.infer<typeof httpConfigSchema>;

const ipv4 = z.ipv4();
const ipv6 = z.ipv6();

export const tcpConfigSchema = z.object({
  /** The domain expiry option: absent means on, the default; `false` switches it off. */
  domainExpiry: domainExpirySchema,
  /** A host name, an IPv4 address or an IPv6 address without brackets, as the socket takes it. */
  host: z.union([z.hostname(), ipv6]),
  port: z.int().min(1).max(65_535),
  type: z.literal("tcp"),
});
export type TcpConfig = z.infer<typeof tcpConfigSchema>;

const withPort = /^(?:\[(?<v6>[^\]]+)\]|(?<v4>[\d.]+)):(?<port>\d{1,5})$/;

/** An IP address, `192.0.2.53:5353` or `[2001:db8::1]:53`: what `setServers` accepts, never a host name. */
function isResolverAddress(text: string): boolean {
  if (ipv4.safeParse(text).success || ipv6.safeParse(text).success) {
    return true;
  }
  const match = withPort.exec(text)?.groups;
  if (!match) {
    return false;
  }
  const port = Number(match.port);
  const host =
    match.v6 === undefined
      ? ipv4.safeParse(match.v4)
      : ipv6.safeParse(match.v6);
  return host.success && port >= 1 && port <= 65_535;
}

export const dnsRecordTypes = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
] as const;
export type DnsRecordType = (typeof dnsRecordTypes)[number];
// Zod's hostname rule with `_` in the label alphabet: a record under `_dmarc` or `selector._domainkey` is a name to query, not a host (RFC 2181 section 11). A hyphen still cannot start or end a label.
const dnsLabel = String.raw`\w(?:[\w-]{0,61}\w)?`;
const dnsName = new RegExp(
  String.raw`^(?=.{1,253}\.?$)${dnsLabel}(?:\.${dnsLabel})*\.?$`
);

export const dnsConfigSchema = z.object({
  /** The domain expiry option: absent means on, the default; `false` switches it off. */
  domainExpiry: domainExpirySchema,
  expected: z.string().trim().min(1).optional(),
  name: z.string().regex(dnsName),
  recordType: z.enum(dnsRecordTypes).default("A"),
  /** A resolver address as `node:dns` takes it; absent means the system's resolver. */
  resolver: z.string().trim().min(1).refine(isResolverAddress).optional(),
  type: z.literal("dns"),
});
export type DnsConfig = z.infer<typeof dnsConfigSchema>;

/** A heartbeat monitor's "every N" runs from the shortest interval to 30 days; a longer schedule is a cron expression. */
export const heartbeatPeriodMaxMs = 30 * 86_400_000;
export const cronMaxLength = 120;

/** "Every N" or a cron expression in Bun's grammar, read in the install time zone. */
export const heartbeatScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    everyMs: z.int().min(intervalMinMs).max(heartbeatPeriodMaxMs),
    kind: z.literal("every"),
  }),
  z.object({
    expression: z
      .string()
      .trim()
      .min(1)
      .max(cronMaxLength)
      .refine(isCronExpression),
    kind: z.literal("cron"),
  }),
]);
export type HeartbeatSchedule = z.infer<typeof heartbeatScheduleSchema>;

export const heartbeatConfigSchema = z.object({
  /** Absent means a fifth of the period (CONTEXT.md "Grace period"). */
  graceMs: z.int().positive().max(heartbeatPeriodMaxMs).optional(),
  schedule: heartbeatScheduleSchema,
  type: z.literal("heartbeat"),
});
export type HeartbeatConfig = z.infer<typeof heartbeatConfigSchema>;

/** The schemes a connection URL may start with, by check type; Bun's drivers read each. */
export const connectionUrlSchemes: Readonly<
  Record<DatabaseCheckType, readonly string[]>
> = {
  mysql: ["mysql:", "mariadb:"],
  postgres: ["postgres:", "postgresql:"],
  redis: ["redis:", "rediss:"],
  mongodb: ["mongodb:", "mongodb+srv:"],
};

/** The port a connection URL without one reaches, by check type. */
export const databasePorts: Readonly<Record<DatabaseCheckType, number>> = {
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
  mongodb: mongoPort,
};

export const queryMaxLength = 4000;

/** What a database monitor without a query runs. */
export const defaultQueries: Readonly<Record<DatabaseCheckType, string>> = {
  mysql: "SELECT 1",
  postgres: "SELECT 1",
  redis: "PING",
  mongodb: defaultMongoCommand,
};

/** Whether a connection URL fits the check type: one of its schemes, and a host to reach. */
export function connectionUrlFits(
  type: DatabaseCheckType,
  url: string
): boolean {
  if (type === "mongodb") {
    return mongoUrlFits(url);
  }
  if (!URL.canParse(url)) {
    return false;
  }
  // A URL without a host would leave the driver to fill it from the environment, which names Raaqeb's own database.
  const { hostname, pathname, protocol, searchParams } = new URL(url);
  return (
    connectionUrlSchemes[type].includes(protocol) &&
    hostname !== "" &&
    // Bun's SQL driver reads a percent-escaped host as a Unix socket's path; a host reached over TCP has none.
    !hostname.includes("%") &&
    [...searchParams].every(
      ([key, value]) =>
        !hostKeys[type]?.includes(key.toLowerCase()) ||
        (key.toLowerCase() === "sslrootcert" && value === "system")
    ) &&
    // Bun's Redis client takes a database number or none, and refuses a name before connecting.
    (type !== "redis" || redisDatabase.test(pathname))
  );
}

const redisDatabase = /^\/?\d*$/;

/** The query keys Bun's SQL driver (1.4.5) reads as a Unix socket or a file on the install's own host, or as another host or port than the URL's; `sslrootcert=system` names the system's CAs. */
const hostKeys: Partial<Record<DatabaseCheckType, readonly string[]>> = {
  mysql: ["path", "socket"],
  postgres: [
    "host",
    "path",
    "port",
    "socket",
    "sslcert",
    "sslkey",
    "sslrootcert",
  ],
};

/**
 * A database monitor's config: the query and the expected value,
 * both optional. The connection URL is a credential and is not here; the
 * address is what the monitors module writes from it, its host and port
 * alone, so the list can name what the check reaches.
 */
const databaseConfigShape = {
  /** `host:port` of the connection URL, written by the server, never posted by the form. */
  address: z.string().min(1).max(connectionUrlMaxLength).optional(),
  /** The first value the query answers must equal this text; absent accepts any answer. */
  expected: z.string().trim().min(1).max(observedMaxLength).optional(),
  /** SQL, a Redis command and its arguments, or a MongoDB command as JSON; absent runs `SELECT 1`, `PING` or `{"ping": 1}`. */
  query: z.string().trim().min(1).max(queryMaxLength).optional(),
};
export const postgresConfigSchema = z.object({
  ...databaseConfigShape,
  type: z.literal("postgres"),
});
export const mysqlConfigSchema = z.object({
  ...databaseConfigShape,
  type: z.literal("mysql"),
});
export const redisConfigSchema = z.object({
  ...databaseConfigShape,
  type: z.literal("redis"),
});
/** A MongoDB monitor's command is one that only reads, wherever the config comes from: the form, the API or an import. */
export const mongodbConfigSchema = z.object({
  ...databaseConfigShape,
  query: databaseConfigShape.query.refine(
    (query) => query === undefined || readOnlyCommandOf(query) !== undefined,
    "a MongoDB command that only reads"
  ),
  type: z.literal("mongodb"),
});
export type DatabaseConfig =
  | z.infer<typeof postgresConfigSchema>
  | z.infer<typeof mysqlConfigSchema>
  | z.infer<typeof redisConfigSchema>
  | z.infer<typeof mongodbConfigSchema>;

/** Where a Docker monitor reaches the daemon when the form says nothing else. */
export const dockerSocketPath = "/var/run/docker.sock";
export const dockerEndpointMaxLength = 2048;
/** Docker's own rule for a container name, its leading slash left out. */
export const containerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
export const containerNameMaxLength = 255;

/** A Unix socket's absolute path, or the http or https URL of a Docker Engine API with no credentials, query or fragment. */
export function isDockerEndpoint(text: string): boolean {
  if (isSocketPath(text)) {
    return true;
  }
  // An empty query or fragment parses as none, yet the request is built from the text.
  const url = queryOrFragment.test(text) ? null : URL.parse(text);
  return (
    url !== null &&
    httpProtocol.test(url.protocol.slice(0, -1)) &&
    url.hostname !== "" &&
    !hasCredentials(url) &&
    url.search === "" &&
    url.hash === ""
  );
}

const queryOrFragment = /[?#]/;

/** Whether the endpoint is a Unix socket's path rather than a URL. */
export function isSocketPath(endpoint: string): boolean {
  return endpoint.startsWith("/");
}

const dockerEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(dockerEndpointMaxLength)
  .refine(isDockerEndpoint);

/**
 * A Docker monitor's config (CONTEXT.md "Container monitor"): the
 * daemon's endpoint and the container's name, which survives a recreate as
 * compose does it, where an id does not.
 */
export const dockerConfigSchema = z.object({
  container: z
    .string()
    .trim()
    .max(containerNameMaxLength)
    .regex(containerNamePattern),
  endpoint: dockerEndpointSchema,
  type: z.literal("docker"),
});
export type DockerConfig = z.infer<typeof dockerConfigSchema>;

export const monitorConfigSchema = z.discriminatedUnion("type", [
  httpConfigSchema,
  tcpConfigSchema,
  dnsConfigSchema,
  postgresConfigSchema,
  mysqlConfigSchema,
  redisConfigSchema,
  mongodbConfigSchema,
  dockerConfigSchema,
  heartbeatConfigSchema,
]);
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;

/** Whether the config is a database monitor's. */
export function isDatabaseConfig(
  config: MonitorConfig
): config is DatabaseConfig {
  return isDatabaseCheckType(config.type);
}

/** The id of the main location among a monitor's locations (CONTEXT.md "Main location"); a probe's id is a UUIDv7 and never this. */
export const mainLocation = "main";
/** More probes than any install runs; the bound keeps a monitor's location list finite. */
export const probesMax = 20;
/** A monitor's locations: the main one and every probe. */
export const locationsMax = probesMax + 1;

/** The check types a probe runs: not Docker, whose daemon is the install's host, and not heartbeat, which the install receives. */
export const probeCheckTypes = [
  "http",
  "tcp",
  "dns",
  "postgres",
  "mysql",
  "redis",
  "mongodb",
] as const satisfies readonly CheckType[];

export function checkableByProbe(type: CheckType): boolean {
  return probeCheckTypes.some((each) => each === type);
}

/** A monitor's stored fields: everything the form posts but its credentials. */
export const monitorFieldsSchema = z.object({
  /** The ids of the notification channels the monitor selects; a channel deleted since is skipped on save. */
  channels: z.array(z.string().min(1)).max(channelsMax).default([]),
  config: monitorConfigSchema,
  /** How many of its locations must see it down (CONTEXT.md "Confirmation count"); absent is one. */
  confirmations: z.int().min(1).max(locationsMax).optional(),
  /** A response time; never above the longest timeout, so it fits a 32-bit column on Postgres. */
  degradedMs: z.int().positive().max(timeoutMaxMs).optional(),
  description: z.string().trim().max(descriptionMaxLength).optional(),
  /** The monitor events that notify the selected channels, in the canonical order; all six by default. The degraded pair and the two expiring events notify only where they can happen (shared/domain/events.ts). */
  events: z
    .array(z.enum(monitorEventKinds))
    .transform((kinds) =>
      monitorEventKinds.filter((kind) => kinds.includes(kind))
    )
    .default([...monitorEventKinds]),
  group: label(groupNameMaxLength).optional(),
  intervalMs: z
    .int()
    .min(intervalMinMs)
    .max(intervalMaxMs)
    .describe(
      "How often the check runs, in milliseconds. A heartbeat monitor is judged by its schedule's windows instead: send the default, 60000."
    ),
  name: label(nameMaxLength),
  /** Absent follows the install default. */
  retentionDays: z.int().min(retentionDaysMin).max(retentionDaysMax).optional(),
  /** Where it is checked from (CONTEXT.md "Location"), the main location first; absent is the main location alone. */
  locations: z
    .array(z.string().min(1))
    .min(1)
    .max(locationsMax)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
  /** How often a reminder repeats "still down" while the monitor stays down; absent means off. */
  reminderMs: z.int().min(reminderMinMs).max(reminderMaxMs).optional(),
  retries: z
    .int()
    .min(0)
    .max(retriesMax)
    .describe(
      "How many times one check tries again before it is down. A heartbeat monitor has no check to repeat: send the default, 2."
    ),
  /** Whether its sealed credentials travel to its probes; absent never. */
  shareCredentials: z.boolean().optional(),
  tags: z.array(label(tagMaxLength)).max(tagsMax).default([]),
  timeoutMs: z
    .int()
    .min(timeoutMinMs)
    .max(timeoutMaxMs)
    .describe(
      "How long one attempt may take, in milliseconds. A heartbeat monitor has no check to time out: send the default, 10000."
    ),
});
export type MonitorFields = z.infer<typeof monitorFieldsSchema>;

/** The paths whose refusal leaves no assertion list to read: the input, its config and the list itself. */
const assertionListPaths = ["", "config", "config.assertions"];

/** A rule over the assertions runs beside the other fields' refusals, even one inside an assertion, unless the list itself could not be read. */
const refuseBesideOtherFields = {
  when: (payload: { readonly issues: readonly z.core.$ZodRawIssue[] }) =>
    payload.issues.every(
      (issue) => !assertionListPaths.includes((issue.path ?? []).join("."))
    ),
};

/** The rules of an HTTP monitor's TLS material: a CA or certificate does not go through an https proxy (Bun has no TLS option of its own for a proxy: the CA would verify the proxy and the certificate would be presented to it), a key is a certificate's, and a certificate is presented over https. */
function refineTls(
  input: {
    readonly config: MonitorConfig;
    readonly credentials?: { readonly clientKey?: unknown } | undefined;
  },
  context: z.RefinementCtx
): void {
  const { config, credentials } = input;
  const refuse = (message: string, path: (string | number)[]) =>
    context.addIssue({ code: "custom", message, path });
  if (
    config.type === "http" &&
    config.proxy !== undefined &&
    URL.canParse(config.proxy) &&
    new URL(config.proxy).protocol === "https:"
  ) {
    for (const field of ["caCertificates", "clientCertificate"] as const) {
      if (config[field] !== undefined) {
        refuse(tlsProxyMessage, ["config", field]);
      }
    }
  }
  if (
    credentials?.clientKey !== undefined &&
    !(config.type === "http" && config.clientCertificate !== undefined)
  ) {
    refuse("a client key needs a client certificate", [
      "credentials",
      "clientKey",
    ]);
  }
  if (
    config.type === "http" &&
    config.clientCertificate !== undefined &&
    URL.canParse(config.url) &&
    new URL(config.url).protocol !== "https:"
  ) {
    refuse("a client certificate needs an https URL", [
      "config",
      "clientCertificate",
    ]);
  }
}

/**
 * What create and edit post: the fields and the credentials. A JSON path the
 * check cannot read is refused here, not in the stored config, so a monitor
 * saved before the rule still reads and is refused on its next save.
 */
export const monitorInputSchema = monitorFieldsSchema
  .extend({ credentials: credentialsInputSchema.optional() })
  .superRefine((input, context) => {
    const { config, credentials } = input;
    // A URL the posted check type cannot read is refused on its field; one left out keeps the stored URL, which the server checks.
    if (
      isDatabaseCheckType(config.type) &&
      typeof credentials?.url === "string" &&
      !connectionUrlFits(config.type, credentials.url)
    ) {
      context.addIssue({
        code: "custom",
        message: "a connection URL this check type cannot read",
        path: ["credentials", "url"],
      });
    }
    refineTls(input, context);
    // A proxy's user name and password go with a proxy that is there to ask for them.
    if (
      credentials?.proxyAuth !== undefined &&
      !(config.type === "http" && config.proxy !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "a proxy user name and password need a proxy",
        path: ["credentials", "proxyAuth"],
      });
    }
    refuseLocations(input, context);
    if (config.type !== "http") {
      return;
    }
    for (const [index, assertion] of config.assertions.entries()) {
      // An assertion refused on its own may be anything, so only a JSON one with a text path is read.
      if (
        typeof assertion === "object" &&
        assertion !== null &&
        (assertion.kind === "json_equals" ||
          assertion.kind === "json_matches") &&
        typeof assertion.path === "string" &&
        parseJsonPath(assertion.path) === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "a JSON path the check cannot read",
          path: ["config", "assertions", index, "path"],
        });
      }
    }
  }, refuseBesideOtherFields);
export type MonitorInput = z.infer<typeof monitorInputSchema>;

/** A monitor's locations as they are checked: the stored list, or the main location alone. */
export function locationsOf(
  monitor: Pick<MonitorFields, "locations">
): readonly string[] {
  return monitor.locations ?? [mainLocation];
}

/** The locations' rules: a probe checks only the check types it can, a database monitor only with its credentials shared, and a monitor needs no more confirmations than it has locations. */
function refuseLocations(
  input: Pick<
    MonitorFields,
    "config" | "confirmations" | "locations" | "shareCredentials"
  >,
  context: z.core.$RefinementCtx
): void {
  const locations = input.locations ?? [mainLocation];
  const probes = locations.some((id) => id !== mainLocation);
  if (probes && !checkableByProbe(input.config.type)) {
    context.addIssue({
      code: "custom",
      message: "a probe cannot check this check type",
      path: ["locations"],
    });
  }
  if (
    probes &&
    isDatabaseCheckType(input.config.type) &&
    !input.shareCredentials
  ) {
    context.addIssue({
      code: "custom",
      message: "a probe checks a database monitor only with its credentials",
      path: ["shareCredentials"],
    });
  }
  if ((input.confirmations ?? 1) > locations.length) {
    context.addIssue({
      code: "custom",
      message: "more confirmations than locations",
      path: ["confirmations"],
    });
  }
}

/** A monitor as the list and the detail read it. */
export interface Monitor extends MonitorFields {
  readonly createdAt: number;
  readonly id: string;
  readonly paused: boolean;
  /** When it was paused; nothing while it runs. A component whose linked monitors are all paused keeps the status the ones paused last derive. */
  readonly pausedAt?: number;
  /** The URL, `host:port`, name or container the check reaches; a heartbeat monitor has none. */
  readonly target: string | undefined;
  readonly updatedAt: number;
}

/** A monitor as the command palette offers it: what the search reads, and its id for the detail page. */
export type MonitorChoice = Pick<Monitor, "id" | "name" | "target">;

export type MonitorChoicesResult =
  | { readonly ok: true; readonly monitors: readonly MonitorChoice[] }
  | { readonly ok: false; readonly reason: "unavailable" };

export const monitorSorts = ["name", "newest"] as const;
export const monitorSortSchema = z.enum(monitorSorts);
export type MonitorSort = z.infer<typeof monitorSortSchema>;

/** A search text from the address; the router reads `?q=6379` as a number, so a number is taken as its text. */
const searchText = z
  .preprocess(
    (value) => (typeof value === "number" ? String(value) : value),
    z.string().trim().min(1).optional()
  )
  .catch(undefined);

/** The list's search parameters (`/admin/monitors?q=&group=&tag=&sort=`); an absent one means no filter. */
export const monitorListSearchSchema = z.object({
  group: searchText,
  q: searchText,
  sort: monitorSortSchema.optional().catch(undefined),
  tag: searchText,
});
export type MonitorListSearch = z.infer<typeof monitorListSearchSchema>;

/** As many ids as the list shows: a select-all on a large install is one call. */
export const monitorIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
export type MonitorIdsInput = z.infer<typeof monitorIdsSchema>;

/** A tag the selection bar adds: as the form saves one, with no comma. */
export const addedTagSchema = label(tagMaxLength).refine(
  (name) => !listSeparator.test(name)
);

/** What the selection bar changes on every selected monitor; a monitor that already has it, or lacks what is removed, is left as it is. */
export const monitorChangeSchema = z.discriminatedUnion("kind", [
  z.object({ channel: z.string().min(1), kind: z.literal("add_channel") }),
  z.object({ channel: z.string().min(1), kind: z.literal("remove_channel") }),
  /** No group takes the monitors out of theirs. */
  z.object({
    group: label(groupNameMaxLength).optional(),
    kind: z.literal("set_group"),
  }),
  z.object({ kind: z.literal("add_tag"), tag: addedTagSchema }),
  z.object({ kind: z.literal("remove_tag"), tag: label(tagMaxLength) }),
]);
export type MonitorChange = z.infer<typeof monitorChangeSchema>;

/** A group to end, by its name: its monitors leave it. */
export const groupNameSchema = z.object({ group: label(groupNameMaxLength) });

export const monitorChangeInputSchema = monitorIdsSchema.extend({
  change: monitorChangeSchema,
});
export type MonitorChangeInput = z.infer<typeof monitorChangeInputSchema>;

export const monitorEditSchema = z.object({
  id: z.string().min(1),
  input: monitorInputSchema,
  /** A heartbeat monitor gets a new token on this save; the old URL stops working. */
  renewHeartbeatUrl: z.boolean().optional(),
});
export type MonitorEditInput = z.infer<typeof monitorEditSchema>;

/** Why a monitor write did not happen. */
export type MonitorRefusal =
  | "invalid"
  /** No monitor has that id. */
  | "not_found"
  /** No database is open, or it did not answer. */
  | "unavailable";

/** Why a monitor save or "test now" did not happen: any refusal, or a TLS credential the server cannot use. */
export type MonitorSaveRefusal =
  | MonitorRefusal
  /** The client certificate, its key or its passphrase cannot be used: not PEM, a key that is not the certificate's, a passphrase that does not open it, or a certificate with no key. */
  | "client_certificate"
  /** The CA certificates are not PEM certificates. */
  | "ca_certificates";

/** What the form reads beside the monitor: the names it may suggest and the install default it shows. */
export interface MonitorFormOptions {
  /** Every channel, in creation order; a new monitor starts with those that apply to new monitors. */
  readonly channels: readonly ChannelChoice[];
  readonly groups: readonly string[];
  /** Every probe a monitor may be checked from, in the order they were made. */
  readonly probes: readonly { readonly id: string; readonly name: string }[];
  /** The install-wide retention a monitor without an override follows. */
  readonly retentionDefaultDays: number;
  readonly tags: readonly string[];
}

/** The monitor a duplicate starts from: its fields and whether it has credentials, never them. */
export interface MonitorOriginal {
  /** Whether it has credentials, which the operator types again. */
  readonly hadCredentials: boolean;
  readonly monitor: Monitor;
}

/** The form's read: a monitor to edit, or none for a new one, with the names of its stored credentials. */
export type MonitorFormResult =
  | {
      readonly ok: true;
      readonly credentials: CredentialsView;
      /** A stored heartbeat monitor's URL and last heartbeat; none for a new monitor or another check type. */
      readonly heartbeat: HeartbeatView | undefined;
      readonly monitor: Monitor | undefined;
      readonly options: MonitorFormOptions;
      /** The monitor a new one duplicates; none for an edit, a blank form, or an original that no longer exists. */
      readonly original: MonitorOriginal | undefined;
    }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" }
  /** A stored monitor's config no longer fits this version's schema; `id` names it. */
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string };

export const monitorFormReadSchema = z.object({
  /** The monitor a new one duplicates; an edit's `id` wins. */
  copy: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
});

/** The new-monitor form's search parameters: `?copy=<id>` starts it from that monitor. */
export const newMonitorSearchSchema = z.object({
  copy: z.string().min(1).optional().catch(undefined),
});

/** What "test now" posts: the form as it stands, and the monitor it edits so a kept secret can be read. */
export const monitorTestSchema = z.object({
  id: z.string().min(1).optional(),
  input: monitorInputSchema,
});

/** One check the form ran and nothing recorded: what the scheduler would have stored, and what the response showed. */
export interface MonitorTest {
  /** The address a TCP check connected to; never stored. */
  readonly address?: string | undefined;
  /** The first value a database check's query answered, as text cut as an observed value is; never stored. */
  readonly answer?: string | undefined;
  readonly bytes: number;
  /** Set on a down check: the failure detail's content. */
  readonly failure:
    | {
        readonly assertion: Assertion | undefined;
        readonly error: string | undefined;
        readonly params: ReasonParams;
      }
    | undefined;
  readonly reason: ReasonName;
  /** The records a DNS check's resolver answered, each as one line of text; never stored. */
  readonly records?: readonly string[] | undefined;
  /** An HTTP response as a capture keeps it: headers redacted, the first 4 KB of the body as text. */
  readonly response:
    | {
        readonly body: string;
        readonly headers: readonly CaptureHeader[];
      }
    | undefined;
  readonly responseMs: number | undefined;
  readonly result: CheckResult;
  readonly statusCode: number | undefined;
}

/** What the form's container list posts: the endpoint the form holds. */
export const containerListSchema = z.object({ endpoint: dockerEndpointSchema });

/** One container the daemon lists, as the form offers it: its name first, then its state and image as Docker words them. */
export interface ContainerChoice {
  readonly image: string;
  readonly name: string;
  readonly state: string;
}

/** The daemon's containers by name, or why they could not be listed, as a check's reason would say it. */
export type ContainerListResult =
  | { readonly ok: true; readonly containers: readonly ContainerChoice[] }
  | {
      readonly ok: false;
      readonly error: string | undefined;
      readonly params: ReasonParams;
      readonly reason: ReasonName;
    };

export type MonitorTestResult =
  | { readonly ok: true; readonly test: MonitorTest }
  | { readonly ok: false; readonly reason: MonitorSaveRefusal };

export type MonitorSaveResult =
  | { readonly ok: true; readonly monitor: Monitor }
  | { readonly ok: false; readonly reason: MonitorSaveRefusal };

/** A bulk action's answer: how many monitors it reached. A change names a channel that does not exist as not found, and a tag one of the monitors has no room for as tags full. */
export type MonitorBulkResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: MonitorRefusal | "tags_full" };

/** The current state of each monitor that has a check, by id (CONTEXT.md "Monitor": up, degraded or down while active). */
export type MonitorStates = Readonly<Record<string, CheckResult>>;

/** The getting-started checklist's lines, each whether its thing exists. */
export interface GettingStarted {
  /** A notification channel exists. */
  readonly channel: boolean;
  /** A component is linked to at least one monitor. */
  readonly link: boolean;
  /** A monitor exists. */
  readonly monitor: boolean;
  /** A status page is published. */
  readonly published: boolean;
}

export type MonitorListResult =
  | {
      /** The monitors with an open outage nobody acknowledged, each with when that outage started, which the item menu offers to acknowledge. */
      readonly acknowledgeable: Readonly<Record<string, number>>;
      /** Every channel, in creation order, for the selection bar's channel actions. */
      readonly channels: readonly ChannelChoice[];
      /** The monitors a maintenance window in progress covers now, which notify nothing. */
      readonly covered: readonly string[];
      /** The getting-started checklist above the list; none once the operator dismissed it or every line is done. */
      readonly gettingStarted: GettingStarted | undefined;
      /** The heartbeat monitors with no check yet that have heard a heartbeat: their first window is open. */
      readonly heard: readonly string[];
      readonly ok: true;
      /** Each monitor's last 14 UTC days for its bar, by id; none when a part of them could not be read. */
      readonly days: Readonly<Record<string, readonly OverviewDay[]>>;
      readonly monitors: readonly Monitor[];
      readonly states: MonitorStates;
      /** The monitors checked from probes alone whose latest check is past its bound: no location has a recent result, so they have no state. */
      readonly unknown: readonly string[];
    }
  | { readonly ok: false; readonly reason: "unavailable" }
  /** A stored monitor's config no longer fits this version's schema; `id` names it. */
  | { readonly ok: false; readonly reason: "corrupt"; readonly id: string };

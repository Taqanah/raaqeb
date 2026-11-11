/**
 * A MongoDB connection URL and command as the database monitor reads them
 * (CONTEXT.md "Database monitor"). The URL is taken apart by MongoDB's
 * connection string specification, not by `URL`, which refuses a seed list
 * of several hosts; the options the monitor acts on are typed by the URI
 * options specification, every other one is kept and ignored. The command is a
 * JSON document whose first key names a command on the read-only list. Pure:
 * the save rule and the check both read it.
 */

/** The port a host without one reaches. */
export const mongoPort = 27_017;

/** One server a connection URL names. */
export interface MongoHost {
  readonly host: string;
  readonly port: number;
}

/** A connection URL taken apart, before any option has a meaning. */
export interface ConnectionString {
  readonly database: string | undefined;
  /** For `mongodb+srv`, the one name the SRV lookup asks about, on the default port. */
  readonly hosts: readonly MongoHost[];
  /** Each option once, its key in lower case, its value decoded; a repeated key keeps its last value. */
  readonly options: ReadonlyMap<string, string>;
  /** Absent when no colon follows the user name. */
  readonly password: string | undefined;
  readonly srv: boolean;
  /** Absent when the URL has no `@`; a URL with one asks to sign in, even as an empty name. */
  readonly user: string | undefined;
  /** What the specification says to tell the user and parse past: a repeated option. */
  readonly warnings: readonly string[];
}

/** The options the monitor acts on, absent when the URL does not give them. */
export interface MongoOptions {
  readonly authMechanism: string | undefined;
  readonly authSource: string | undefined;
  readonly directConnection: boolean | undefined;
  readonly loadBalanced: boolean | undefined;
  readonly replicaSet: string | undefined;
  readonly srvMaxHosts: number | undefined;
  readonly srvServiceName: string | undefined;
  /** `tls`, or its older name `ssl`; absent leaves the scheme's default, on for `mongodb+srv`. */
  readonly tls: boolean | undefined;
  readonly tlsAllowInvalidCertificates: boolean | undefined;
  readonly tlsAllowInvalidHostnames: boolean | undefined;
  readonly tlsInsecure: boolean | undefined;
}

/** Takes a connection URL apart by the connection string specification; throws on one it calls invalid. */
export function parseConnectionString(text: string): ConnectionString {
  const srv = text.startsWith(srvPrefix);
  if (!(srv || text.startsWith(plainPrefix))) {
    invalid("a MongoDB URL starts with mongodb:// or mongodb+srv://");
  }
  const rest = text.slice(srv ? srvPrefix.length : plainPrefix.length);
  // The host information ends at the first slash, or at the options when no slash comes before them.
  const cut = rest.search(hostInfoEnd);
  const hostInfo = cut < 0 ? rest : rest.slice(0, cut);
  const tail = cut < 0 ? "" : rest.slice(cut);
  const at = hostInfo.lastIndexOf("@");
  const credentials = at < 0 ? undefined : userInfo(hostInfo.slice(0, at));
  const hosts = hostInfo
    .slice(at + 1)
    .split(",")
    .map((each) => hostOf(each, srv));
  if (srv && hosts.length !== 1) {
    invalid("a mongodb+srv URL names one host");
  }
  const query = tail.indexOf("?");
  const path = query < 0 ? tail : tail.slice(0, query);
  const database = decoded(path.slice(1));
  if (prohibitedInDatabase.test(database)) {
    invalid("a database name holds a slash, a space, a quote or a dollar sign");
  }
  const { options, warnings } = optionsIn(
    query < 0 ? "" : tail.slice(query + 1)
  );
  return {
    database: database === "" ? undefined : database,
    hosts,
    options,
    password: credentials?.password,
    srv,
    user: credentials?.user,
    warnings,
  };
}

const plainPrefix = "mongodb://";
const srvPrefix = "mongodb+srv://";
const hostInfoEnd = /[/?]/;
const prohibitedInDatabase = /[/\\ "$]/;
const badPercent = /%(?![0-9a-fA-F]{2})/;
const portText = /^\d+$/;
const upperAscii = /[A-Z]/g;

function invalid(message: string): never {
  throw new TypeError(message);
}

/** Percent-decoding, with `+` kept as a plus. */
function decoded(text: string): string {
  if (badPercent.test(text)) {
    invalid("a percent sign that encodes nothing");
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return invalid("percent-encoding that is not UTF-8");
  }
}

function userInfo(text: string): {
  password: string | undefined;
  user: string;
} {
  // An unescaped @ or a second colon makes the user and password ambiguous; the specification refuses both.
  if (text.includes("@") || text.split(":").length > 2) {
    invalid("the user name and password must be percent-encoded");
  }
  const colon = text.indexOf(":");
  return colon < 0
    ? { password: undefined, user: decoded(text) }
    : {
        password: decoded(text.slice(colon + 1)),
        user: decoded(text.slice(0, colon)),
      };
}

function hostOf(text: string, srv: boolean): MongoHost {
  let host = text;
  let port = "";
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) {
      invalid("an IPv6 host without its closing bracket");
    }
    host = text.slice(1, close);
    const after = text.slice(close + 1);
    if (after !== "") {
      if (!after.startsWith(":")) {
        invalid("text after an IPv6 host that is not a port");
      }
      port = after.slice(1);
    }
  } else {
    const colon = text.indexOf(":");
    if (colon >= 0) {
      host = text.slice(0, colon);
      port = text.slice(colon + 1);
    }
    host = decoded(host);
    // A slash is a UNIX socket's path, which the monitor does not reach.
    if (host.includes("/") || host.includes(":")) {
      invalid("a host the monitor cannot reach over TCP");
    }
  }
  if (host === "") {
    invalid("an empty host");
  }
  if (port === "") {
    return { host, port: mongoPort };
  }
  if (srv) {
    invalid("a mongodb+srv URL names no port");
  }
  const number = portText.test(port) ? Number(port) : 0;
  if (!(number >= 1 && number <= 65_535)) {
    invalid("a port outside 1 to 65535");
  }
  return { host, port: number };
}

/** Options text, `key=value` pairs joined by `&`, each key in lower case and each value decoded; throws on a pair without a key and an equals sign. */
export function optionsIn(query: string): {
  options: Map<string, string>;
  warnings: string[];
} {
  const options = new Map<string, string>();
  const warnings: string[] = [];
  if (query === "") {
    return { options, warnings };
  }
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals < 1) {
      invalid("an option without a key and an equals sign");
    }
    const key = pair
      .slice(0, equals)
      .replace(upperAscii, (letter) => letter.toLowerCase());
    if (options.has(key)) {
      warnings.push(`the option ${key} is repeated; the last value is kept`);
    }
    options.set(key, decoded(pair.slice(equals + 1)));
  }
  return { options, warnings };
}

/**
 * Types the options the monitor acts on and checks the rules between them,
 * for a URL that names `hostCount` servers; throws on a conflict the URI
 * options specification calls an error. An option the monitor does not act
 * on, and a value it cannot read, is a warning and is ignored.
 */
export function optionsOf(
  parsed: Pick<ConnectionString, "options" | "srv">,
  hostCount: number
): { readonly options: MongoOptions; readonly warnings: readonly string[] } {
  const given = parsed.options;
  const warnings: string[] = [];
  for (const key of given.keys()) {
    if (!actedOn.has(key)) {
      warnings.push(`the monitor ignores the option ${key}`);
    }
  }
  const unreadable = (key: string) =>
    warnings.push(`the option ${key} has a value the monitor cannot read`);
  const flag = (key: string): boolean | undefined => {
    const value = given.get(key);
    if (value === "true" || value === "false") {
      return value === "true";
    }
    if (value !== undefined) {
      unreadable(key);
    }
  };
  const count = (key: string): number | undefined => {
    const value = given.get(key);
    if (value !== undefined && portText.test(value)) {
      return Number(value);
    }
    if (value !== undefined) {
      unreadable(key);
    }
  };
  const tls = flag("tls");
  const ssl = flag("ssl");
  if (tls !== undefined && ssl !== undefined && tls !== ssl) {
    invalid("tls and ssl disagree");
  }
  if (
    given.has("tlsinsecure") &&
    (given.has("tlsallowinvalidcertificates") ||
      given.has("tlsallowinvalidhostnames"))
  ) {
    invalid("tlsInsecure stands for the options beside it");
  }
  const authSource = given.get("authsource");
  if (authSource === "") {
    invalid("an empty authSource");
  }
  const options: MongoOptions = {
    authMechanism: given.get("authmechanism"),
    authSource,
    directConnection: flag("directconnection"),
    loadBalanced: flag("loadbalanced"),
    replicaSet: given.get("replicaset"),
    srvMaxHosts: count("srvmaxhosts"),
    srvServiceName: given.get("srvservicename"),
    tls: tls ?? ssl,
    tlsAllowInvalidCertificates: flag("tlsallowinvalidcertificates"),
    tlsAllowInvalidHostnames: flag("tlsallowinvalidhostnames"),
    tlsInsecure: flag("tlsinsecure"),
  };
  checkTopology(options, parsed, hostCount);
  return { options, warnings };
}

/** The options the monitor acts on, by their lower-case key. */
const actedOn = new Set([
  "authmechanism",
  "authsource",
  "directconnection",
  "loadbalanced",
  "replicaset",
  "srvmaxhosts",
  "srvservicename",
  "ssl",
  "tls",
  "tlsallowinvalidcertificates",
  "tlsallowinvalidhostnames",
  "tlsinsecure",
]);

/** The rules between the options that say how the servers are reached. */
function checkTopology(
  options: MongoOptions,
  parsed: Pick<ConnectionString, "options" | "srv">,
  hostCount: number
): void {
  if (options.directConnection && (hostCount > 1 || parsed.srv)) {
    invalid("a direct connection names one host and no SRV name");
  }
  if (
    options.loadBalanced &&
    (hostCount > 1 ||
      options.replicaSet !== undefined ||
      options.directConnection)
  ) {
    invalid(
      "a load balancer is one host, with no replica set or direct connection"
    );
  }
  const srvOnly = ["srvservicename", "srvmaxhosts", "srvallowedhostssuffix"];
  if (!parsed.srv && srvOnly.some((key) => parsed.options.has(key))) {
    invalid("an SRV option on a URL that is not mongodb+srv");
  }
  if (
    (options.srvMaxHosts ?? 0) > 0 &&
    (options.replicaSet !== undefined || options.loadBalanced)
  ) {
    invalid("srvMaxHosts beside a replica set or a load balancer");
  }
}

/** The sign-in mechanisms the monitor speaks. */
export const scramMechanisms = ["SCRAM-SHA-1", "SCRAM-SHA-256"] as const;

/** Whether the monitor can check this URL: it parses, its options agree, it signs in with SCRAM if at all, and it names no file on the install's disk or proxy. */
export function mongoUrlFits(url: string): boolean {
  try {
    const parsed = parseConnectionString(url);
    const { authMechanism } = optionsOf(parsed, parsed.hosts.length).options;
    const signsIn = parsed.user !== undefined || authMechanism !== undefined;
    return (
      (authMechanism === undefined ||
        scramMechanisms.some((each) => each === authMechanism)) &&
      // SCRAM needs a user name and a password.
      (!signsIn || (Boolean(parsed.user) && parsed.password !== undefined)) &&
      !unreachableOptions.some((key) => parsed.options.has(key))
    );
  } catch {
    return false;
  }
}

/** Files on the install's disk and a SOCKS5 proxy: options a monitor saved in the browser has no business naming. */
const unreachableOptions = [
  "proxyhost",
  "tlscafile",
  "tlscertificatekeyfile",
  "tlscertificatekeyfilepassword",
  "tlscrlfile",
];

/** The commands a MongoDB monitor may run: each only reads, and answers in one reply. */
export const readOnlyCommands = [
  "buildInfo",
  "collStats",
  "connectionStatus",
  "count",
  "dbStats",
  "distinct",
  "hello",
  "hostInfo",
  "listDatabases",
  "ping",
  "replSetGetStatus",
  "serverStatus",
] as const;

/** What a MongoDB monitor without a command runs. */
export const defaultMongoCommand = '{"ping": 1}';

/** The command a JSON document names: its first key, when the text is one JSON object and that key is on the read-only list, matched as the server matches a name, case aside. */
export function readOnlyCommandOf(text: string): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return;
  }
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    return;
  }
  const [first] = Object.keys(document);
  return readOnlyCommands.find(
    (command) => command.toLowerCase() === first?.toLowerCase()
  );
}

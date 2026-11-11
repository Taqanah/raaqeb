/**
 * The MongoDB monitor's client: one check opens a connection to each server
 * of the URL's seed list, five at a time (after the SRV and TXT lookups of a `mongodb+srv`
 * URL), keeps the first that answers its hello, signs in with SCRAM when the
 * URL names a user, runs one read-only command and closes every socket. It
 * speaks OP_MSG over `Bun.connect`, plain or TLS, and has no timer of its own:
 * the caller races `ask` against the monitor's timeout and calls `close`,
 * which ends every socket and cancels the lookups, so nothing keeps the
 * process alive.
 */
// biome-ignore lint/style/noRestrictedImports: Bun.dns has no per-query timeout or cancel; node:dns/promises has both
import { Resolver } from "node:dns/promises";
import {
  type ConnectionString,
  type MongoHost,
  type MongoOptions,
  optionsIn,
  optionsOf,
  parseConnectionString,
  readOnlyCommandOf,
} from "@/shared/domain/mongodb.ts";
import {
  type ExtendedDocument,
  type ExtendedJson,
  encodeDocument,
  parseExtendedJson,
  relaxed,
} from "./bson.ts";
import { decodeReply, encodeMessage, messageFramer } from "./mongodb-wire.ts";
import {
  clientNonce,
  type ScramMechanism,
  scramConversation,
} from "./scram.ts";

/** A server's SRV answer. */
export interface SrvRecord {
  readonly name: string;
  readonly port: number;
}

/** The two lookups a `mongodb+srv` URL needs, and a cancel for both. */
export interface SrvResolver {
  readonly cancel: () => void;
  readonly srv: (name: string) => Promise<readonly SrvRecord[]>;
  readonly txt: (name: string) => Promise<readonly (readonly string[])[]>;
}

/** What the client borrows of the platform; tests hand in fakes. */
export interface MongoPlatform {
  readonly connect: typeof Bun.connect;
  /** A fresh SCRAM client nonce; a test hands in a fixed one. */
  readonly nonce: () => string;
  readonly resolver: (timeoutMs: number) => SrvResolver;
}

/** One check's query: the URL, the command as JSON text, and the timeout the lookups are bounded by. */
export interface MongoQuery {
  readonly command: string;
  readonly timeoutMs: number;
  readonly url: string;
}

/** An error of the client's own, with a code the reason map reads; `errno` is the server's code when the server named one. */
export class MongoError extends Error {
  override readonly name = "MongoError";
  readonly code: string;
  readonly errno: string | undefined;
  constructor(
    code: string,
    message: string,
    errno?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.errno = errno;
  }
}

/** The options a TXT record may give (the initial DNS seedlist discovery specification). */
const txtOptions = new Set(["authsource", "loadbalanced", "replicaset"]);

function srvInvalid(message: string): never {
  throw new MongoError("ERR_MONGODB_SRV_INVALID", message);
}

/** A host name as DNS answers it, compared without a trailing dot or case. */
function normalized(host: string): string {
  return host.replace(trailingDot, "").toLowerCase();
}

const trailingDot = /\.$/;

/**
 * The servers a URL names and its options: the hosts as written, or for a
 * `mongodb+srv` URL the SRV answer checked by the initial DNS seedlist
 * discovery specification, its TXT options under the URL's own.
 */
export async function seedList(
  parsed: ConnectionString,
  resolver: Pick<SrvResolver, "srv" | "txt">
): Promise<{
  readonly hosts: readonly MongoHost[];
  readonly options: MongoOptions;
}> {
  const given = optionsOf(parsed, parsed.hosts.length).options;
  if (!parsed.srv) {
    return { hosts: parsed.hosts, options: given };
  }
  const name = normalized(parsed.hosts[0]?.host ?? "");
  const [records, texts] = await Promise.all([
    resolver.srv(`_${given.srvServiceName ?? "mongodb"}._tcp.${name}`),
    // A name with no TXT record gives no options; any other lookup failure fails the check.
    resolver.txt(name).catch((error: unknown) => {
      const code = (error as { code?: unknown } | undefined)?.code;
      return code === "ENODATA" || code === "ENOTFOUND"
        ? []
        : Promise.reject(error);
    }),
  ]);
  if (records.length === 0) {
    srvInvalid(`no SRV record names a server for ${name}`);
  }
  const labels = name.split(".");
  // A name of three labels or more vouches for its parent domain; a shorter one for itself, with a label more.
  const domain = labels.length >= 3 ? labels.slice(1).join(".") : name;
  const hosts = records.map((record) => {
    const host = normalized(record.name);
    if (!host.endsWith(`.${domain}`)) {
      srvInvalid(`the SRV record names ${host}, outside ${domain}`);
    }
    return { host, port: record.port };
  });
  if (texts.length > 1) {
    srvInvalid(`${name} has more than one TXT record`);
  }
  const fromTxt = txtOptionsOf((texts[0] ?? []).join(""));
  const options = new Map([...fromTxt, ...parsed.options]);
  const chosen = sampled(hosts, given.srvMaxHosts ?? 0);
  let typed: MongoOptions;
  try {
    typed = optionsOf({ options, srv: true }, chosen.length).options;
  } catch (error) {
    return srvInvalid(error instanceof Error ? error.message : String(error));
  }
  return { hosts: chosen, options: { ...typed, tls: typed.tls ?? true } };
}

function txtOptionsOf(text: string): Map<string, string> {
  let options: Map<string, string>;
  try {
    ({ options } = optionsIn(text));
  } catch {
    return srvInvalid("a TXT record that is not options");
  }
  for (const [key, value] of options) {
    if (!txtOptions.has(key)) {
      srvInvalid(`a TXT record may not give the option ${key}`);
    }
    if (value === "") {
      srvInvalid(`a TXT record gives ${key} no value`);
    }
  }
  return options;
}

/** At most `max` of the hosts, picked at random as the specification asks; all of them when `max` is zero. */
function sampled(hosts: readonly MongoHost[], max: number): MongoHost[] {
  const shuffled = [...hosts];
  if (max <= 0 || max >= hosts.length) {
    return shuffled;
  }
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [
      shuffled[other] as MongoHost,
      shuffled[index] as MongoHost,
    ];
  }
  return shuffled.slice(0, max);
}

/** One socket that sends a command and waits for its one reply. */
interface Connection {
  readonly close: () => void;
  readonly command: (body: ExtendedDocument) => Promise<ExtendedDocument>;
}

const ipLiteral = /^[\d.]+$|:/;

/** The TLS a URL asks for, or none. */
interface TlsChoice {
  /** Accept a certificate whose chain does not verify, as tlsAllowInvalidCertificates and tlsInsecure ask. */
  readonly anyCertificate: boolean;
  /** Accept a certificate for another name, as tlsAllowInvalidHostnames asks. */
  readonly anyName: boolean;
}

function tlsOf(options: MongoOptions): TlsChoice | undefined {
  if (!options.tls) {
    return;
  }
  const anyCertificate = Boolean(
    options.tlsInsecure || options.tlsAllowInvalidCertificates
  );
  return {
    anyCertificate,
    anyName: anyCertificate || Boolean(options.tlsAllowInvalidHostnames),
  };
}

/**
 * Whether a TLS handshake's outcome is one the URL accepts. Without
 * rejectUnauthorized, Bun 1.4.4 reports success for a chain that does not
 * verify and fails only a name mismatch, so `success` alone decides only a
 * verified connection; allowing invalid host names reads the error itself.
 */
function tlsAccepts(
  tls: TlsChoice | undefined,
  success: boolean,
  authorizationError: Error | null
): boolean {
  if (tls?.anyCertificate) {
    return true;
  }
  if (tls?.anyName) {
    const { code } = (authorizationError ?? {}) as { code?: string };
    return (
      authorizationError === null || code === "ERR_TLS_CERT_ALTNAME_INVALID"
    );
  }
  return success;
}

/** Opens one connection: TCP, then the TLS handshake when asked; resolves once it can carry a command. */
function connectTo(
  host: MongoHost,
  tls: TlsChoice | undefined,
  connect: typeof Bun.connect,
  opened: Set<Connection>
): Promise<Connection> {
  return new Promise<Connection>((resolve, reject) => {
    let socket: Bun.Socket | undefined;
    let ended = false;
    let ready = false;
    let replied = false;
    let requestId = 0;
    let pending:
      | {
          readonly reject: (error: unknown) => void;
          readonly resolve: (reply: ExtendedDocument) => void;
        }
      | undefined;
    let unsent: Uint8Array = new Uint8Array(0);
    const frame = messageFramer();
    const fail = (error: unknown) => {
      const waiting = pending;
      pending = undefined;
      if (waiting) {
        waiting.reject(error);
      } else if (!ready) {
        reject(error);
      }
      socket?.end();
    };
    const flush = () => {
      if (socket && unsent.length > 0) {
        const written = socket.write(unsent);
        unsent = unsent.subarray(Math.max(written, 0));
      }
    };
    const connection: Connection = {
      close: () => {
        ended = true;
        opened.delete(connection);
        fail(closedError("the connection was closed"));
      },
      command: (body) =>
        new Promise<ExtendedDocument>((answer, refuse) => {
          requestId += 1;
          pending = { reject: refuse, resolve: answer };
          unsent = encodeMessage(requestId, encodeDocument(body));
          flush();
        }),
    };
    // Known from the start, so a close ends a socket still connecting or shaking hands.
    opened.add(connection);
    const established = () => {
      ready = true;
      resolve(connection);
    };
    Promise.resolve()
      .then(() =>
        connect({
          hostname: host.host,
          port: host.port,
          socket: {
            close: () => {
              // A plain connection closed before any reply, perhaps after a TLS alert, is what a server that wants TLS does, and a full one too; the caller asks which.
              fail(
                !(tls || replied) && ready
                  ? new MongoError(
                      closedUnheardCode,
                      "the server closed a plain connection before it answered"
                    )
                  : closedError("the server closed the connection")
              );
            },
            connectError: (_socket, error) => fail(error),
            data: (_socket, chunk) => {
              try {
                for (const message of frame(new Uint8Array(chunk))) {
                  const reply = decodeReply(message, requestId);
                  replied = true;
                  const waiting = pending;
                  pending = undefined;
                  waiting?.resolve(reply);
                }
              } catch (error) {
                fail(
                  new MongoError(
                    "ERR_MONGODB_PROTOCOL",
                    error instanceof Error ? error.message : String(error)
                  )
                );
              }
            },
            drain: flush,
            error: (_socket, error) => fail(error),
            handshake: (handshaken, success, authorizationError) => {
              // No certificate means no handshake took place, as on a port that speaks no TLS (Bun 1.4.4 still calls this).
              const presented = Boolean(
                handshaken.getPeerCertificate()?.fingerprint256
              );
              if (presented && tlsAccepts(tls, success, authorizationError)) {
                established();
                return;
              }
              fail(
                authorizationError ?? closedError("the TLS handshake failed")
              );
            },
            open: () => {
              if (!tls) {
                established();
              }
            },
          },
          ...(tls && {
            tls: {
              rejectUnauthorized: !(tls.anyCertificate || tls.anyName),
              ...(!ipLiteral.test(host.host) && { serverName: host.host }),
            },
          }),
        })
      )
      .then((connected) => {
        socket = connected;
        if (ended) {
          connected.end();
        }
        flush();
      })
      .catch(fail);
  });
}

/** A plain connection the server closed before any reply, before the client knows why. */
const closedUnheardCode = "ERR_MONGODB_CLOSED_UNHEARD";

/**
 * Why a server closed a plain connection before it answered: TLS required
 * when the server completes a TLS handshake on a second connection, which a
 * MongoDB that takes TLS alone does; a closed connection otherwise, as a
 * load balancer with no backend or a server at its connection limit gives.
 */
async function whyClosed(
  error: unknown,
  host: MongoHost,
  connect: typeof Bun.connect,
  opened: Set<Connection>
): Promise<unknown> {
  if ((error as { code?: unknown } | undefined)?.code !== closedUnheardCode) {
    return error;
  }
  try {
    const probe = await connectTo(
      host,
      { anyCertificate: true, anyName: true },
      connect,
      opened
    );
    probe.close();
  } catch {
    return closedError(
      "the server closed a plain connection before it answered"
    );
  }
  return new MongoError(
    "ERR_MONGODB_TLS_REQUIRED",
    "the server closed a plain connection before it answered and speaks TLS"
  );
}

function closedError(message: string): Error {
  return Object.assign(new Error(message), { code: "ConnectionClosed" });
}

declare const __RAAQEB_VERSION__: string | undefined;

/** How the client names itself in the handshake, which the server logs. */
const clientMetadata = {
  driver: {
    name: "raaqeb",
    version:
      typeof __RAAQEB_VERSION__ === "string" ? __RAAQEB_VERSION__ : "0.0.0",
  },
  os: { type: process.platform },
};

/** A reply's own fields in relaxed form. */
function fieldsOf(reply: ExtendedDocument): Record<string, unknown> {
  return relaxed(reply) as Record<string, unknown>;
}

/** Fails with the server's own code unless the reply says ok. */
function okOrThrow(
  reply: ExtendedDocument,
  code: string
): Record<string, unknown> {
  const fields = fieldsOf(reply);
  if (fields.ok !== 1) {
    const server = fields.code;
    throw new MongoError(
      code,
      typeof fields.errmsg === "string"
        ? fields.errmsg
        : "the server answered ok: 0",
      server === undefined ? undefined : String(server)
    );
  }
  return fields;
}

const binary = (text: string): ExtendedDocument => ({
  $binary: { base64: new TextEncoder().encode(text).toBase64(), subType: "00" },
});

function payloadText(fields: Record<string, unknown>): string {
  const base64 = (
    fields.payload as { $binary?: { base64?: unknown } } | undefined
  )?.$binary?.base64;
  if (typeof base64 !== "string") {
    throw new MongoError(
      "ERR_MONGODB_SASL_INVALID_MESSAGE",
      "a sign-in reply without its payload"
    );
  }
  return new TextDecoder().decode(Uint8Array.fromBase64(base64));
}

/** Signs in on the connection with SCRAM, verifying the server before it is trusted. */
async function signIn(
  connection: Connection,
  sign: {
    readonly mechanism: ScramMechanism;
    readonly nonce: string;
    readonly password: string;
    readonly source: string;
    readonly user: string;
  }
): Promise<void> {
  const conversation = scramConversation(
    sign.mechanism,
    sign.user,
    sign.password,
    sign.nonce
  );
  const step = async (body: ExtendedDocument) =>
    okOrThrow(
      await connection.command({ ...body, $db: sign.source }),
      "ERR_MONGODB_AUTHENTICATION_FAILED"
    );
  // A command's name is its document's first key.
  const start = await step({
    saslStart: 1,
    mechanism: sign.mechanism,
    options: { skipEmptyExchange: true },
    payload: binary(conversation.first),
  });
  // A server that says done before it proved it knows the password is not one to trust.
  if (start.done === true) {
    throw new MongoError(
      "ERR_MONGODB_SASL_INVALID_MESSAGE",
      "the server ended the sign-in before its proof"
    );
  }
  const conversationId = start.conversationId as ExtendedJson;
  const proof = await conversation.final(payloadText(start));
  const next = await step({
    saslContinue: 1,
    conversationId,
    payload: binary(proof),
  });
  conversation.verify(payloadText(next));
  // An older server ignores skipEmptyExchange and asks for one empty step more.
  if (next.done !== true) {
    const last = await step({
      saslContinue: 1,
      conversationId,
      payload: binary(""),
    });
    if (last.done !== true) {
      throw new MongoError(
        "ERR_MONGODB_SASL_INVALID_MESSAGE",
        "the server did not end the sign-in"
      );
    }
  }
}

/** A connection that answers one command and closes. `ask` answers the first value of the reply in relaxed Extended JSON, or rejects with the error that ended it. */
export function openMongo(
  query: MongoQuery,
  platform: MongoPlatform
): { readonly ask: () => Promise<unknown>; readonly close: () => void } {
  const opened = new Set<Connection>();
  let closed = false;
  let resolver: SrvResolver | undefined;
  const close = () => {
    closed = true;
    resolver?.cancel();
    for (const connection of opened) {
      connection.close();
    }
  };
  const ask = async () => {
    if (readOnlyCommandOf(query.command) === undefined) {
      throw new MongoError(
        "ERR_MONGODB_COMMAND_NOT_ALLOWED",
        "the command is not one that only reads"
      );
    }
    const command = commandOf(query.command);
    const parsed = parseConnectionString(query.url);
    resolver = parsed.srv ? platform.resolver(query.timeoutMs) : undefined;
    const { hosts, options } = await seedList(parsed, resolver ?? noLookups);
    const source = options.authSource ?? parsed.database ?? "admin";
    const { user } = parsed;
    const tls = tlsOf(options);
    const hello = helloOf(
      options,
      user === undefined ? undefined : `${source}.${user}`
    );
    // Five servers say hello at once, the next five if those fail; the first to answer is the one asked, and every other is closed.
    const winner = await firstToAnswer(
      hosts,
      async (host) => {
        const connection = await connectTo(host, tls, platform.connect, opened);
        if (closed) {
          connection.close();
        }
        const reply = await connection
          .command(hello)
          .catch(async (error: unknown) => {
            throw await whyClosed(error, host, platform.connect, opened);
          });
        return {
          connection,
          fields: okOrThrow(reply, "ERR_MONGODB_SERVER_ERROR"),
        };
      },
      opened
    );
    const { connection, fields } = winner;
    if (user !== undefined) {
      const mechanisms = Array.isArray(fields.saslSupportedMechs)
        ? fields.saslSupportedMechs
        : [];
      await signIn(connection, {
        mechanism: (options.authMechanism ??
          (mechanisms.includes("SCRAM-SHA-256")
            ? "SCRAM-SHA-256"
            : "SCRAM-SHA-1")) as ScramMechanism,
        nonce: platform.nonce(),
        password: parsed.password ?? "",
        source,
        user,
      });
    }
    const reply = okOrThrow(
      await connection.command({
        ...command,
        $db: parsed.database ?? "admin",
        // A replica set member that is not primary answers a read only when the read allows it.
        ...(typeof fields.setName === "string" && {
          $readPreference: { mode: "primaryPreferred" },
        }),
      }),
      "ERR_MONGODB_SERVER_ERROR"
    );
    return Object.values(reply)[0];
  };
  return { ask, close };
}

/** The handshake's hello: legacy hello first, as the handshake specification asks, unless a load balancer needs hello itself; with the user's mechanisms asked for when the URL names none. */
function helloOf(
  options: MongoOptions,
  namespacedUser: string | undefined
): ExtendedDocument {
  return {
    ...(options.loadBalanced
      ? { hello: 1, loadBalanced: true }
      : { isMaster: 1, helloOk: true }),
    client: clientMetadata,
    ...(namespacedUser !== undefined &&
      options.authMechanism === undefined && {
        saslSupportedMechs: namespacedUser,
      }),
    $db: "admin",
  };
}

/** Seeds asked at once; a longer list waits until these fail, so an SRV answer of many hosts never opens a socket to each. */
export const seedsAtOnce = 5;

/** The first server to answer, asked five at a time and every other connection closed; when none does, the first server's error. */
async function firstToAnswer<T extends { readonly connection: Connection }>(
  hosts: readonly MongoHost[],
  attempt: (host: MongoHost) => Promise<T>,
  opened: Set<Connection>
): Promise<T> {
  const errors: unknown[] = [];
  for (let start = 0; start < hosts.length; start += seedsAtOnce) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the next five are asked only once these have failed
      const winner = await Promise.any(
        hosts.slice(start, start + seedsAtOnce).map(attempt)
      );
      for (const connection of opened) {
        if (connection !== winner.connection) {
          connection.close();
        }
      }
      return winner;
    } catch (error) {
      errors.push(
        ...(error instanceof AggregateError ? error.errors : [error])
      );
    }
  }
  throw errors[0];
}

/** The operator's command as a document BSON can hold; a wrapper that does not encode, such as an ObjectId of the wrong length, refuses it before any connection. */
function commandOf(text: string): ExtendedDocument {
  const command = parseExtendedJson(text) as ExtendedDocument;
  try {
    encodeDocument(command);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: the cause goes through MongoError's options, which the rule does not read
    throw new MongoError(
      "ERR_MONGODB_INVALID_COMMAND",
      error instanceof Error ? error.message : String(error),
      undefined,
      { cause: error }
    );
  }
  return command;
}

const noLookups: Pick<SrvResolver, "srv" | "txt"> = {
  srv: () => Promise.resolve([]),
  txt: () => Promise.resolve([]),
};

/** Bun's resolver ends a try after at most five seconds, whatever `timeout` asks. */
const resolverTryCapMs = 5000;

/** The platform's own socket, resolver and randomness. */
export const liveMongoPlatform: MongoPlatform = {
  connect: Bun.connect,
  nonce: clientNonce,
  resolver: (timeoutMs) => {
    // Enough capped tries to outlast the timeout, which the check's own timer enforces.
    const resolver = new Resolver({
      timeout: Math.min(timeoutMs, resolverTryCapMs),
      tries: Math.ceil(timeoutMs / resolverTryCapMs),
    });
    return {
      cancel: () => resolver.cancel(),
      srv: (name) => resolver.resolveSrv(name),
      txt: (name) => resolver.resolveTxt(name),
    };
  },
};

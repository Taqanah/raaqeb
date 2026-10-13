/**
 * The live I/O the checks borrow: Bun's `fetch`, a TCP
 * connection and a TLS handshake over `Bun.connect`, DNS record queries over
 * a `node:dns` resolver, one query to a database (database-io.ts), one
 * request to a Docker daemon (docker-io.ts), the clock and a sleep. The scheduler builds one bundle and hands it to every
 * check; the check files themselves never touch a socket. Each adapter
 * takes its platform function as a parameter so a test can hand in a fake.
 */
// biome-ignore lint/style/noRestrictedImports: Bun.dns resolves addresses only, with no MX, TXT, NS or CNAME query, no per-resolver server and no timeout; node:dns/promises has all three
import { Resolver } from "node:dns/promises";
import type { DnsRecordType } from "@/shared/schemas/monitor.ts";
import type { PeerCertificate, ReadTls, TlsTarget } from "./certificate.ts";
import type { QueryDatabase } from "./database.ts";
import { liveDrivers, queryOnce } from "./database-io.ts";
import {
  type DnsQuery,
  type DnsRecords,
  type Resolve,
  textOfRecords,
} from "./dns.ts";
import type { RequestDocker } from "./docker.ts";
import { requestDocker } from "./docker-io.ts";
import type { CheckIo } from "./http.ts";
import type { Connect, ConnectTarget } from "./tcp.ts";

/** Everything a check type may borrow. */
export interface LiveIo extends CheckIo {
  readonly connect: Connect;
  readonly queryDatabase: QueryDatabase;
  readonly readTls: ReadTls;
  readonly requestDocker: RequestDocker;
  readonly resolve: Resolve;
}

/** What `Bun.connect` is to the adapters: the options they pass and the socket they get back. */
export type SocketOpener = typeof Bun.connect;

/** A resolver instance as `node:dns/promises` shapes it: its servers, one query, and a cancel. */
export interface RecordResolver {
  cancel: () => void;
  resolve: (name: string, recordType: DnsRecordType) => Promise<DnsRecords>;
  setServers: (servers: readonly string[]) => void;
}

/** Makes a resolver whose queries give up after `timeoutMs`; the default is the system's servers from `/etc/resolv.conf`. */
export type ResolverFactory = (timeoutMs: number) => RecordResolver;

type Handlers = Parameters<SocketOpener>[0]["socket"];

function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

/** The error of a socket the peer closed before the outcome arrived; its code is one the HTTP map already knows. */
function closedError(): Error {
  return Object.assign(new Error("connection closed before the handshake"), {
    code: "ConnectionClosed",
  });
}

/** The one thing the adapters need of a socket after the outcome: closing it. */
interface Closable {
  end: () => void;
}

/**
 * One promise settled by whichever comes first: the socket's own outcome or
 * the timer. `Bun.connect` has no timeout of its own, so
 * the timer stands in; a socket still open when the timer fires, or that
 * opens after it, is closed at once.
 */
function withinTimeout<T>(
  timeoutMs: number,
  start: (settle: {
    /** Answers whether this call settled the outcome, so the caller knows it owns closing the socket. */
    reject: (error: unknown) => boolean;
    resolve: (value: T) => boolean;
  }) => Promise<Closable>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let socket: Closable | undefined;
    const timer = setTimeout(() => {
      finish(reject, timeoutError());
      socket?.end();
    }, timeoutMs);
    function finish<V>(fn: (value: V) => void, value: V): boolean {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      fn(value);
      return true;
    }
    // Through a chain so an opener that throws instead of rejecting lands in the same catch and clears the timer.
    Promise.resolve()
      .then(() =>
        start({
          reject: (error) => finish(reject, error),
          resolve: (value) => finish(resolve, value),
        })
      )
      .then((opened) => {
        socket = opened;
        if (settled) {
          opened.end();
        }
      })
      .catch((error: unknown) => finish(reject, error));
  });
}

/** Opens a TCP connection to the target, answers the address it reached and closes it; a connection not open by the timeout rejects with a `TimeoutError`. */
export function openConnection(
  target: ConnectTarget,
  connect: SocketOpener
): Promise<string> {
  return withinTimeout<string>(target.timeoutMs, ({ reject, resolve }) => {
    const socket: Handlers = {
      close: () => {
        reject(closedError());
      },
      connectError: (_socket, error) => {
        reject(error);
      },
      data: () => undefined,
      error: (_socket, error) => {
        reject(error);
      },
      open: (opened) => {
        if (resolve(opened.remoteAddress)) {
          opened.end();
        }
      },
    };
    return connect({ hostname: target.host, port: target.port, socket });
  });
}

/** Completes a TLS handshake without verifying the peer and answers its leaf certificate; rejects on a connection error or the timeout. */
export function readPeerCertificate(
  target: TlsTarget,
  connect: SocketOpener
): Promise<PeerCertificate> {
  return withinTimeout(target.timeoutMs, ({ reject, resolve }) => {
    const socket: Handlers = {
      close: () => {
        reject(closedError());
      },
      connectError: (_socket, error) => {
        reject(error);
      },
      data: () => undefined,
      error: (_socket, error) => {
        reject(error);
      },
      // A leaf that arrived is the answer whatever the verification said (a name mismatch fails it with a readable leaf); no leaf means the handshake did not happen, as on a port that speaks no TLS (probed on Bun 1.4.3).
      handshake: (opened, _success, authorizationError) => {
        const peer: PeerCertificate | undefined = opened.getPeerCertificate();
        const settled = peer?.fingerprint256
          ? resolve(peer)
          : reject(authorizationError ?? closedError());
        if (settled) {
          opened.end();
        }
      },
    };
    return connect({
      hostname: target.host,
      port: target.port,
      socket,
      tls: {
        rejectUnauthorized: false,
        ...(target.serverName ? { serverName: target.serverName } : {}),
      },
    });
  });
}

/** Runs one query on a fresh resolver, pointed at the custom server when the query names one, and answers each record as text. */
export async function resolveRecords(
  query: DnsQuery,
  makeResolver: ResolverFactory
): Promise<readonly string[]> {
  const resolver = makeResolver(query.timeoutMs);
  if (query.resolver !== undefined) {
    resolver.setServers([query.resolver]);
  }
  // c-ares spends the timeout once per server in resolv.conf and never under about a second; the query's own timer bounds the whole attempt.
  const records = await withinTimeout<DnsRecords>(query.timeoutMs, (settle) => {
    resolver
      .resolve(query.name, query.recordType)
      .then(settle.resolve, settle.reject);
    return Promise.resolve({ end: () => resolver.cancel() });
  });
  return textOfRecords(query.recordType, records);
}

/** A `node:dns` resolver with one try that gives up after the timeout; each record type through its own typed query. */
function nodeResolver(timeoutMs: number): RecordResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const queries: Record<DnsRecordType, (name: string) => Promise<DnsRecords>> =
    {
      A: (name) => resolver.resolve4(name),
      AAAA: (name) => resolver.resolve6(name),
      CNAME: (name) => resolver.resolveCname(name),
      MX: (name) => resolver.resolveMx(name),
      NS: (name) => resolver.resolveNs(name),
      TXT: (name) => resolver.resolveTxt(name),
    };
  return {
    cancel: () => resolver.cancel(),
    resolve: (name, recordType) => queries[recordType](name),
    setServers: (servers) => resolver.setServers([...servers]),
  };
}

/** The bundle over the real platform. */
export function liveIo(): LiveIo {
  return {
    connect: (target) => openConnection(target, Bun.connect),
    fetch,
    now: Date.now,
    queryDatabase: (query) => queryOnce(query, liveDrivers),
    readTls: (target) => readPeerCertificate(target, Bun.connect),
    requestDocker,
    resolve: (query) => resolveRecords(query, nodeResolver),
    sleep: Bun.sleep,
  };
}

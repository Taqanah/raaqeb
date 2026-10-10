import { describe, expect, test } from "bun:test";
import { monitorConfigSchema } from "@/shared/schemas/monitor.ts";
import type { PeerCertificate } from "./certificate.ts";
import type { DnsQuery } from "./dns.ts";
import { requestDocker } from "./docker-io.ts";
import {
  liveIo,
  openConnection,
  type RecordResolver,
  readPeerCertificate,
  resolveRecords,
  type SocketOpener,
} from "./io.ts";
import { runCheck } from "./run.ts";

const fixtures = `${import.meta.dir}/fixtures`;
/** The fixture certificate's SHA-256 fingerprint, from `openssl x509 -fingerprint -sha256`. */
const fixtureFingerprint =
  "BE:3A:C0:A5:14:41:16:4A:A3:08:77:42:E2:7B:8C:4A:04:DD:02:E1:DB:DB:C1:85:08:C3:F9:88:CB:72:8B:E6";

type Handlers = Parameters<SocketOpener>[0]["socket"];
type Options = Parameters<SocketOpener>[0];

/**
 * A fake `Bun.connect` scripted by what happens after the call: the socket
 * opens, the handshake completes with a peer, the connection fails, or
 * nothing happens at all. Records the options it was given and whether the
 * socket was ended.
 */
function opener(
  script:
    | { opens: true; peer?: PeerCertificate; afterMs?: number }
    | { opens: true; handshakeFails: Error; peer?: PeerCertificate }
    | { closes: true }
    | { fails: Error }
    | { hangs: true }
) {
  const seen: Options[] = [];
  const ended: boolean[] = [];
  const connect = ((options: Options) => {
    seen.push(options);
    const handlers = options.socket as Handlers;
    const socket = {
      authorized: false,
      end: () => {
        ended.push(true);
      },
      getPeerCertificate: () => ("peer" in script ? script.peer : undefined),
      remoteAddress: "192.0.2.80",
      terminate: () => {
        ended.push(true);
      },
    } as unknown as Bun.Socket<undefined>;
    if ("fails" in script) {
      handlers.connectError?.(socket, script.fails);
      return Promise.reject(script.fails);
    }
    if ("closes" in script) {
      setTimeout(() => {
        handlers.open?.(socket);
        handlers.close?.(socket);
      }, 0);
      return Promise.resolve(socket);
    }
    if ("handshakeFails" in script) {
      setTimeout(() => {
        handlers.open?.(socket);
        handlers.handshake?.(socket, false, script.handshakeFails);
      }, 0);
      return Promise.resolve(socket);
    }
    if ("hangs" in script) {
      // A connection that never opens: the promise stays pending.
      return new Promise<Bun.Socket<undefined>>(() => undefined);
    }
    setTimeout(() => {
      handlers.open?.(socket);
      if (script.peer) {
        // With verification off the platform reports success and still names the authorization error (probed on Bun 1.4.2).
        handlers.handshake?.(socket, true, new Error("self signed"));
      }
    }, script.afterMs ?? 0);
    return Promise.resolve(socket);
  }) as unknown as SocketOpener;
  return { connect, ended, seen };
}

function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** The first question of a DNS query packet: its name and the bytes of the question section. */
function readQuestion(packet: Uint8Array): {
  name: string;
  question: Uint8Array;
} {
  const labels: string[] = [];
  let at = 12;
  for (let length = packet[at]; length; length = packet[at]) {
    labels.push(
      new TextDecoder().decode(packet.slice(at + 1, at + 1 + length))
    );
    at += 1 + length;
  }
  return { name: labels.join("."), question: packet.slice(12, at + 5) };
}

/** A DNS reply to the query that answers its question with one TXT record. */
function txtAnswer(
  query: Uint8Array,
  question: Uint8Array,
  text: string
): Uint8Array {
  const data = new TextEncoder().encode(text);
  const header = Uint8Array.from([
    query[0] ?? 0,
    query[1] ?? 0,
    0x81,
    0x80,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    0,
  ]);
  const record = Uint8Array.from([
    0xc0,
    0x0c,
    0,
    16,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    data.length + 1,
    data.length,
  ]);
  return Uint8Array.from([...header, ...question, ...record, ...data]);
}

describe("opening a TCP connection", () => {
  test("resolves with the address the open socket reached, closes it, and asks for the host and port with no TLS", async () => {
    const { connect, ended, seen } = opener({ opens: true });
    expect(
      await openConnection(
        { host: "example.test", port: 5432, timeoutMs: 1000 },
        connect
      )
    ).toBe("192.0.2.80");
    expect(seen[0]).toMatchObject({ hostname: "example.test", port: 5432 });
    expect(seen[0]?.tls).toBeUndefined();
    expect(ended).toEqual([true]);
  });

  test("rejects with the platform's error when the connection fails", async () => {
    const { connect } = opener({
      fails: coded("ECONNREFUSED", "Failed to connect"),
    });
    await expect(
      openConnection(
        { host: "example.test", port: 5432, timeoutMs: 1000 },
        connect
      )
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  test("an opener that throws instead of rejecting still rejects the call with its error", async () => {
    const throwing = (() => {
      throw coded("EINVAL", "bad hostname");
    }) as unknown as SocketOpener;
    await expect(
      openConnection(
        { host: "example.test", port: 5432, timeoutMs: 1000 },
        throwing
      )
    ).rejects.toMatchObject({ code: "EINVAL" });
  });

  test("a socket not open by the timeout rejects with a TimeoutError", async () => {
    const { connect } = opener({ hangs: true });
    await expect(
      openConnection(
        { host: "example.test", port: 5432, timeoutMs: 20 },
        connect
      )
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("a socket that opens after the timeout is closed and changes nothing", async () => {
    const { connect, ended } = opener({ opens: true, afterMs: 60 });
    await expect(
      openConnection(
        { host: "example.test", port: 5432, timeoutMs: 20 },
        connect
      )
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await Bun.sleep(80);
    expect(ended).toEqual([true]);
  });
});

describe("reading a peer certificate", () => {
  const peer = {
    fingerprint256: "AA:BB",
    issuer: { CN: "x" },
    subject: { CN: "x" },
    valid_from: "Jul 29 22:10:08 2026 GMT",
    valid_to: "Oct 27 22:17:21 2026 GMT",
  };

  test("connects with TLS, the server name and verification off, and answers the leaf after the handshake even when unauthorized", async () => {
    const { connect, ended, seen } = opener({ opens: true, peer });
    const read = await readPeerCertificate(
      {
        host: "example.test",
        port: 443,
        serverName: "example.test",
        timeoutMs: 1000,
      },
      connect
    );
    expect(read).toEqual(peer);
    expect(seen[0]).toMatchObject({
      hostname: "example.test",
      port: 443,
      tls: { rejectUnauthorized: false, serverName: "example.test" },
    });
    expect(ended).toEqual([true]);
  });

  test("an IP literal target sends no server name", async () => {
    const { connect, seen } = opener({ opens: true, peer });
    await readPeerCertificate(
      { host: "192.0.2.1", port: 443, serverName: undefined, timeoutMs: 1000 },
      connect
    );
    expect(seen[0]?.tls).toEqual({ rejectUnauthorized: false });
  });

  test("a handshake that fails rejects with its error rather than answering an empty record", async () => {
    const { connect, ended } = opener({
      handshakeFails: new Error("WRONG_VERSION_NUMBER"),
      opens: true,
    });
    await expect(
      readPeerCertificate(
        {
          host: "example.test",
          port: 80,
          serverName: "example.test",
          timeoutMs: 1000,
        },
        connect
      )
    ).rejects.toMatchObject({ message: "WRONG_VERSION_NUMBER" });
    expect(ended).toEqual([true]);
  });

  test("a handshake the platform did not authorize still answers the leaf when one arrived", async () => {
    const { connect } = opener({
      handshakeFails: coded("ERR_TLS_CERT_ALTNAME_INVALID"),
      opens: true,
      peer,
    });
    const read = await readPeerCertificate(
      { host: "192.0.2.1", port: 443, serverName: undefined, timeoutMs: 1000 },
      connect
    );
    expect(read).toEqual(peer);
  });

  test("a handshake that stalls past the timeout closes the socket it opened", async () => {
    const { connect, ended } = opener({ opens: true });
    await expect(
      readPeerCertificate(
        {
          host: "example.test",
          port: 443,
          serverName: "example.test",
          timeoutMs: 20,
        },
        connect
      )
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(ended).toEqual([true]);
  });

  test("a socket closed before the handshake rejects at once, not at the timeout", async () => {
    const { connect } = opener({ closes: true });
    const started = performance.now();
    await expect(
      readPeerCertificate(
        {
          host: "example.test",
          port: 80,
          serverName: "example.test",
          timeoutMs: 5000,
        },
        connect
      )
    ).rejects.toMatchObject({ code: "ConnectionClosed" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("rejects on a connection failure and on the timeout", async () => {
    const { connect } = opener({ fails: coded("ENOTFOUND") });
    await expect(
      readPeerCertificate(
        {
          host: "nowhere.example.test",
          port: 443,
          serverName: "nowhere.example.test",
          timeoutMs: 1000,
        },
        connect
      )
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
    const { connect: hanging } = opener({ hangs: true });
    await expect(
      readPeerCertificate(
        {
          host: "example.test",
          port: 443,
          serverName: "example.test",
          timeoutMs: 20,
        },
        hanging
      )
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("resolving records", () => {
  const query: DnsQuery = {
    name: "example.test",
    recordType: "MX",
    resolver: undefined,
    timeoutMs: 3000,
  };

  function factory(answer: () => Promise<unknown>) {
    const made: number[] = [];
    const servers: (readonly string[])[] = [];
    const queries: [string, string][] = [];
    const makeResolver = (timeoutMs: number): RecordResolver => {
      made.push(timeoutMs);
      return {
        cancel: () => undefined,
        resolve: (name, recordType) => {
          queries.push([name, recordType]);
          return answer() as ReturnType<RecordResolver["resolve"]>;
        },
        setServers: (list) => {
          servers.push(list);
        },
      };
    };
    return { made, makeResolver, queries, servers };
  }

  test("makes a resolver with the query's timeout, asks it for the name and type, and answers the records as text", async () => {
    const { made, makeResolver, queries, servers } = factory(() =>
      Promise.resolve([{ exchange: "mail.example.test", priority: 10 }])
    );
    expect(await resolveRecords(query, makeResolver)).toEqual([
      "mail.example.test",
    ]);
    expect(made).toEqual([3000]);
    expect(queries).toEqual([["example.test", "MX"]]);
    expect(servers).toEqual([]);
  });

  test("a custom resolver is set on the instance before the query", async () => {
    const { makeResolver, servers } = factory(() =>
      Promise.resolve(["192.0.2.1"])
    );
    await resolveRecords(
      { ...query, recordType: "A", resolver: "192.0.2.53" },
      makeResolver
    );
    expect(servers).toEqual([["192.0.2.53"]]);
  });

  test("a resolver that never answers is cancelled and rejected at the query's timeout, whatever c-ares counts per server", async () => {
    const cancelled: boolean[] = [];
    const makeResolver = (): RecordResolver => ({
      cancel: () => {
        cancelled.push(true);
      },
      resolve: () => new Promise(() => undefined),
      setServers: () => undefined,
    });
    const started = performance.now();
    await expect(
      resolveRecords({ ...query, timeoutMs: 30 }, makeResolver)
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(cancelled).toEqual([true]);
  });

  test("the resolver's error is passed through", async () => {
    const { makeResolver } = factory(() => Promise.reject(coded("ENOTFOUND")));
    await expect(resolveRecords(query, makeResolver)).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
  });
});

describe("the live bundle", () => {
  test("carries the platform's own fetch, clock, pause and Docker request", () => {
    const io = liveIo();
    expect(io.fetch).toBe(fetch);
    expect(io.now).toBe(Date.now);
    expect(io.sleep).toBe(Bun.sleep);
    expect(io.requestDocker).toBe(requestDocker);
  });

  test("connects to a listening local port and reports a closed one as refused", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: () => undefined,
        open(socket) {
          socket.end();
        },
      },
    });
    try {
      expect(
        await liveIo().connect({
          host: "127.0.0.1",
          port: server.port,
          timeoutMs: 2000,
        })
      ).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
    await expect(
      liveIo().connect({
        host: "127.0.0.1",
        port: server.port,
        timeoutMs: 2000,
      })
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  test("a DNS monitor on an underscore name asks the resolver for that name and is up when the record is the expected one", async () => {
    const asked: string[] = [];
    const server = await Bun.udpSocket({
      hostname: "127.0.0.1",
      socket: {
        data(socket, request, port, address) {
          const { name, question } = readQuestion(request);
          asked.push(name);
          socket.send(
            txtAnswer(request, question, "v=DMARC1; p=none"),
            port,
            address
          );
        },
      },
    });
    try {
      const config = monitorConfigSchema.parse({
        expected: "v=DMARC1; p=none",
        name: "_dmarc.example.test",
        recordType: "TXT",
        resolver: `127.0.0.1:${server.port}`,
        type: "dns",
      });
      const outcome = await runCheck(
        {
          config,
          degradedMs: undefined,
          id: "m1",
          retries: 0,
          timeoutMs: 2000,
        },
        liveIo()
      );
      expect(outcome?.check.result).toBe("up");
      expect(asked).toEqual(["_dmarc.example.test"]);
    } finally {
      server.close();
    }
  });

  test("a TCP monitor whose host is the IPv6 loopback is up while it listens", async () => {
    const server = Bun.listen({
      hostname: "::1",
      port: 0,
      socket: {
        data: () => undefined,
        open(socket) {
          socket.end();
        },
      },
    });
    try {
      const config = monitorConfigSchema.parse({
        host: "::1",
        port: server.port,
        type: "tcp",
      });
      const outcome = await runCheck(
        {
          config,
          degradedMs: undefined,
          id: "m1",
          retries: 0,
          timeoutMs: 2000,
        },
        liveIo()
      );
      expect(outcome?.check.result).toBe("up");
    } finally {
      server.stop(true);
    }
  });

  test("reads the leaf certificate of a local TLS listener, self-signed and all", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
      tls: {
        cert: Bun.file(`${fixtures}/tls-cert.pem`),
        key: Bun.file(`${fixtures}/tls-key.pem`),
      },
    });
    try {
      const peer = await liveIo().readTls({
        host: "127.0.0.1",
        port: server.port,
        serverName: undefined,
        timeoutMs: 2000,
      });
      expect(peer.fingerprint256).toBe(fixtureFingerprint);
      expect(peer.subject).toMatchObject({ CN: "localhost" });
      expect(peer.subjectaltname).toBe("DNS:localhost, IP Address:127.0.0.1");
    } finally {
      server.stop(true);
    }
  });
});

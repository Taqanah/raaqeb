import { afterEach, describe, expect, test } from "bun:test";
import { parseConnectionString } from "@/shared/domain/mongodb.ts";
import {
  decodeDocument,
  type ExtendedDocument,
  encodeDocument,
  relaxed,
} from "./bson.ts";
import {
  MongoError,
  type MongoPlatform,
  openMongo,
  type SrvResolver,
  seedList,
} from "./mongodb.ts";
import { messageFramer, opMsg } from "./mongodb-wire.ts";

/** What a fake server does with one command: answer it, close the connection, or never answer. */
type Answer = ExtendedDocument | "close" | "hang";

interface FakeServer {
  /** How many connections it has accepted. */
  readonly accepted: () => number;
  /** Whether every connection it accepted has been closed by the client. */
  readonly closed: () => boolean;
  /** The commands it received, in relaxed form, `$db` included. */
  readonly commands: Record<string, unknown>[];
  readonly port: number;
  stop: () => void;
}

const servers: FakeServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

/** A server that speaks OP_MSG and answers each command with `answer`. */
function fakeServer(
  answer: (command: Record<string, unknown>) => Answer
): FakeServer {
  const commands: Record<string, unknown>[] = [];
  let open = 0;
  let accepted = 0;
  const listener = Bun.listen<{ frame: (chunk: Uint8Array) => Uint8Array[] }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      close: () => {
        open -= 1;
      },
      data: (socket, chunk) => {
        let messages: Uint8Array[];
        try {
          messages = socket.data.frame(new Uint8Array(chunk));
        } catch {
          // Bytes that are no OP_MSG, such as a TLS handshake, end the connection, as a real server does.
          socket.end();
          return;
        }
        for (const message of messages) {
          const view = new DataView(message.buffer, message.byteOffset);
          const requestId = view.getInt32(4, true);
          const command = relaxed(
            decodeDocument(message.subarray(21))
          ) as Record<string, unknown>;
          commands.push(command);
          const answered = answer(command);
          if (answered === "close") {
            socket.end();
            return;
          }
          if (answered !== "hang") {
            socket.write(replyTo(requestId, answered));
          }
        }
      },
      open: (socket) => {
        open += 1;
        accepted += 1;
        socket.data = { frame: messageFramer() };
      },
    },
  });
  const server = {
    accepted: () => accepted,
    closed: () => open === 0,
    commands,
    port: listener.port,
    stop: () => listener.stop(true),
  };
  servers.push(server);
  return server;
}

function replyTo(requestId: number, body: ExtendedDocument): Uint8Array {
  const document = encodeDocument(body);
  const message = new Uint8Array(21 + document.length);
  const view = new DataView(message.buffer);
  view.setInt32(0, message.length, true);
  view.setInt32(4, 1, true);
  view.setInt32(8, requestId, true);
  view.setInt32(12, opMsg, true);
  message.set(document, 21);
  return message;
}

/** Whether the command is the handshake: legacy hello, or hello itself behind a load balancer. */
function isHello(command: Record<string, unknown>): boolean {
  return "isMaster" in command || "hello" in command;
}

/** A standalone server's hello, then `rest` for every other command. */
function standalone(
  rest: (command: Record<string, unknown>) => Answer = () => ({ ok: 1 })
) {
  return (command: Record<string, unknown>): Answer =>
    isHello(command)
      ? { isWritablePrimary: true, maxWireVersion: 25, ok: 1 }
      : rest(command);
}

const noSrv: SrvResolver = {
  cancel: () => undefined,
  srv: () => Promise.reject(new Error("no SRV lookup expected")),
  txt: () => Promise.reject(new Error("no TXT lookup expected")),
};

const platform: MongoPlatform = {
  connect: Bun.connect,
  nonce: () => "rOprNGfwEbeRWgbNEkqO",
  resolver: () => noSrv,
};

function ask(
  url: string,
  command = '{"ping": 1}',
  on: MongoPlatform = platform
) {
  const connection = openMongo({ command, timeoutMs: 2000, url }, on);
  return connection.ask().finally(() => connection.close());
}

async function failure(
  run: Promise<unknown>
): Promise<{ code?: string; errno?: string }> {
  try {
    await run;
  } catch (error) {
    return error as { code?: string; errno?: string };
  }
  throw new Error("expected a failure");
}

/** RFC 7677's conversation for user "user", password "pencil", as a server holds it. */
const scram = {
  clientFinal:
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  clientFirst: "n,,n=user,r=rOprNGfwEbeRWgbNEkqO",
  serverFinal: "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
  serverFirst:
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
};

const binary = (text: string): ExtendedDocument => ({
  $binary: { base64: new TextEncoder().encode(text).toBase64(), subType: "00" },
});
const textOf = (payload: unknown) =>
  new TextDecoder().decode(
    Uint8Array.fromBase64(
      (payload as { $binary: { base64: string } }).$binary.base64
    )
  );

/** A server that signs `user` in by RFC 7677's conversation, its replies overridable. */
function signingIn(
  overrides: {
    readonly continue?: ExtendedDocument;
    readonly start?: ExtendedDocument;
  } = {}
) {
  return standalone((command) => {
    if ("saslStart" in command) {
      return (
        overrides.start ?? {
          conversationId: 1,
          done: false,
          ok: 1,
          payload: binary(scram.serverFirst),
        }
      );
    }
    if ("saslContinue" in command) {
      return (
        overrides.continue ?? {
          conversationId: 1,
          done: true,
          ok: 1,
          payload: binary(scram.serverFinal),
        }
      );
    }
    return { ok: 1 };
  });
}

describe("one command to a MongoDB server", () => {
  test("says hello, runs the command on the admin database and answers the first value of the reply in relaxed form", async () => {
    const server = fakeServer(standalone(() => ({ version: "8.0.34", ok: 1 })));
    const answer = await ask(
      `mongodb://127.0.0.1:${server.port}`,
      '{"buildInfo": 1}'
    );
    expect(answer).toBe("8.0.34");
    // Legacy hello first, as the handshake specification asks.
    expect(server.commands[0]).toMatchObject({
      $db: "admin",
      client: { driver: { name: "raaqeb" } },
      helloOk: true,
      isMaster: 1,
    });
    expect(server.commands[1]).toEqual({ $db: "admin", buildInfo: 1 });
  });

  test("answers ping's ok as the number 1", async () => {
    const server = fakeServer(standalone());
    expect(await ask(`mongodb://127.0.0.1:${server.port}`)).toBe(1);
  });

  test("runs the command on the URL's database", async () => {
    const server = fakeServer(standalone());
    await ask(`mongodb://127.0.0.1:${server.port}/app`);
    expect(server.commands[1]).toEqual({ $db: "app", ping: 1 });
  });

  test("lets a replica set member that is not primary answer a read", async () => {
    const server = fakeServer(
      (command): Answer =>
        isHello(command)
          ? { isWritablePrimary: false, ok: 1, secondary: true, setName: "rs0" }
          : { ok: 1 }
    );
    await ask(`mongodb://127.0.0.1:${server.port}`);
    expect(server.commands[1]).toEqual({
      $db: "admin",
      $readPreference: { mode: "primaryPreferred" },
      ping: 1,
    });
  });

  test("tells a load balancer it is behind one", async () => {
    const server = fakeServer(standalone());
    await ask(`mongodb://127.0.0.1:${server.port}/?loadBalanced=true`);
    expect(server.commands[0]).toMatchObject({ hello: 1, loadBalanced: true });
  });

  test("refuses a command that is not on the read-only list before it connects", async () => {
    const server = fakeServer(standalone());
    const error = await failure(
      ask(`mongodb://127.0.0.1:${server.port}`, '{"dropDatabase": 1}')
    );
    expect(error.code).toBe("ERR_MONGODB_COMMAND_NOT_ALLOWED");
    expect(server.commands).toEqual([]);
  });

  test("refuses a command whose Extended JSON does not encode, before it connects", async () => {
    const server = fakeServer(standalone());
    const error = await failure(
      ask(
        `mongodb://127.0.0.1:${server.port}`,
        '{"count": "orders", "query": {"_id": {"$oid": "not-hex"}}}'
      )
    );
    expect(error.code).toBe("ERR_MONGODB_INVALID_COMMAND");
    expect(server.commands).toEqual([]);
  });

  test("rejects with the server's own code when it refuses the command", async () => {
    const server = fakeServer(
      standalone(() => ({
        code: 13,
        codeName: "Unauthorized",
        errmsg: "command dbStats requires authentication",
        ok: 0,
      }))
    );
    const error = await failure(
      ask(`mongodb://127.0.0.1:${server.port}`, '{"dbStats": 1}')
    );
    expect(error).toBeInstanceOf(MongoError);
    expect(error).toMatchObject({
      code: "ERR_MONGODB_SERVER_ERROR",
      errno: "13",
    });
  });

  test("rejects a server whose hello fails", async () => {
    const server = fakeServer(() => ({ code: 1, errmsg: "no", ok: 0 }));
    const error = await failure(ask(`mongodb://127.0.0.1:${server.port}`));
    expect(error.code).toBe("ERR_MONGODB_SERVER_ERROR");
  });

  test("names a plain connection closed before any reply by a server that speaks TLS as one that wants TLS", async () => {
    // A TLS listener ends a connection whose first bytes are no TLS handshake, as MongoDB's requireTLS does.
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
      tls: {
        cert: Bun.file(`${import.meta.dir}/fixtures/tls-cert.pem`),
        key: Bun.file(`${import.meta.dir}/fixtures/tls-key.pem`),
      },
    });
    try {
      const error = await failure(ask(`mongodb://127.0.0.1:${listener.port}`));
      expect(error.code).toBe("ERR_MONGODB_TLS_REQUIRED");
    } finally {
      listener.stop(true);
    }
  });

  test("names a plain connection closed before any reply by a server that speaks no TLS as closed, as a load balancer with no backend or a full server does", async () => {
    const server = fakeServer(() => "close");
    const error = await failure(ask(`mongodb://127.0.0.1:${server.port}`));
    expect(error.code).toBe("ConnectionClosed");
  });

  test("names a connection closed after the hello as closed", async () => {
    const server = fakeServer(standalone(() => "close"));
    const error = await failure(ask(`mongodb://127.0.0.1:${server.port}`));
    expect(error.code).toBe("ConnectionClosed");
  });

  test("refuses a reply past its cap", async () => {
    const server = fakeServer(
      standalone(() => ({ ok: 1, padding: "x".repeat(1_100_000) }))
    );
    const error = await failure(ask(`mongodb://127.0.0.1:${server.port}`));
    expect(error.code).toBe("ERR_MONGODB_PROTOCOL");
  });

  test("closes every socket it opened, and one still waiting on a reply", async () => {
    const server = fakeServer(standalone(() => "hang"));
    const connection = openMongo(
      {
        command: '{"ping": 1}',
        timeoutMs: 2000,
        url: `mongodb://127.0.0.1:${server.port}`,
      },
      platform
    );
    const pending = connection.ask().catch(() => undefined);
    await Bun.sleep(100);
    expect(server.closed()).toBe(false);
    connection.close();
    await pending;
    await Bun.sleep(50);
    expect(server.closed()).toBe(true);
  });
});

describe("a seed list", () => {
  test("is answered by the first server that says hello, past one that refuses", async () => {
    const refused = fakeServer(standalone());
    const { port } = refused;
    refused.stop();
    const server = fakeServer(standalone());
    expect(
      await ask(`mongodb://127.0.0.1:${port},127.0.0.1:${server.port}`)
    ).toBe(1);
  });

  test("closes the slower servers' connections once one answers", async () => {
    const slow = fakeServer(() => "hang");
    const fast = fakeServer(standalone());
    const connection = openMongo(
      {
        command: '{"ping": 1}',
        timeoutMs: 2000,
        url: `mongodb://127.0.0.1:${slow.port},127.0.0.1:${fast.port}`,
      },
      platform
    );
    expect(await connection.ask()).toBe(1);
    await Bun.sleep(50);
    expect(slow.closed()).toBe(true);
    expect(fast.closed()).toBe(false);
    connection.close();
  });

  test("connects to five servers at once and leaves the rest until those fail", async () => {
    const silent = Array.from({ length: 7 }, () => fakeServer(() => "hang"));
    const connection = openMongo(
      {
        command: '{"ping": 1}',
        timeoutMs: 2000,
        url: `mongodb://${silent.map((each) => `127.0.0.1:${each.port}`).join(",")}`,
      },
      platform
    );
    const pending = connection.ask().catch(() => undefined);
    await Bun.sleep(200);
    expect(silent.map((each) => each.accepted())).toEqual([
      1, 1, 1, 1, 1, 0, 0,
    ]);
    connection.close();
    await pending;
  });

  test("tries the servers past the first five once those five fail", async () => {
    const gone = Array.from({ length: 5 }, () => fakeServer(standalone()));
    const ports = gone.map((each) => each.port);
    for (const each of gone) {
      each.stop();
    }
    const live = fakeServer(standalone());
    const hosts = [...ports, live.port].map((port) => `127.0.0.1:${port}`);
    expect(await ask(`mongodb://${hosts.join(",")}`)).toBe(1);
  });

  test("that no server answers fails with the first server's error", async () => {
    const one = fakeServer(standalone());
    const two = fakeServer(standalone());
    const ports = [one.port, two.port];
    one.stop();
    two.stop();
    const error = await failure(
      ask(`mongodb://127.0.0.1:${ports[0]},127.0.0.1:${ports[1]}`)
    );
    expect(error.code).toBe("ECONNREFUSED");
  });
});

describe("a sign-in", () => {
  test("asks for the user's mechanisms in its hello and signs in with SCRAM-SHA-256 when the server lists it", async () => {
    const server = fakeServer((command) =>
      isHello(command)
        ? {
            isWritablePrimary: true,
            ok: 1,
            saslSupportedMechs: ["SCRAM-SHA-1", "SCRAM-SHA-256"],
          }
        : signingIn()(command)
    );
    expect(await ask(`mongodb://user:pencil@127.0.0.1:${server.port}`)).toBe(1);
    expect(server.commands[0]).toMatchObject({
      saslSupportedMechs: "admin.user",
    });
    const start = server.commands[1] ?? {};
    expect(start).toMatchObject({
      $db: "admin",
      mechanism: "SCRAM-SHA-256",
      options: { skipEmptyExchange: true },
      saslStart: 1,
    });
    expect(textOf(start.payload)).toBe(scram.clientFirst);
    const next = server.commands[2] ?? {};
    expect(next).toMatchObject({ conversationId: 1, saslContinue: 1 });
    expect(textOf(next.payload)).toBe(scram.clientFinal);
    expect(server.commands[3]).toEqual({ $db: "admin", ping: 1 });
    // The server reads a command's name from its document's first key.
    expect(server.commands.map((command) => Object.keys(command)[0])).toEqual([
      "isMaster",
      "saslStart",
      "saslContinue",
      "ping",
    ]);
  });

  test("signs in on the authSource, else the URL's database", async () => {
    for (const [query, source] of [
      ["authSource=users&", "users"],
      ["", "app"],
    ] as const) {
      const server = fakeServer(signingIn());
      // biome-ignore lint/performance/noAwaitInLoops: one server at a time
      await ask(
        `mongodb://user:pencil@127.0.0.1:${server.port}/app?${query}authMechanism=SCRAM-SHA-256`
      );
      expect(server.commands[1]).toMatchObject({ $db: source, saslStart: 1 });
    }
  });

  test("falls back to SCRAM-SHA-1 when the server lists no mechanisms", async () => {
    const server = fakeServer(
      standalone(
        (command): Answer =>
          "saslStart" in command
            ? { code: 18, errmsg: "Authentication failed.", ok: 0 }
            : { ok: 1 }
      )
    );
    await failure(ask(`mongodb://user:pencil@127.0.0.1:${server.port}`));
    expect(server.commands[1]).toMatchObject({ mechanism: "SCRAM-SHA-1" });
  });

  test("that the server refuses rejects as a failed sign-in with the server's code", async () => {
    const server = fakeServer(
      signingIn({
        start: {
          code: 18,
          codeName: "AuthenticationFailed",
          errmsg: "Authentication failed.",
          ok: 0,
        },
      })
    );
    const error = await failure(
      ask(
        `mongodb://user:pencil@127.0.0.1:${server.port}/?authMechanism=SCRAM-SHA-256`
      )
    );
    expect(error).toMatchObject({
      code: "ERR_MONGODB_AUTHENTICATION_FAILED",
      errno: "18",
    });
  });

  test("never runs the command when the server's signature is not the password's", async () => {
    const server = fakeServer(
      signingIn({
        continue: {
          conversationId: 1,
          done: true,
          ok: 1,
          payload: binary("v=AAAATRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="),
        },
      })
    );
    const error = await failure(
      ask(
        `mongodb://user:pencil@127.0.0.1:${server.port}/?authMechanism=SCRAM-SHA-256`
      )
    );
    expect(error.code).toBe("ERR_MONGODB_SASL_SIGNATURE_MISMATCH");
    expect(server.commands.some((command) => "ping" in command)).toBe(false);
  });

  test("refuses a server that says done before it proved it knows the password", async () => {
    const server = fakeServer(
      signingIn({
        start: {
          conversationId: 1,
          done: true,
          ok: 1,
          payload: binary(scram.serverFirst),
        },
      })
    );
    const error = await failure(
      ask(
        `mongodb://user:pencil@127.0.0.1:${server.port}/?authMechanism=SCRAM-SHA-256`
      )
    );
    expect(error.code).toBe("ERR_MONGODB_SASL_INVALID_MESSAGE");
  });

  test("finishes an older server's longer conversation with one empty step", async () => {
    let continues = 0;
    const server = fakeServer(
      standalone((command): Answer => {
        if ("saslStart" in command) {
          return {
            conversationId: 1,
            done: false,
            ok: 1,
            payload: binary(scram.serverFirst),
          };
        }
        if ("saslContinue" in command) {
          continues += 1;
          return continues === 1
            ? {
                conversationId: 1,
                done: false,
                ok: 1,
                payload: binary(scram.serverFinal),
              }
            : { conversationId: 1, done: true, ok: 1, payload: binary("") };
        }
        return { ok: 1 };
      })
    );
    expect(
      await ask(
        `mongodb://user:pencil@127.0.0.1:${server.port}/?authMechanism=SCRAM-SHA-256`
      )
    ).toBe(1);
    expect(continues).toBe(2);
  });
});

describe("TLS", () => {
  /** A platform whose connect records its options and completes a handshake with the given verification error. */
  function handshaking(authorizationError: Error | null) {
    const seen: { tls?: unknown } = {};
    const on: MongoPlatform = {
      ...platform,
      connect: ((options: Parameters<typeof Bun.connect>[0]) => {
        seen.tls = options.tls;
        // Past the handshake the fake server closes on the first bytes, so the check ends.
        const socket = {
          end: () => undefined,
          // A handshake that took place has the server's certificate, whatever its verification said.
          getPeerCertificate: () => ({ fingerprint256: "AA:BB" }),
          terminate: () => undefined,
          write: (bytes: Uint8Array) => {
            queueMicrotask(() =>
              options.socket.close?.(socket as never, undefined)
            );
            return bytes.length;
          },
        };
        // As Bun 1.4.4 does: without rejectUnauthorized, a chain error still reports success and only a name mismatch fails it.
        const loose =
          (options.tls as { rejectUnauthorized?: boolean } | undefined)
            ?.rejectUnauthorized === false;
        const success = loose
          ? (authorizationError as { code?: string } | null)?.code !==
            "ERR_TLS_CERT_ALTNAME_INVALID"
          : authorizationError === null;
        queueMicrotask(() =>
          options.socket.handshake?.(
            socket as never,
            success,
            authorizationError as never
          )
        );
        return Promise.resolve(socket);
      }) as never,
    };
    return { on, seen };
  }

  const altName = Object.assign(new Error("Hostname/IP does not match"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
  });
  const selfSigned = Object.assign(new Error("self signed certificate"), {
    code: "DEPTH_ZERO_SELF_SIGNED_CERT",
  });

  test("verifies the certificate and the host name by default, naming the host", async () => {
    const { on, seen } = handshaking(selfSigned);
    const error = await failure(
      ask("mongodb://db.example.com/?tls=true", undefined, on)
    );
    expect(error.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(seen.tls).toMatchObject({ serverName: "db.example.com" });
  });

  test("is on for an SRV URL without being asked", async () => {
    const handshake = handshaking(selfSigned);
    const { seen } = handshake;
    const on: MongoPlatform = {
      ...handshake.on,
      resolver: () => ({
        cancel: () => undefined,
        srv: () =>
          Promise.resolve([{ name: "n1.cluster.example.com", port: 27_017 }]),
        txt: () => Promise.resolve([]),
      }),
    };
    await failure(ask("mongodb+srv://cluster.example.com", undefined, on));
    expect(seen.tls).toMatchObject({ serverName: "n1.cluster.example.com" });
  });

  test("with invalid host names allowed accepts a certificate for another name and nothing worse", async () => {
    const other = handshaking(altName);
    const otherError = await failure(
      ask(
        "mongodb://db.example.com/?tls=true&tlsAllowInvalidHostnames=true",
        undefined,
        other.on
      )
    );
    // Past the handshake, the fake socket never answers hello: the sign-in went on.
    expect(otherError.code).not.toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    const worse = handshaking(selfSigned);
    expect(
      (
        await failure(
          ask(
            "mongodb://db.example.com/?tls=true&tlsAllowInvalidHostnames=true",
            undefined,
            worse.on
          )
        )
      ).code
    ).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  test("with invalid certificates allowed, or tlsInsecure, accepts any certificate", async () => {
    for (const option of [
      "tlsAllowInvalidCertificates=true",
      "tlsInsecure=true",
    ]) {
      const { on } = handshaking(selfSigned);
      // biome-ignore lint/performance/noAwaitInLoops: one platform at a time
      const error = await failure(
        ask(`mongodb://db.example.com/?tls=true&${option}`, undefined, on)
      );
      expect(error.code).not.toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    }
  });
});

describe("the seed list of a URL", () => {
  /** A resolver over fixed records; a name it lacks fails as DNS does. */
  function records(
    srv: Record<string, { name: string; port: number }[]>,
    txt: Record<string, string[][]> = {}
  ): Pick<SrvResolver, "srv" | "txt"> & { asked: string[] } {
    const asked: string[] = [];
    const missing = (name: string) =>
      Promise.reject(
        Object.assign(new Error(`no record for ${name}`), { code: "ENOTFOUND" })
      );
    return {
      asked,
      srv: (name) => {
        asked.push(`SRV ${name}`);
        return srv[name] ? Promise.resolve(srv[name]) : missing(name);
      },
      txt: (name) => {
        asked.push(`TXT ${name}`);
        return txt[name] ? Promise.resolve(txt[name]) : missing(name);
      },
    };
  }

  test("of a plain URL is its hosts, with no lookup", async () => {
    const dns = records({});
    const list = await seedList(parseConnectionString("mongodb://a:1,b"), dns);
    expect(list.hosts).toEqual([
      { host: "a", port: 1 },
      { host: "b", port: 27_017 },
    ]);
    expect(dns.asked).toEqual([]);
  });

  test("of an SRV URL is the SRV answer, its TXT options under the URL's own and TLS on", async () => {
    const dns = records(
      {
        "_mongodb._tcp.cluster.example.com": [
          { name: "n1.cluster.example.com.", port: 27_017 },
          { name: "N2.Cluster.Example.com", port: 27_018 },
        ],
      },
      { "cluster.example.com": [["authSource=admin&replica", "Set=rs0"]] }
    );
    const list = await seedList(
      parseConnectionString(
        "mongodb+srv://cluster.example.com/?authSource=users"
      ),
      dns
    );
    expect(list.hosts).toEqual([
      { host: "n1.cluster.example.com", port: 27_017 },
      { host: "n2.cluster.example.com", port: 27_018 },
    ]);
    expect(list.options).toMatchObject({
      authSource: "users",
      replicaSet: "rs0",
      tls: true,
    });
  });

  test("of an SRV URL asks the service its srvServiceName names, and keeps no more than srvMaxHosts", async () => {
    const dns = records(
      {
        "_custom._tcp.cluster.example.com": [
          { name: "n1.cluster.example.com", port: 1 },
          { name: "n2.cluster.example.com", port: 2 },
          { name: "n3.cluster.example.com", port: 3 },
        ],
      },
      { "cluster.example.com": [] }
    );
    const list = await seedList(
      parseConnectionString(
        "mongodb+srv://cluster.example.com/?srvServiceName=custom&srvMaxHosts=2"
      ),
      dns
    );
    expect(list.hosts).toHaveLength(2);
  });

  test.each([
    ["a host outside the SRV name's domain", { name: "n1.evil.com", port: 1 }],
    [
      "a host that only ends with the domain's letters",
      { name: "n1.notexample.com", port: 1 },
    ],
  ])("of an SRV URL refuses %s", async (_, record) => {
    const dns = records(
      { "_mongodb._tcp.cluster.example.com": [record] },
      { "cluster.example.com": [] }
    );
    const error = await failure(
      seedList(parseConnectionString("mongodb+srv://cluster.example.com"), dns)
    );
    expect(error.code).toBe("ERR_MONGODB_SRV_INVALID");
  });

  test.each([
    ["two TXT records", [["replicaSet=rs0"], ["authSource=admin"]]],
    ["an option a TXT record may not give", [["ssl=false"]]],
    ["an option without a value", [["authSource"]]],
  ])("of an SRV URL refuses %s", async (_, txt) => {
    const dns = records(
      {
        "_mongodb._tcp.cluster.example.com": [
          { name: "n1.cluster.example.com", port: 1 },
        ],
      },
      { "cluster.example.com": txt }
    );
    const error = await failure(
      seedList(parseConnectionString("mongodb+srv://cluster.example.com"), dns)
    );
    expect(error.code).toBe("ERR_MONGODB_SRV_INVALID");
  });

  test("of an SRV URL refuses options its TXT record makes conflict with the answer", async () => {
    const dns = records(
      {
        "_mongodb._tcp.cluster.example.com": [
          { name: "n1.cluster.example.com", port: 1 },
          { name: "n2.cluster.example.com", port: 2 },
        ],
      },
      { "cluster.example.com": [["loadBalanced=true"]] }
    );
    const error = await failure(
      seedList(parseConnectionString("mongodb+srv://cluster.example.com"), dns)
    );
    expect(error.code).toBe("ERR_MONGODB_SRV_INVALID");
  });

  test("of an SRV name with no record fails with the resolver's own code", async () => {
    const error = await failure(
      seedList(
        parseConnectionString("mongodb+srv://cluster.example.com"),
        records({})
      )
    );
    expect(error.code).toBe("ENOTFOUND");
  });

  test("of an SRV name with no TXT record has no options from DNS", async () => {
    const dns = records({
      "_mongodb._tcp.cluster.example.com": [
        { name: "n1.cluster.example.com", port: 1 },
      ],
    });
    const list = await seedList(
      parseConnectionString("mongodb+srv://cluster.example.com"),
      dns
    );
    expect(list.options.replicaSet).toBe(undefined);
  });
});

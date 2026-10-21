/**
 * Test support: certificates made with openssl at test time into a temporary
 * directory, never committed: a CA, a server certificate for 127.0.0.1, and
 * client certificates (good, signed by another CA, expired, not yet valid, with
 * an encrypted key), and a `Bun.serve` that requires a client certificate the
 * CA signed. Not product code.
 */

export interface PemPair {
  readonly cert: string;
  readonly key: string;
}

/** The passphrase of the encrypted client key. */
export const keyPassphrase = "correct horse staple";

export interface MutualTls {
  readonly ca: string;
  readonly cleanup: () => Promise<void>;
  readonly client: PemPair;
  /** The same key and certificate as `client`, the key encrypted with `keyPassphrase`. */
  readonly clientEncrypted: PemPair;
  readonly clientExpired: PemPair;
  readonly clientNotYetValid: PemPair;
  /** A client certificate a CA the server does not trust signed. */
  readonly clientOther: PemPair;
  readonly otherCa: string;
  readonly server: PemPair;
}

function openssl(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["openssl", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`openssl ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

/** Makes the certificates in a new temporary directory. */
export async function mutualTls(): Promise<MutualTls> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  const curve = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"];
  for (const name of ["ca", "other-ca"]) {
    openssl(
      dir,
      "req",
      "-x509",
      ...curve,
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.pem`,
      "-days",
      "2",
      "-subj",
      `/CN=${name}`
    );
  }
  await Bun.write(
    `${dir}/san.ext`,
    "subjectAltName=IP:127.0.0.1,DNS:localhost\n"
  );
  const issue = (
    name: string,
    ca: string,
    validity: string[],
    extension?: string
  ) => {
    openssl(
      dir,
      "req",
      ...curve,
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`
    );
    openssl(
      dir,
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${ca}.pem`,
      "-CAkey",
      `${ca}.key`,
      "-CAcreateserial",
      "-out",
      `${name}.pem`,
      ...validity,
      ...(extension ? ["-extfile", extension] : [])
    );
  };
  const days = ["-days", "2"];
  issue("server", "ca", days, "san.ext");
  issue("client", "ca", days);
  issue("client-other", "other-ca", days);
  issue("client-expired", "ca", [
    "-not_before",
    "20200101000000Z",
    "-not_after",
    "20200102000000Z",
  ]);
  issue("client-future", "ca", [
    "-not_before",
    "20990101000000Z",
    "-not_after",
    "20990102000000Z",
  ]);
  openssl(
    dir,
    "pkey",
    "-in",
    "client.key",
    "-aes256",
    "-passout",
    `pass:${keyPassphrase}`,
    "-out",
    "client-encrypted.key"
  );
  const read = (name: string) => Bun.file(`${dir}/${name}`).text();
  const pair = async (cert: string, key = cert): Promise<PemPair> => ({
    cert: await read(`${cert}.pem`),
    key: await read(`${key}.key`),
  });
  const encrypted = {
    cert: await read("client.pem"),
    key: await read("client-encrypted.key"),
  };
  return {
    ca: await read("ca.pem"),
    cleanup: async () => {
      await Bun.$`rm -rf ${dir}`.quiet();
    },
    client: await pair("client"),
    clientEncrypted: encrypted,
    clientExpired: await pair("client-expired"),
    clientNotYetValid: await pair("client-future"),
    clientOther: await pair("client-other"),
    otherCa: await read("other-ca.pem"),
    server: await pair("server"),
  };
}

/** An https server on a free loopback port that closes the handshake of a client with no certificate the CA signed, and answers `ok` to any other. */
export function serveMutualTls(certs: MutualTls): {
  stop: () => void;
  url: string;
} {
  const server = Bun.serve({
    fetch: () => new Response("ok"),
    port: 0,
    tls: {
      ca: certs.ca,
      cert: certs.server.cert,
      key: certs.server.key,
      rejectUnauthorized: true,
      requestCert: true,
    },
  });
  return {
    stop: () => server.stop(true),
    url: `https://127.0.0.1:${server.port}/`,
  };
}

/**
 * A forward proxy that tunnels a CONNECT to its target and pipes the bytes, so
 * a TLS handshake, a client certificate in it, passes through untouched. Its
 * `connects` are the CONNECT lines it saw.
 */
export function tunnelProxy(): {
  connects: string[];
  stop: () => void;
  url: string;
} {
  const connects: string[] = [];
  const proxy = Bun.listen<{ upstream?: Bun.Socket }>({
    data: {},
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async data(socket, chunk) {
        if (socket.data.upstream) {
          socket.data.upstream.write(chunk);
          return;
        }
        const [line = ""] = chunk.toString("latin1").split("\r\n");
        connects.push(line);
        const [host = "", port = ""] = (line.split(" ")[1] ?? "").split(":");
        socket.data = {};
        const upstream = await Bun.connect({
          hostname: host,
          port: Number(port),
          socket: {
            close() {
              socket.end();
            },
            data(_peer, bytes) {
              socket.write(bytes);
            },
          },
        });
        socket.data = { upstream };
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      },
    },
  });
  return {
    connects,
    stop: () => proxy.stop(true),
    url: `http://127.0.0.1:${proxy.port}`,
  };
}

/** A TLS listener, as an https proxy is, that only counts the connections it gets. */
export function tlsListener(certs: MutualTls): {
  connections: () => number;
  stop: () => void;
  url: string;
} {
  const state = { opened: 0 };
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {
        // Nothing is answered: the count is the evidence.
      },
      open() {
        state.opened += 1;
      },
    },
    tls: { cert: certs.server.cert, key: certs.server.key },
  });
  return {
    connections: () => state.opened,
    stop: () => server.stop(true),
    url: `https://127.0.0.1:${server.port}`,
  };
}

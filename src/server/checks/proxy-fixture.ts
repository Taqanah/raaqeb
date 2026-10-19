/**
 * Test support: a forward proxy on `Bun.listen` that records each request's
 * first line and headers and answers it, so a test can see whether a request
 * reached it and with what. A CONNECT, the tunnel of an https request, is
 * refused with 502 by default, since the recorded line is the evidence; any
 * other request is answered 200. Beside it, the proxy environment a test
 * sets and restores. Not product code.
 */

export interface ProxyRequest {
  /** The headers by lower-cased name. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request line: `GET http://host/path HTTP/1.1` or `CONNECT host:443 HTTP/1.1`. */
  readonly line: string;
}

export interface ProxyReply {
  readonly headers?: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface TestProxy {
  readonly requests: ProxyRequest[];
  readonly stop: () => void;
  readonly url: string;
}

const refuseTunnels = (request: ProxyRequest): ProxyReply => ({
  status: request.line.startsWith("CONNECT") ? 502 : 200,
});

/** A proxy on a free loopback port; `reply` decides each answer. */
export function startProxy(
  reply: (request: ProxyRequest) => ProxyReply = refuseTunnels
): TestProxy {
  const requests: ProxyRequest[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const head = chunk.toString("latin1").split("\r\n\r\n")[0] ?? "";
        const [line = "", ...lines] = head.split("\r\n");
        const headers: Record<string, string> = {};
        for (const header of lines) {
          const colon = header.indexOf(":");
          headers[header.slice(0, colon).toLowerCase()] = header
            .slice(colon + 1)
            .trim();
        }
        const request = { headers, line };
        requests.push(request);
        const { headers: extra = {}, status } = reply(request);
        const sent = Object.entries(extra)
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join("");
        socket.write(
          `HTTP/1.1 ${status} X\r\ncontent-length: 2\r\nconnection: close\r\n${sent}\r\nok`
        );
        socket.end();
      },
    },
  });
  return {
    requests,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}`,
  };
}

const names = [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

type ProxyEnvironment = Partial<
  Record<"ALL_PROXY" | "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY", string>
>;

/** Sets exactly these proxy variables, the others unset, and answers the way back. Bun reads them at each request. */
export function setProxyEnvironment(values: ProxyEnvironment): () => void {
  const before = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

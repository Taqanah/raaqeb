/**
 * The webhook receiver of the e2e run: a POST to `/ok/...` or to the root
 * (where ntfy publishes) answers 200 and one anywhere else answers 500,
 * and `GET /received` answers every POST it got, with its headers and
 * body, as JSON. The channels spec points its
 * webhook here and checks what Raaqeb sent. Not product code.
 */
const [, , port] = Bun.argv;
if (!port) {
  process.stderr.write("usage: bun e2e/support/sink.ts <port>\n");
  process.exit(2);
}

interface Received {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly path: string;
}

const received: Received[] = [];

Bun.serve({
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/received") {
      return Response.json(received);
    }
    received.push({
      body: await request.text(),
      headers: Object.fromEntries(request.headers),
      path: pathname,
    });
    return new Response(null, {
      status: pathname.startsWith("/ok/") || pathname === "/" ? 200 : 500,
    });
  },
  hostname: "127.0.0.1",
  port: Number(port),
});

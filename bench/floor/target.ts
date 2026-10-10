/**
 * The synthetic target the seeded monitors check, run in its own
 * container from the mounted harness folder: HTTP with a healthy, a slow, a
 * failing and a flapping path, the webhook sink and a fake Docker Engine
 * API's container inspect, HTTPS with the committed
 * self-signed test certificate, a TCP port that accepts, and the DNS
 * responder. It imports only harness files with no run-time imports of
 * their own, since nothing else is mounted beside them.
 */
import { dnsAnswer } from "./dns.ts";
import {
  containerInspect,
  dnsAddress,
  flapIsDown,
  slowMs,
  targetPorts,
} from "./fleet.ts";

const flapPath = /^\/flap\/(\d+)$/;
const inspectPath = /^\/containers\/([^/]+)\/json$/;

/** Webhook posts the sink received, read by the harness at the end of a part. */
let received = 0;

/** Whether `/fail` fails: healthy until the harness posts to it, so one install measures the quiet paths first and the incident after. */
let failing = false;

function answer(request: Request): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/sink") {
    if (request.method === "POST") {
      received += 1;
      return new Response("ok");
    }
    return Response.json({ received });
  }
  if (pathname === "/fail") {
    if (request.method === "POST") {
      failing = true;
      return new Response("ok");
    }
    return failing
      ? new Response("failing", { status: 500 })
      : new Response("ok");
  }
  const inspect = inspectPath.exec(pathname);
  if (inspect?.[1]) {
    return Response.json(
      containerInspect(decodeURIComponent(inspect[1]), Date.now())
    );
  }
  if (pathname === "/slow") {
    return Bun.sleep(slowMs).then(() => new Response("ok"));
  }
  const flap = flapPath.exec(pathname);
  if (flap && flapIsDown(Number(flap[1]), Date.now())) {
    return new Response("down", { status: 503 });
  }
  return new Response("ok");
}

Bun.serve({ fetch: answer, hostname: "0.0.0.0", port: targetPorts.http });

Bun.serve({
  fetch: () => new Response("ok"),
  hostname: "0.0.0.0",
  port: targetPorts.https,
  tls: {
    cert: Bun.file("/fixtures/tls-cert.pem"),
    key: Bun.file("/fixtures/tls-key.pem"),
  },
});

// A TCP check only opens a connection and closes it again.
Bun.listen({
  hostname: "0.0.0.0",
  port: targetPorts.tcp,
  socket: { data: () => undefined },
});

await Bun.udpSocket({
  hostname: "0.0.0.0",
  port: targetPorts.dns,
  socket: {
    data(socket, query, port, address) {
      const reply = dnsAnswer(new Uint8Array(query), dnsAddress);
      if (reply) {
        socket.send(reply, port, address);
      }
    },
  },
});

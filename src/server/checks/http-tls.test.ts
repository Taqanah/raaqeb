import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type HttpMonitor, runHttpCheck } from "./http.ts";

let dir: string;
beforeAll(async () => {
  dir = (await Bun.$`mktemp -d`.text()).trim();
});
afterAll(async () => {
  await Bun.$`rm -rf ${dir}`.quiet();
});

/** A self-signed server certificate for 127.0.0.1 made with openssl at test time, with the key options and extensions given. */
async function selfSigned(
  name: string,
  options: string[]
): Promise<{ cert: string; key: string }> {
  await Bun.$`openssl req -x509 ${options} -nodes -keyout ${name}.key -out ${name}.pem -days 2 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`
    .cwd(dir)
    .quiet();
  return {
    cert: await Bun.file(`${dir}/${name}.pem`).text(),
    key: await Bun.file(`${dir}/${name}.key`).text(),
  };
}

/** One check, trusting the server's own certificate as the monitor's CA, against an https server on a free loopback port. */
async function checkAgainst(pair: { cert: string; key: string }) {
  const server = Bun.serve({
    fetch: () => new Response("ok"),
    port: 0,
    tls: pair,
  });
  const monitor: HttpMonitor = {
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      caCertificates: pair.cert,
      captureMode: "always",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: `https://127.0.0.1:${server.port}/`,
    },
    credentials: undefined,
    degradedMs: undefined,
    id: "m1",
    retries: 0,
    timeoutMs: 5000,
  };
  try {
    return await runHttpCheck(monitor, {
      fetch,
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
    });
  } finally {
    server.stop(true);
  }
}

describe("an HTTP check over TLS", () => {
  test("reaches a server whose certificate has an Ed25519 key", async () => {
    const outcome = await checkAgainst(
      await selfSigned("ed25519", ["-newkey", "ed25519"])
    );
    expect(outcome.check.result).toBe("up");
  });

  test("trusts a self-signed server certificate that is not marked as a CA when the monitor's CA is that certificate", async () => {
    const outcome = await checkAgainst(
      await selfSigned("leaf", [
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-addext",
        "basicConstraints=critical,CA:FALSE",
        "-addext",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "-addext",
        "extendedKeyUsage=serverAuth",
      ])
    );
    expect(outcome.check.result).toBe("up");
  });
});

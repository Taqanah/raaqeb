import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HttpConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { type CheckIo, type HttpMonitor, runHttpCheck } from "./http.ts";
import {
  keyPassphrase,
  type MutualTls,
  mutualTls,
  serveMutualTls,
  tlsListener,
  tunnelProxy,
} from "./mtls-fixture.ts";
import { setProxyEnvironment } from "./proxy-fixture.ts";

let certs: MutualTls;
let server: { stop: () => void; url: string };
beforeAll(async () => {
  certs = await mutualTls();
  server = serveMutualTls(certs);
});
afterAll(async () => {
  server.stop();
  await certs.cleanup();
});

/** Real network, counting each request the check starts. */
function liveIo(): { io: CheckIo; requests: () => number } {
  let started = 0;
  return {
    io: {
      fetch: ((input, init) => {
        started += 1;
        return fetch(input, init);
      }) as typeof fetch,
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
    },
    requests: () => started,
  };
}

function monitor(
  options: {
    config?: Partial<HttpConfig>;
    key?: { key: string; passphrase?: string };
    url?: string;
  } = {}
): HttpMonitor {
  return {
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "always",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: options.url ?? server.url,
      ...options.config,
    },
    credentials: options.key
      ? { clientKey: options.key, headers: [] }
      : undefined,
    degradedMs: undefined,
    id: "m1",
    retries: 0,
    timeoutMs: 5000,
  };
}

const trusted = () => ({ caCertificates: certs.ca });

describe("an HTTP check against a server that requires a client certificate", () => {
  test("presents the monitor's certificate and key, and trusts the monitor's CA, so the check is up", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(
      monitor({
        config: { clientCertificate: certs.client.cert, ...trusted() },
        key: { key: certs.client.key },
      }),
      io
    );
    expect(outcome.check.result).toBe("up");
    expect(outcome.check.statusCode).toBe(200);
  });

  test("opens an encrypted key with its passphrase", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(
      monitor({
        config: { clientCertificate: certs.clientEncrypted.cert, ...trusted() },
        key: { key: certs.clientEncrypted.key, passphrase: keyPassphrase },
      }),
      io
    );
    expect(outcome.check.result).toBe("up");
  });

  test("without a client certificate the server ends the handshake, as a connection failure the check cannot tell from any other", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(monitor({ config: trusted() }), io);
    expect(outcome.check.result).toBe("down");
    expect(outcome.check.reason).toBe(reasons.connection_failed);
  });

  test("a certificate whose key could not be opened is not presented, so a refusal is not read as its", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(
      {
        ...monitor({
          config: { clientCertificate: certs.client.cert, ...trusted() },
        }),
      },
      io
    );
    expect(outcome.check.reason).toBe(reasons.connection_failed);
  });

  test("a certificate a CA the server does not trust signed is the client certificate refused, with the driver's code", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(
      monitor({
        config: { clientCertificate: certs.clientOther.cert, ...trusted() },
        key: { key: certs.clientOther.key },
      }),
      io
    );
    expect(outcome.check.result).toBe("down");
    expect(outcome.check.reason).toBe(reasons.client_certificate_refused);
    expect(outcome.detail?.params).toEqual({
      code: "ECONNRESET",
      reason: "client_certificate_refused",
    });
  });

  test("an expired certificate is its own reason, judged before any request is sent, on every attempt", async () => {
    const { io, requests } = liveIo();
    const outcome = await runHttpCheck(
      {
        ...monitor({
          config: { clientCertificate: certs.clientExpired.cert, ...trusted() },
          key: { key: certs.clientExpired.key },
        }),
        retries: 1,
      },
      io
    );
    expect(outcome.check.reason).toBe(reasons.client_certificate_expired);
    expect(outcome.detail?.params).toEqual({
      code: "expired",
      reason: "client_certificate_expired",
    });
    expect(requests()).toBe(0);
  });

  test("a certificate that is not yet valid is the same reason with its own code", async () => {
    const { io, requests } = liveIo();
    const outcome = await runHttpCheck(
      monitor({
        config: {
          clientCertificate: certs.clientNotYetValid.cert,
          ...trusted(),
        },
        key: { key: certs.clientNotYetValid.key },
      }),
      io
    );
    expect(outcome.detail?.params).toEqual({
      code: "not_yet_valid",
      reason: "client_certificate_expired",
    });
    expect(requests()).toBe(0);
  });

  test("a server certificate the monitor's CA did not sign is a certificate problem, not the client certificate's", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(
      monitor({
        config: {
          caCertificates: certs.otherCa,
          clientCertificate: certs.client.cert,
        },
        key: { key: certs.client.key },
      }),
      io
    );
    expect(outcome.check.reason).toBe(reasons.certificate_invalid);
  });

  test("with ignore TLS errors on, the client certificate is still presented", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(
      monitor({
        config: { clientCertificate: certs.client.cert, ignoreTlsErrors: true },
        key: { key: certs.client.key },
      }),
      io
    );
    expect(outcome.check.result).toBe("up");
  });

  test("a failure never repeats the key or its passphrase", async () => {
    const { io } = liveIo();
    const outcome = await runHttpCheck(
      monitor({
        config: { clientCertificate: certs.clientOther.cert, ...trusted() },
        key: { key: certs.clientOther.key, passphrase: keyPassphrase },
      }),
      io
    );
    const written = JSON.stringify(outcome);
    const keyLine = certs.clientOther.key.split("\n")[1] ?? "";
    expect(keyLine.length).toBeGreaterThan(40);
    expect(outcome.check.reason).toBe(reasons.client_certificate_refused);
    expect(written).not.toContain(keyPassphrase);
    expect(written).not.toContain(keyLine);
  });
});

describe("a client certificate through a proxy", () => {
  test("a monitor's own proxy tunnels the handshake, and the certificate reaches the server", async () => {
    const proxy = tunnelProxy();
    try {
      const { io } = liveIo();
      const outcome = await runHttpCheck(
        monitor({
          config: {
            clientCertificate: certs.client.cert,
            proxy: proxy.url,
            ...trusted(),
          },
          key: { key: certs.client.key },
        }),
        io
      );
      expect(outcome.check.result).toBe("up");
      expect(proxy.connects).toHaveLength(1);
      expect(proxy.connects[0]).toStartWith("CONNECT 127.0.0.1:");
    } finally {
      proxy.stop();
    }
  });

  test("the install's proxy environment tunnels it the same", async () => {
    const proxy = tunnelProxy();
    const restore = setProxyEnvironment({ HTTPS_PROXY: proxy.url });
    try {
      const { io } = liveIo();
      const outcome = await runHttpCheck(
        monitor({
          config: { clientCertificate: certs.client.cert, ...trusted() },
          key: { key: certs.client.key },
        }),
        io
      );
      expect(outcome.check.result).toBe("up");
      expect(proxy.connects).toHaveLength(1);
    } finally {
      restore();
      proxy.stop();
    }
  });

  test("a tunnelled server that refuses the certificate is still the client certificate refused", async () => {
    const proxy = tunnelProxy();
    try {
      const { io } = liveIo();
      const outcome = await runHttpCheck(
        monitor({
          config: {
            clientCertificate: certs.clientOther.cert,
            proxy: proxy.url,
            ...trusted(),
          },
          key: { key: certs.clientOther.key },
        }),
        io
      );
      expect(outcome.check.reason).toBe(reasons.client_certificate_refused);
    } finally {
      proxy.stop();
    }
  });
});

describe("a client certificate and an https proxy", () => {
  test("is refused before any connection, so the proxy is never shown the certificate nor made to verify the monitor's CA", async () => {
    const proxy = tlsListener(certs);
    try {
      const { io } = liveIo();
      const outcome = await runHttpCheck(
        monitor({
          config: {
            clientCertificate: certs.client.cert,
            proxy: proxy.url,
            ...trusted(),
          },
          key: { key: certs.client.key },
        }),
        io
      );
      expect(outcome.check.reason).toBe(reasons.tls_proxy_unsupported);
      expect(proxy.connections()).toBe(0);
    } finally {
      proxy.stop();
    }
  });
});

/** An https server like `serveMutualTls` that answers a token at `/token` and `ok` elsewhere, counting the token requests it gets. */
function serveTokenAndApi(): {
  stop: () => void;
  tokenRequests: () => number;
  url: string;
} {
  let asked = 0;
  const listener = Bun.serve({
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/token") {
        return new Response("ok");
      }
      asked += 1;
      return Response.json({
        access_token: "tok-mtls",
        expires_in: 3600,
        token_type: "Bearer",
      });
    },
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
    stop: () => listener.stop(true),
    tokenRequests: () => asked,
    url: `https://127.0.0.1:${listener.port}`,
  };
}

/** A monitor of `url` with the client certificate, and OAuth 2.0 client credentials asked of `tokenUrl`. */
function oauthMonitor(
  url: string,
  tokenUrl: string,
  config: Partial<HttpConfig> = {}
): HttpMonitor {
  const base = monitor({
    config: { clientCertificate: certs.client.cert, ...config },
    key: { key: certs.client.key },
    url,
  });
  return {
    ...base,
    credentials: {
      auth: {
        clientId: "raaqeb",
        clientSecret: "client-secret-9",
        kind: "oauth2",
        method: "basic",
        tokenUrl,
      },
      clientKey: { key: certs.client.key },
      headers: [],
    },
  };
}

describe("an OAuth 2.0 token endpoint and the monitor's own TLS", () => {
  test("a token endpoint on the target's origin is asked with the monitor's CA and client certificate, so the check is up", async () => {
    const both = serveTokenAndApi();
    try {
      const { io } = liveIo();
      const outcome = await runHttpCheck(
        oauthMonitor(`${both.url}/health`, `${both.url}/token`, trusted()),
        io
      );
      expect(both.tokenRequests()).toBe(1);
      expect(outcome.check.result).toBe("up");
    } finally {
      both.stop();
    }
  });

  test("a token endpoint on another origin is never shown the client certificate, as a redirect there is not", async () => {
    const target = serveTokenAndApi();
    const other = serveTokenAndApi();
    try {
      const { io } = liveIo();
      // TLS errors ignored, so only the missing certificate can end the handshake.
      const outcome = await runHttpCheck(
        oauthMonitor(`${target.url}/health`, `${other.url}/token`, {
          ignoreTlsErrors: true,
        }),
        io
      );
      expect(outcome.check.reason).toBe(reasons.oauth2_token_failed);
      expect(other.tokenRequests()).toBe(0);
    } finally {
      target.stop();
      other.stop();
    }
  });
});

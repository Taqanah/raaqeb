import { describe, expect, test } from "bun:test";
import type { HttpConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { type CheckIo, type HttpMonitor, runHttpCheck } from "./http.ts";
import { setProxyEnvironment } from "./proxy-fixture.ts";

const cert = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
const key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";

interface Seen {
  tls: Record<string, unknown> | undefined;
  url: string;
}
type Step = Response | Error;

/** A fetch that records each hop's URL and `tls`, and answers the steps in order. */
function scripted(steps: Step[]): { io: CheckIo; seen: Seen[] } {
  const seen: Seen[] = [];
  const io: CheckIo = {
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        tls: (init as { tls?: Record<string, unknown> } | undefined)?.tls,
        url: String(input),
      });
      const step = steps.shift();
      if (!step) {
        throw new Error("the fake fetch ran out of answers");
      }
      return step instanceof Error
        ? Promise.reject(step)
        : Promise.resolve(step);
    }) as typeof fetch,
    now: () => 1_700_000_000_000,
    sleep: () => Promise.resolve(),
  };
  return { io, seen };
}

const redirect = (location: string) =>
  new Response(null, { headers: { location }, status: 302 });
const reset = () =>
  Object.assign(new TypeError("closed"), { code: "ECONNRESET" });

function monitor(config: Partial<HttpConfig> = {}): HttpMonitor {
  return {
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      caCertificates: cert,
      captureMode: "off",
      clientCertificate: cert,
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: "https://api.example.test/start",
      ...config,
    },
    credentials: {
      clientKey: { key, passphrase: "pass phrase" },
      headers: [],
    },
    degradedMs: undefined,
    id: "m1",
    retries: 0,
    timeoutMs: 10_000,
  };
}

describe("a client certificate across redirects", () => {
  test("goes to the origin it was configured for and no other: the certificate, key, passphrase and CA are left behind on a cross-origin hop, which verifies with the system roots", async () => {
    const { io, seen } = scripted([
      redirect("https://elsewhere.example.test/next"),
      new Response("ok"),
    ]);
    const outcome = await runHttpCheck(monitor(), io);
    expect(outcome.check.result).toBe("up");
    expect(seen[0]?.tls).toEqual({
      ca: cert,
      cert,
      key,
      passphrase: "pass phrase",
    });
    expect(seen[1]?.tls).toBeUndefined();
  });

  test("keeps only the choice to ignore TLS errors on a cross-origin hop, which the operator made for every address", async () => {
    const { io, seen } = scripted([
      redirect("https://elsewhere.example.test/next"),
      new Response("ok"),
    ]);
    await runHttpCheck(monitor({ ignoreTlsErrors: true }), io);
    expect(seen[1]?.tls).toEqual({ rejectUnauthorized: false });
  });

  test("keeps all of it on a hop to the same origin", async () => {
    const { io, seen } = scripted([redirect("/next"), new Response("ok")]);
    await runHttpCheck(monitor(), io);
    expect(seen[1]?.tls).toEqual(seen[0]?.tls);
  });
});

describe("the client certificate refused, read of the hop that carried it", () => {
  test("a reset on the hop that carried the certificate is its refusal", async () => {
    const { io } = scripted([reset()]);
    const outcome = await runHttpCheck(monitor(), io);
    expect(outcome.check.reason).toBe(reasons.client_certificate_refused);
  });

  test("a reset on a cross-origin hop, which carried none, is a connection failure", async () => {
    const { io } = scripted([
      redirect("https://elsewhere.example.test/next"),
      reset(),
    ]);
    const outcome = await runHttpCheck(monitor(), io);
    expect(outcome.check.reason).toBe(reasons.connection_failed);
  });

  test("a reset on a same-origin hop, which carried it, is its refusal", async () => {
    const { io } = scripted([redirect("/next"), reset()]);
    const outcome = await runHttpCheck(monitor(), io);
    expect(outcome.check.reason).toBe(reasons.client_certificate_refused);
  });
});

describe("a custom CA or a client certificate through an https proxy", () => {
  test("is refused before any request, since Bun verifies the proxy with the same CA and hands it the certificate", async () => {
    const { io, seen } = scripted([new Response("ok")]);
    const outcome = await runHttpCheck(
      monitor({ proxy: "https://proxy.example.test:8443" }),
      io
    );
    expect(outcome.check.result).toBe("down");
    expect(outcome.check.reason).toBe(reasons.tls_proxy_unsupported);
    expect(outcome.detail?.params).toEqual({
      reason: "tls_proxy_unsupported",
    });
    expect(seen).toHaveLength(0);
  });

  test("is refused for the install's https proxy too, for a target it applies to", async () => {
    const restore = setProxyEnvironment({
      HTTPS_PROXY: "https://proxy.example.test:8443",
    });
    try {
      const { io, seen } = scripted([new Response("ok")]);
      const outcome = await runHttpCheck(monitor(), io);
      expect(outcome.check.reason).toBe(reasons.tls_proxy_unsupported);
      expect(seen).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("is refused through ALL_PROXY too, and for a custom CA alone, with no client certificate", async () => {
    const restore = setProxyEnvironment({
      ALL_PROXY: "https://proxy.example.test:8443",
    });
    try {
      const { io, seen } = scripted([new Response("ok")]);
      const caOnly = {
        ...monitor({ clientCertificate: undefined }),
        credentials: undefined,
      };
      const outcome = await runHttpCheck(caOnly, io);
      expect(outcome.check.reason).toBe(reasons.tls_proxy_unsupported);
      expect(seen).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("is not refused for an http proxy, own or the install's, nor for a host NO_PROXY exempts", async () => {
    for (const [config, env] of [
      [{ proxy: "http://proxy.example.test:3128" }, {}],
      [{}, { HTTPS_PROXY: "http://proxy.example.test:3128" }],
      [
        {},
        {
          HTTPS_PROXY: "https://proxy.example.test:8443",
          NO_PROXY: "localhost, .example.test",
        },
      ],
      [{}, { ALL_PROXY: "https://proxy.example.test:8443", NO_PROXY: "*" }],
    ] as const) {
      const restore = setProxyEnvironment(env);
      try {
        const { io, seen } = scripted([new Response("ok")]);
        // biome-ignore lint/performance/noAwaitInLoops: one case after the other
        const outcome = await runHttpCheck(monitor(config), io);
        expect(outcome.check.result, JSON.stringify([config, env])).toBe("up");
        expect(seen).toHaveLength(1);
      } finally {
        restore();
      }
    }
  });

  test("is not refused for a monitor with neither, which a proxy serves as it always did", async () => {
    const restore = setProxyEnvironment({
      HTTPS_PROXY: "https://proxy.example.test:8443",
    });
    try {
      const { io } = scripted([new Response("ok")]);
      const bare = monitor({
        caCertificates: undefined,
        clientCertificate: undefined,
      });
      const outcome = await runHttpCheck(
        { ...bare, credentials: undefined },
        io
      );
      expect(outcome.check.result).toBe("up");
    } finally {
      restore();
    }
  });
});

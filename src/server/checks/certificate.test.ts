import { describe, expect, test } from "bun:test";
import type { CertificateRecord } from "@/shared/schemas/certificate.ts";
import type { HttpConfig } from "@/shared/schemas/monitor.ts";
import {
  certificateReadDue,
  certificateReadIntervalMs,
  certificateReadTimeoutMs,
  certificateRecordOf,
  certificateTarget,
  type PeerCertificate,
  readCertificate,
  type TlsIo,
  type TlsTarget,
} from "./certificate.ts";

const now = 1_700_000_000_000;

const https: HttpConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  tlsExpiryDays: 14,
  type: "http",
  url: "https://example.test/health",
};

const peer: PeerCertificate = {
  fingerprint256:
    "61:53:A9:6F:D1:A6:AB:7F:4D:43:8F:C3:49:32:48:42:99:D0:72:9D:91:40:B3:A1:26:BB:2F:9C:07:B0:22:00",
  issuer: {
    C: "US",
    O: "SSL Corporation",
    CN: "Cloudflare TLS Issuing ECC CA 3",
  },
  subject: { CN: "example.test" },
  subjectaltname: "DNS:example.test, DNS:*.example.test, IP Address:192.0.2.1",
  valid_from: "Jul 29 22:10:08 2026 GMT",
  valid_to: "Oct 27 22:17:21 2026 GMT",
};

const record: CertificateRecord = {
  fingerprint: peer.fingerprint256,
  issuer: "C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3",
  lastSeenAt: now,
  monitorId: "m1",
  names: ["example.test", "*.example.test", "192.0.2.1"],
  subject: "CN=example.test",
  validFrom: Date.UTC(2026, 6, 29, 22, 10, 8),
  validTo: Date.UTC(2026, 9, 27, 22, 17, 21),
};

function withUrl(url: string, more: Partial<HttpConfig> = {}) {
  return { config: { ...https, ...more, url } };
}

describe("where a monitor's certificate is read", () => {
  test("an HTTPS monitor with the expiry option on is read at its host and port with the host as the server name", () => {
    expect(certificateTarget(withUrl("https://example.test/health"))).toEqual({
      host: "example.test",
      port: 443,
      serverName: "example.test",
      timeoutMs: certificateReadTimeoutMs,
    });
    expect(
      certificateTarget(withUrl("https://example.test:8443/"))
    ).toMatchObject({ port: 8443 });
  });

  test("an IP literal has no server name, and an IPv6 literal loses its brackets", () => {
    expect(certificateTarget(withUrl("https://192.0.2.1/"))).toMatchObject({
      host: "192.0.2.1",
      serverName: undefined,
    });
    expect(
      certificateTarget(withUrl("https://[2001:db8::1]:8443/"))
    ).toMatchObject({ host: "2001:db8::1", port: 8443, serverName: undefined });
  });

  test("a plain HTTP monitor, one with the option off, and another check type have no target", () => {
    expect(certificateTarget(withUrl("http://example.test/"))).toBeUndefined();
    expect(
      certificateTarget(
        withUrl("https://example.test/", { tlsExpiryDays: undefined })
      )
    ).toBeUndefined();
    expect(
      certificateTarget({
        config: { host: "example.test", port: 443, type: "tcp" },
      })
    ).toBeUndefined();
  });
});

describe("when the reader is due", () => {
  test("a monitor with no record is due", () => {
    expect(certificateReadDue(undefined, now)).toBe(true);
  });

  test("a record last seen 12 hours ago is due; one seen a millisecond later is not", () => {
    expect(
      certificateReadDue({ lastSeenAt: now - certificateReadIntervalMs }, now)
    ).toBe(true);
    expect(
      certificateReadDue(
        { lastSeenAt: now - certificateReadIntervalMs + 1 },
        now
      )
    ).toBe(false);
  });
});

describe("the record a leaf certificate makes", () => {
  test("distinguished names as text in the certificate's order, names without their prefixes, dates as milliseconds, the fingerprint as is", () => {
    expect(certificateRecordOf("m1", peer, now)).toEqual(record);
  });

  test("a multi-valued attribute repeats its key; a certificate without alternative names has none", () => {
    const made = certificateRecordOf(
      "m1",
      {
        ...peer,
        subject: {
          OU: ["Domain Control Validated", "PositiveSSL Wildcard"],
          CN: "*.badssl.com",
        },
        subjectaltname: undefined,
        valid_from: "Apr  9 00:00:00 2015 GMT",
      },
      now
    );
    expect(made.subject).toBe(
      "OU=Domain Control Validated, OU=PositiveSSL Wildcard, CN=*.badssl.com"
    );
    expect(made.names).toEqual([]);
    expect(made.validFrom).toBe(Date.UTC(2015, 3, 9));
  });

  test("an IPv6 alternative name keeps its own colons", () => {
    const made = certificateRecordOf(
      "m1",
      {
        ...peer,
        subjectaltname: "IP Address:2001:DB8:0:0:0:0:0:1, DNS:example.test",
      },
      now
    );
    expect(made.names).toEqual(["2001:DB8:0:0:0:0:0:1", "example.test"]);
  });
});

/** A fake TLS read: the peer to answer, or an error to throw, per call; the targets asked. */
function tlsIo(answers: (PeerCertificate | Error)[], clock = now) {
  const targets: TlsTarget[] = [];
  const io: TlsIo = {
    now: () => clock,
    readTls: (target) => {
      targets.push(target);
      const answer = answers.shift();
      if (!answer) {
        throw new Error("the fake TLS read ran out of answers");
      }
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  return { io, targets };
}

describe("reading one monitor's certificate", () => {
  test("reads at the monitor's target and answers the record", async () => {
    const { io, targets } = tlsIo([peer]);
    expect(
      await readCertificate({ id: "m1", ...withUrl(https.url) }, io)
    ).toEqual(record);
    expect(targets).toEqual([
      {
        host: "example.test",
        port: 443,
        serverName: "example.test",
        timeoutMs: certificateReadTimeoutMs,
      },
    ]);
  });

  test("a monitor without a target is not read", async () => {
    const { io, targets } = tlsIo([peer]);
    expect(
      await readCertificate(
        { id: "m1", ...withUrl("http://example.test/") },
        io
      )
    ).toBeUndefined();
    expect(targets).toEqual([]);
  });

  test("a certificate whose validity dates do not parse is not recorded", async () => {
    const { io } = tlsIo([{ ...peer, valid_to: "someday" }]);
    expect(
      await readCertificate({ id: "m1", ...withUrl(https.url) }, io)
    ).toBeUndefined();
  });

  test("a failed read answers nothing and never throws", async () => {
    const { io } = tlsIo([
      Object.assign(new Error("Failed to connect"), { code: "ECONNREFUSED" }),
    ]);
    expect(
      await readCertificate({ id: "m1", ...withUrl(https.url) }, io)
    ).toBeUndefined();
  });
});

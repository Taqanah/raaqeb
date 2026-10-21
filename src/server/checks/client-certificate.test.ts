import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  caCertificatesReadable,
  certificateDates,
  datesProblem,
  readClientCertificate,
} from "./client-certificate.ts";
import { keyPassphrase, type MutualTls, mutualTls } from "./mtls-fixture.ts";

let certs: MutualTls;
beforeAll(async () => {
  certs = await mutualTls();
});
afterAll(async () => {
  await certs.cleanup();
});

describe("reading a client certificate with its key", () => {
  test("a certificate and the key that belongs to it read, with the dates they are valid between", () => {
    const reading = readClientCertificate(
      certs.client.cert,
      certs.client.key,
      undefined
    );
    expect(reading.ok).toBe(true);
    if (reading.ok) {
      expect(reading.notAfter).toBeGreaterThan(Date.now());
      expect(reading.notBefore).toBeLessThanOrEqual(Date.now());
    }
  });

  test("an encrypted key reads with its passphrase", () => {
    expect(
      readClientCertificate(
        certs.clientEncrypted.cert,
        certs.clientEncrypted.key,
        keyPassphrase
      ).ok
    ).toBe(true);
  });

  test("an encrypted key with no passphrase or the wrong one is a key problem", () => {
    for (const passphrase of [undefined, "not it"]) {
      expect(
        readClientCertificate(
          certs.clientEncrypted.cert,
          certs.clientEncrypted.key,
          passphrase
        )
      ).toEqual({ ok: false, problem: "key" });
    }
  });

  test("text that is not a certificate is a certificate problem, whatever the key", () => {
    expect(
      readClientCertificate("not a certificate", certs.client.key, undefined)
    ).toEqual({ ok: false, problem: "certificate" });
    expect(
      readClientCertificate(certs.client.key, undefined, undefined)
    ).toEqual({ ok: false, problem: "certificate" });
  });

  test("a missing key, or text that is not a key, is a key problem", () => {
    expect(
      readClientCertificate(certs.client.cert, undefined, undefined)
    ).toEqual({ ok: false, problem: "key" });
    expect(
      readClientCertificate(certs.client.cert, "not a key", undefined)
    ).toEqual({ ok: false, problem: "key" });
  });

  test("a key that opens and is another certificate's is a mismatch", () => {
    expect(
      readClientCertificate(certs.client.cert, certs.clientOther.key, undefined)
    ).toEqual({ ok: false, problem: "mismatch" });
  });

  test("a certificate and its intermediate in one PEM read as the first", () => {
    expect(
      readClientCertificate(
        `${certs.client.cert}${certs.ca}`,
        certs.client.key,
        undefined
      ).ok
    ).toBe(true);
  });
});

describe("a certificate's dates", () => {
  test("are read from the first certificate of the PEM, and none from text that is not one", () => {
    const dates = certificateDates(certs.clientExpired.cert);
    expect(dates).toEqual({
      notAfter: Date.UTC(2020, 0, 2),
      notBefore: Date.UTC(2020, 0, 1),
    });
    expect(certificateDates("nope")).toBeUndefined();
  });

  test("put now before, inside or after them: not yet valid, none, expired", () => {
    const dates = { notAfter: 2000, notBefore: 1000 };
    expect(datesProblem(dates, 999)).toBe("not_yet_valid");
    expect(datesProblem(dates, 1000)).toBeUndefined();
    expect(datesProblem(dates, 2000)).toBeUndefined();
    expect(datesProblem(dates, 2001)).toBe("expired");
  });
});

describe("a CA bundle", () => {
  test("of one certificate, or several, is readable", () => {
    expect(caCertificatesReadable(certs.ca)).toBe(true);
    expect(caCertificatesReadable(`${certs.ca}\n${certs.otherCa}`)).toBe(true);
  });

  test("with a block that is not a certificate, or with none, is not", () => {
    expect(caCertificatesReadable("nope")).toBe(false);
    expect(caCertificatesReadable("")).toBe(false);
    expect(caCertificatesReadable(`${certs.ca}\n${certs.client.key}`)).toBe(
      false
    );
    expect(
      caCertificatesReadable(
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
      )
    ).toBe(false);
  });
});

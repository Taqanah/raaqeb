import { describe, expect, test } from "bun:test";
import type { MonitorConfig } from "@/shared/schemas/monitor.ts";
import {
  registrationCandidates,
  registrationExpiring,
  registrationHost,
  registrationWarningDue,
} from "./registrations.ts";

const day = 86_400_000;
const now = 1_700_000_000_000;

const http = (url: string, more: { domainExpiry?: false } = {}) =>
  ({
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url,
    ...more,
  }) satisfies MonitorConfig;

describe("the host a monitor's domain registration is read for", () => {
  test("an HTTP monitor's is its URL's host, in lower case", () => {
    expect(registrationHost(http("https://WWW.Raaqeb.DEV/health"))).toBe(
      "www.raaqeb.dev"
    );
  });

  test("a TCP monitor's is its host, a DNS monitor's its name without the final dot", () => {
    expect(
      registrationHost({ host: "db.raaqeb.dev", port: 5432, type: "tcp" })
    ).toBe("db.raaqeb.dev");
    expect(
      registrationHost({
        name: "_dmarc.Example.com.",
        recordType: "TXT",
        type: "dns",
      })
    ).toBe("_dmarc.example.com");
  });

  test("a monitor with the domain expiry option off has none", () => {
    expect(
      registrationHost(http("https://raaqeb.dev/", { domainExpiry: false }))
    ).toBeUndefined();
    expect(
      registrationHost({
        domainExpiry: false,
        host: "db.raaqeb.dev",
        port: 5432,
        type: "tcp",
      })
    ).toBeUndefined();
  });

  test("an IP address or a name of one label has none, since no registry holds it", () => {
    expect(registrationHost(http("http://192.0.2.10:8080/"))).toBeUndefined();
    expect(registrationHost(http("http://[2001:db8::1]/"))).toBeUndefined();
    expect(
      registrationHost({ host: "2001:db8::1", port: 22, type: "tcp" })
    ).toBeUndefined();
    expect(registrationHost(http("http://localhost:3000/"))).toBeUndefined();
    expect(
      registrationHost({ host: "db", port: 5432, type: "tcp" })
    ).toBeUndefined();
  });

  test("a name under a TLD reserved for special use has none, since no registry holds one", () => {
    for (const host of [
      "api.example.test",
      "nas.local",
      "db.internal",
      "router.home.arpa",
      "x.example",
      "x.invalid",
      "app.localhost",
      "hidden.onion",
      "y.alt",
    ]) {
      expect(registrationHost(http(`http://${host}/`))).toBeUndefined();
    }
  });

  test("a check type that reaches no host by name has none", () => {
    expect(
      registrationHost({ query: "SELECT 1", type: "postgres" })
    ).toBeUndefined();
    expect(
      registrationHost({
        schedule: { everyMs: 60_000, kind: "every" },
        type: "heartbeat",
      })
    ).toBeUndefined();
  });
});

describe("the names a registry is asked for a host", () => {
  test("the host comes first, then each parent down to two labels", () => {
    expect(registrationCandidates("a.b.example.dev")).toEqual([
      "a.b.example.dev",
      "b.example.dev",
      "example.dev",
    ]);
  });

  test("a zone a ccTLD's registry runs for others, such as co.uk or com.mx, is never asked", () => {
    expect(registrationCandidates("a.b.example.co.uk")).toEqual([
      "a.b.example.co.uk",
      "b.example.co.uk",
      "example.co.uk",
    ]);
    for (const zone of [
      "com.mx",
      "com.ly",
      "net.lb",
      "org.bh",
      "gov.qa",
      "ac.ma",
      "edu.eg",
    ]) {
      expect(registrationCandidates(`typo.${zone}`)).toEqual([`typo.${zone}`]);
    }
  });

  test("a two-label name under a generic TLD is asked, whatever its first label", () => {
    expect(registrationCandidates("www.com.dev")).toEqual([
      "www.com.dev",
      "com.dev",
    ]);
  });

  test("a host of two labels is the only name asked", () => {
    expect(registrationCandidates("raaqeb.dev")).toEqual(["raaqeb.dev"]);
  });
});

describe("a registration expiring", () => {
  test("one that expires within 30 days, or already has, is expiring", () => {
    expect(registrationExpiring(now + 30 * day, now)).toBe(true);
    expect(registrationExpiring(now + day, now)).toBe(true);
    expect(registrationExpiring(now - day, now)).toBe(true);
  });

  test("one that expires a millisecond past 30 days is not", () => {
    expect(registrationExpiring(now + 30 * day + 1, now)).toBe(false);
  });
});

describe("the domain expiring warning due", () => {
  test("an expiring registration that has not had its warning is owed it", () => {
    expect(
      registrationWarningDue({ expiresAt: now + 10 * day, warned: false }, now)
    ).toBe(true);
  });

  test("one that had its warning is owed nothing more", () => {
    expect(
      registrationWarningDue({ expiresAt: now + 10 * day, warned: true }, now)
    ).toBe(false);
  });

  test("an unknown expiry date is never owed a warning", () => {
    expect(
      registrationWarningDue({ expiresAt: undefined, warned: false }, now)
    ).toBe(false);
  });

  test("a registration with more than 30 days left is owed nothing yet", () => {
    expect(
      registrationWarningDue({ expiresAt: now + 31 * day, warned: false }, now)
    ).toBe(false);
  });
});

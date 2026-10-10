import { describe, expect, test } from "bun:test";
import { retryDelayMs } from "@/shared/domain/checks.ts";
import type { DnsConfig } from "@/shared/schemas/monitor.ts";
import { observedMaxLength, reasons } from "@/shared/schemas/reason.ts";
import {
  type DnsIo,
  type DnsMonitor,
  type DnsQuery,
  runDnsCheck,
  textOfRecords,
} from "./dns.ts";

const config: DnsConfig = {
  name: "example.test",
  recordType: "A",
  type: "dns",
};

function monitor(
  overrides: Omit<Partial<DnsMonitor>, "config"> & {
    config?: Partial<DnsConfig>;
  } = {}
): DnsMonitor {
  const { config: configOverrides, ...rest } = overrides;
  return {
    config: { ...config, ...configOverrides },
    degradedMs: undefined,
    id: "m1",
    retries: 2,
    timeoutMs: 10_000,
    ...rest,
  };
}

/** One scripted answer of the fake resolver: records after `ms`, or a thrown error after `ms`. */
type Answer =
  | { ms: number; records: string[] }
  | { ms: number; throws: unknown };

function io(answers: Answer[]) {
  let clock = 1_700_000_000_000;
  const sleeps: number[] = [];
  const queries: DnsQuery[] = [];
  const dnsIo: DnsIo = {
    now: () => clock,
    resolve: (query) => {
      queries.push(query);
      const answer = answers.shift();
      if (!answer) {
        throw new Error("the fake resolver ran out of answers");
      }
      clock += answer.ms;
      return "throws" in answer
        ? Promise.reject(answer.throws)
        : Promise.resolve(answer.records);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  return { io: dnsIo, queries, sleeps };
}

function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
const found = (ms: number, ...records: string[]): Answer => ({
  ms,
  records,
});

describe("records as text", () => {
  test("addresses and names are kept as they are", () => {
    expect(textOfRecords("A", ["192.0.2.1", "192.0.2.2"])).toEqual([
      "192.0.2.1",
      "192.0.2.2",
    ]);
    expect(textOfRecords("AAAA", ["2001:db8::1"])).toEqual(["2001:db8::1"]);
    expect(textOfRecords("CNAME", ["www.example.test"])).toEqual([
      "www.example.test",
    ]);
    expect(
      textOfRecords("NS", ["ns1.example.test", "ns2.example.test"])
    ).toEqual(["ns1.example.test", "ns2.example.test"]);
  });

  test("a mail exchange is its exchange name; the priority is not compared", () => {
    expect(
      textOfRecords("MX", [
        { exchange: "mail.example.test", priority: 10 },
        { exchange: "", priority: 0 },
      ])
    ).toEqual(["mail.example.test", ""]);
  });

  test("a TXT record is its chunks joined, one line per record", () => {
    expect(
      textOfRecords("TXT", [
        ["v=spf1 ", "-all"],
        ["_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9"],
      ])
    ).toEqual(["v=spf1 -all", "_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9"]);
  });
});

describe("one DNS check", () => {
  test("a name that resolves is up in one attempt with the query time, no status code and no bytes", async () => {
    const { io: dnsIo, queries, sleeps } = io([found(30, "192.0.2.1")]);
    const outcome = await runDnsCheck(monitor(), dnsIo);
    expect(outcome).toEqual({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: "m1",
        reason: reasons.ok,
        responseMs: 30,
        result: "up",
        startedAt: 1_700_000_000_000,
        statusCode: undefined,
      },
      detail: undefined,
    });
    expect(sleeps).toEqual([]);
    expect(queries).toEqual([
      {
        name: "example.test",
        recordType: "A",
        resolver: undefined,
        timeoutMs: 10_000,
      },
    ]);
  });

  test("the query carries the record type and the custom resolver", async () => {
    const { io: dnsIo, queries } = io([found(30, "mail.example.test")]);
    await runDnsCheck(
      monitor({ config: { recordType: "MX", resolver: "192.0.2.53" } }),
      dnsIo
    );
    expect(queries[0]).toMatchObject({
      recordType: "MX",
      resolver: "192.0.2.53",
    });
  });

  test("an expected value that one of the answers equals is up", async () => {
    const { io: dnsIo } = io([found(30, "192.0.2.1", "192.0.2.2")]);
    const outcome = await runDnsCheck(
      monitor({ config: { expected: "192.0.2.2" } }),
      dnsIo
    );
    expect(outcome.check.result).toBe("up");
  });

  test("the expected value matches without case and without a trailing dot", async () => {
    const { io: dnsIo } = io([
      found(30, "Mail.Example.test"),
      found(30, "mail.example.test"),
    ]);
    const upper = await runDnsCheck(
      monitor({ config: { expected: "mail.example.test", recordType: "MX" } }),
      dnsIo
    );
    expect(upper.check.result).toBe("up");
    const dotted = await runDnsCheck(
      monitor({ config: { expected: "mail.example.test.", recordType: "MX" } }),
      dnsIo
    );
    expect(dotted.check.result).toBe("up");
  });

  test("a TXT answer is compared as written: case and a trailing dot count", async () => {
    const { io: dnsIo } = io([found(30, "v=spf1 -all")]);
    const outcome = await runDnsCheck(
      monitor({
        config: { expected: "V=SPF1 -ALL", recordType: "TXT" },
        retries: 0,
      }),
      dnsIo
    );
    expect(outcome.check.reason).toBe(reasons.dns_mismatch);
  });

  test("the expected text is cut to the failure detail's cap too", async () => {
    const { io: dnsIo } = io([found(30, "192.0.2.1")]);
    const outcome = await runDnsCheck(
      monitor({ config: { expected: "x".repeat(250) }, retries: 0 }),
      dnsIo
    );
    const params = outcome.detail?.params;
    if (params?.reason === "dns_mismatch") {
      expect(params.expected).toHaveLength(observedMaxLength);
    } else {
      throw new Error("expected a mismatch");
    }
  });

  test("an answer without the expected value is retried and ends down as DNS mismatch with the expected and observed text", async () => {
    const { io: dnsIo, sleeps } = io([
      found(30, "192.0.2.2"),
      found(31, "192.0.2.2", "192.0.2.3"),
      found(32, "192.0.2.2", "192.0.2.3"),
    ]);
    const outcome = await runDnsCheck(
      monitor({ config: { expected: "192.0.2.1" } }),
      dnsIo
    );
    expect(outcome.check).toMatchObject({
      attempts: 3,
      reason: reasons.dns_mismatch,
      responseMs: 32,
      result: "down",
    });
    expect(outcome.detail).toEqual({
      assertion: undefined,
      error: undefined,
      monitorId: "m1",
      params: {
        expected: "192.0.2.1",
        observed: "192.0.2.2, 192.0.2.3",
        reason: "dns_mismatch",
      },
      startedAt: 1_700_000_000_000,
    });
    expect(sleeps).toEqual([retryDelayMs, retryDelayMs]);
  });

  test("the observed text is cut to the failure detail's cap", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `192.0.2.${i}`);
    const { io: dnsIo } = io([found(30, ...long)]);
    const outcome = await runDnsCheck(
      monitor({ config: { expected: "192.0.2.100" }, retries: 0 }),
      dnsIo
    );
    const params = outcome.detail?.params;
    expect(params?.reason).toBe("dns_mismatch");
    if (params?.reason === "dns_mismatch") {
      expect(params.observed).toHaveLength(observedMaxLength);
      expect(params.observed.startsWith("192.0.2.0, 192.0.2.1")).toBe(true);
    }
  });

  test("a resolver that answers no record at all is DNS failed with the name", async () => {
    const { io: dnsIo } = io([found(30)]);
    const outcome = await runDnsCheck(monitor({ retries: 0 }), dnsIo);
    expect(outcome.check.reason).toBe(reasons.dns_failed);
    expect(outcome.detail?.params).toEqual({
      host: "example.test",
      reason: "dns_failed",
    });
  });

  test("a name that does not exist is DNS failed with the name and the resolver's text", async () => {
    const { io: dnsIo } = io([
      { ms: 12, throws: coded("ENOTFOUND", "queryA ENOTFOUND example.test") },
    ]);
    const outcome = await runDnsCheck(monitor({ retries: 0 }), dnsIo);
    expect(outcome.check).toMatchObject({
      attempts: 1,
      reason: reasons.dns_failed,
      responseMs: 12,
      result: "down",
    });
    expect(outcome.detail).toMatchObject({
      error: "queryA ENOTFOUND example.test",
      params: { host: "example.test", reason: "dns_failed" },
    });
  });

  test("a resolver that does not answer in time is the reason timeout, capped at the timeout", async () => {
    const { io: dnsIo } = io([
      { ms: 10_200, throws: coded("ETIMEOUT", "queryA ETIMEOUT example.test") },
    ]);
    const outcome = await runDnsCheck(monitor({ retries: 0 }), dnsIo);
    expect(outcome.check).toMatchObject({
      reason: reasons.timeout,
      responseMs: 10_000,
    });
    expect(outcome.detail?.params).toEqual({
      reason: "timeout",
      timeoutMs: 10_000,
    });
  });

  test("a query slower than the degraded threshold is degraded and keeps no detail", async () => {
    const { io: dnsIo } = io([found(700, "192.0.2.1")]);
    const outcome = await runDnsCheck(monitor({ degradedMs: 500 }), dnsIo);
    expect(outcome.check.result).toBe("degraded");
    expect(outcome.detail).toBeUndefined();
  });
});

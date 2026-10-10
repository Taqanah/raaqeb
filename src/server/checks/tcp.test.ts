import { describe, expect, test } from "bun:test";
import { retryDelayMs } from "@/shared/domain/checks.ts";
import type { TcpConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  type ConnectTarget,
  runTcpCheck,
  type TcpIo,
  type TcpMonitor,
} from "./tcp.ts";

const config: TcpConfig = { host: "db.example.test", port: 5432, type: "tcp" };

function monitor(overrides: Partial<TcpMonitor> = {}): TcpMonitor {
  return {
    config,
    degradedMs: undefined,
    id: "m1",
    retries: 2,
    timeoutMs: 10_000,
    ...rest(overrides),
  };
}

function rest(overrides: Partial<TcpMonitor>): Partial<TcpMonitor> {
  return overrides;
}

/** One scripted answer of the fake connect: open after `ms`, or a thrown error after `ms`. */
interface Answer {
  ms: number;
  throws?: unknown;
}

function io(answers: Answer[]) {
  let clock = 1_700_000_000_000;
  const sleeps: number[] = [];
  const targets: ConnectTarget[] = [];
  const tcpIo: TcpIo = {
    connect: (target) => {
      targets.push(target);
      const answer = answers.shift();
      if (!answer) {
        throw new Error("the fake connect ran out of answers");
      }
      clock += answer.ms;
      return "throws" in answer
        ? Promise.reject(answer.throws)
        : Promise.resolve("192.0.2.10");
    },
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  return { io: tcpIo, sleeps, targets };
}

function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
const refused = (ms: number): Answer => ({
  ms,
  throws: coded("ECONNREFUSED", "Failed to connect"),
});
const timedOut = (ms: number): Answer => ({
  ms,
  throws: new DOMException("The operation timed out.", "TimeoutError"),
});

describe("one TCP check", () => {
  test("an accepted connection is up in one attempt with the time to open, no status code and no bytes", async () => {
    const { io: tcpIo, sleeps, targets } = io([{ ms: 80 }]);
    const outcome = await runTcpCheck(monitor(), tcpIo);
    expect(outcome).toEqual({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: "m1",
        reason: reasons.ok,
        responseMs: 80,
        result: "up",
        startedAt: 1_700_000_000_000,
        statusCode: undefined,
      },
      detail: undefined,
    });
    expect(sleeps).toEqual([]);
    expect(targets).toEqual([
      { host: "db.example.test", port: 5432, timeoutMs: 10_000 },
    ]);
  });

  test("a connection slower than the degraded threshold is degraded and keeps no detail", async () => {
    const { io: tcpIo } = io([{ ms: 900 }]);
    const outcome = await runTcpCheck(monitor({ degradedMs: 500 }), tcpIo);
    expect(outcome.check).toMatchObject({
      reason: reasons.ok,
      responseMs: 900,
      result: "degraded",
    });
    expect(outcome.detail).toBeUndefined();
  });

  test("a refused connection is retried with the delay between attempts and ends down with the reason and the detail", async () => {
    const { io: tcpIo, sleeps } = io([refused(5), refused(6), refused(7)]);
    const outcome = await runTcpCheck(monitor(), tcpIo);
    expect(outcome.check).toEqual({
      attempts: 3,
      bytes: 0,
      monitorId: "m1",
      reason: reasons.connection_refused,
      responseMs: 7,
      result: "down",
      startedAt: 1_700_000_000_000,
      statusCode: undefined,
    });
    expect(outcome.detail).toEqual({
      assertion: undefined,
      error: "Failed to connect",
      monitorId: "m1",
      params: {
        host: "db.example.test",
        port: 5432,
        reason: "connection_refused",
      },
      startedAt: 1_700_000_000_000,
    });
    expect(sleeps).toEqual([retryDelayMs, retryDelayMs]);
  });

  test("a connection not open by the timeout is the reason timeout, with the time capped at the timeout", async () => {
    const { io: tcpIo } = io([timedOut(10_400)]);
    const outcome = await runTcpCheck(monitor({ retries: 0 }), tcpIo);
    expect(outcome.check).toMatchObject({
      reason: reasons.timeout,
      responseMs: 10_000,
      result: "down",
    });
    expect(outcome.detail?.params).toEqual({
      reason: "timeout",
      timeoutMs: 10_000,
    });
  });
});

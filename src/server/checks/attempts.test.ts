import { describe, expect, test } from "bun:test";
import { retryDelayMs } from "@/shared/domain/checks.ts";
import type { CaptureMode, Monitor } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { type Attempt, type AttemptIo, runAttempts } from "./attempts.ts";

const t0 = 1_700_000_000_000;

function monitor(
  overrides: Partial<Pick<Monitor, "retries" | "degradedMs">> = {}
): Pick<Monitor, "id" | "retries" | "degradedMs"> {
  return { degradedMs: undefined, id: "m1", retries: 2, ...overrides };
}

/** One scripted attempt: what it answers, after `ms` on the clock. */
interface Scripted {
  readonly attempt: Attempt;
  readonly ms: number;
}

/** A clock the attempts advance, a sleep that records its pauses, and the attempts made. */
function run(
  scripted: Scripted[],
  target = monitor(),
  captureMode?: CaptureMode
) {
  let clock = t0;
  let made = 0;
  const sleeps: number[] = [];
  const io: AttemptIo = {
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  const attemptOnce = () => {
    const next = scripted[made];
    made += 1;
    if (!next) {
      throw new Error("the attempts ran out of script");
    }
    clock += next.ms;
    return Promise.resolve(next.attempt);
  };
  const outcome = runAttempts(target, io, attemptOnce, captureMode);
  return { made: () => made, outcome, sleeps };
}

const succeeded = (responseMs: number, extra: Partial<Attempt> = {}) => ({
  attempt: {
    params: { reason: "ok" },
    reason: "ok",
    responseMs,
    succeeded: true,
    ...extra,
  } satisfies Attempt,
  ms: responseMs,
});

const refused = (responseMs: number, extra: Partial<Attempt> = {}) => ({
  attempt: {
    error: "Failed to connect",
    params: { host: "example.test", port: 443, reason: "connection_refused" },
    reason: "connection_refused",
    responseMs,
    succeeded: false,
    ...extra,
  } satisfies Attempt,
  ms: responseMs,
});

const unexpected = (responseMs: number, observed: number) => ({
  attempt: {
    assertion: { codes: ["2xx"], kind: "status" },
    bytes: 12,
    params: { expected: ["2xx"], observed, reason: "unexpected_status" },
    reason: "unexpected_status",
    response: {
      body: new TextEncoder().encode(`status ${observed}`),
      headers: new Headers({ "content-type": "text/plain" }),
    },
    responseMs,
    statusCode: observed,
    succeeded: false,
  } satisfies Attempt,
  ms: responseMs,
});

const withResponse = (responseMs: number, body: string) =>
  succeeded(responseMs, {
    bytes: body.length,
    response: {
      body: new TextEncoder().encode(body),
      headers: new Headers({ "content-type": "text/plain" }),
    },
    statusCode: 200,
  });

describe("one check through its attempts", () => {
  test("a first attempt that succeeds is an up check of one attempt, with no pause, no failure detail and no capture", async () => {
    const { outcome, sleeps } = run([succeeded(80)]);
    expect(await outcome).toEqual({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: "m1",
        reason: reasons.ok,
        responseMs: 80,
        result: "up",
        startedAt: t0,
        statusCode: undefined,
      },
      detail: undefined,
    });
    expect(sleeps).toEqual([]);
  });

  test("a failed attempt is retried after the pause until one succeeds, and the check counts every attempt", async () => {
    // A retry is left after the success, so a loop that does not stop at it makes a fourth attempt.
    const { made, outcome, sleeps } = run(
      [refused(5), refused(6), succeeded(90), refused(7)],
      monitor({ retries: 3 })
    );
    const { check, detail } = await outcome;
    expect(check).toMatchObject({
      attempts: 3,
      reason: reasons.ok,
      responseMs: 90,
      result: "up",
    });
    expect(detail).toBeUndefined();
    expect(sleeps).toEqual([retryDelayMs, retryDelayMs]);
    expect(made()).toBe(3);
  });

  test("once the retries are spent the check is down with the last attempt's reason, response time and failure detail", async () => {
    const { made, outcome, sleeps } = run(
      [unexpected(40, 503), unexpected(70, 502), succeeded(10)],
      monitor({ retries: 1 })
    );
    const { check, detail } = await outcome;
    expect(check).toEqual({
      attempts: 2,
      bytes: 12,
      monitorId: "m1",
      reason: reasons.unexpected_status,
      responseMs: 70,
      result: "down",
      startedAt: t0,
      statusCode: 502,
    });
    expect(detail).toEqual({
      assertion: { codes: ["2xx"], kind: "status" },
      error: undefined,
      monitorId: "m1",
      params: { expected: ["2xx"], observed: 502, reason: "unexpected_status" },
      startedAt: t0,
    });
    expect(sleeps).toEqual([retryDelayMs]);
    expect(made()).toBe(2);
  });

  test("a monitor without retries makes one attempt and never pauses", async () => {
    const { made, outcome, sleeps } = run(
      [refused(5), succeeded(10)],
      monitor({ retries: 0 })
    );
    const { check, detail } = await outcome;
    expect(check).toMatchObject({ attempts: 1, result: "down" });
    expect(detail).toEqual({
      assertion: undefined,
      error: "Failed to connect",
      monitorId: "m1",
      params: { host: "example.test", port: 443, reason: "connection_refused" },
      startedAt: t0,
    });
    expect(sleeps).toEqual([]);
    expect(made()).toBe(1);
  });

  test("a check starts when its first attempt does, whatever the retries take", async () => {
    const { outcome } = run([refused(3000), refused(3000), refused(3000)]);
    const { check, detail } = await outcome;
    expect(check.startedAt).toBe(t0);
    expect(detail?.startedAt).toBe(t0);
  });

  test("the check keeps the bytes and status code of the attempt that ended it", async () => {
    const { outcome } = run([unexpected(40, 503), withResponse(60, "hello")]);
    const { check } = await outcome;
    expect(check).toMatchObject({ bytes: 5, result: "up", statusCode: 200 });
  });
});

describe("the degraded threshold", () => {
  test("a success over the threshold is degraded and keeps no failure detail", async () => {
    const { outcome } = run([succeeded(900)], monitor({ degradedMs: 500 }));
    const { check, detail } = await outcome;
    expect(check).toMatchObject({ reason: reasons.ok, result: "degraded" });
    expect(detail).toBeUndefined();
  });

  test("a success at the threshold is up, not degraded", async () => {
    const { outcome } = run([succeeded(500)], monitor({ degradedMs: 500 }));
    expect((await outcome).check.result).toBe("up");
  });

  test("a monitor without a threshold is never degraded", async () => {
    const { outcome } = run([succeeded(59_000)]);
    expect((await outcome).check.result).toBe("up");
  });

  test("a failed attempt faster than the threshold is still down", async () => {
    const { outcome } = run(
      [refused(5)],
      monitor({ degradedMs: 500, retries: 0 })
    );
    expect((await outcome).check.result).toBe("down");
  });

  test("the threshold judges the attempt that ended the check, not the slowest one", async () => {
    const { outcome } = run(
      [refused(2000), succeeded(100)],
      monitor({ degradedMs: 500 })
    );
    expect((await outcome).check).toMatchObject({
      responseMs: 100,
      result: "up",
    });
  });
});

describe("the capture", () => {
  const capturedBody = (text: string) => new TextEncoder().encode(text);

  test("on failure, a down check keeps a capture of its last response", async () => {
    const { outcome } = run(
      [unexpected(40, 503), unexpected(70, 502)],
      monitor({ retries: 1 }),
      "on_failure"
    );
    expect((await outcome).capture).toEqual({
      body: capturedBody("status 502"),
      headers: [{ name: "content-type", value: "text/plain" }],
      monitorId: "m1",
      startedAt: t0,
    });
  });

  test("on failure, an up or degraded check keeps no capture", async () => {
    const up = run([withResponse(60, "fine")], monitor(), "on_failure");
    const degraded = run(
      [withResponse(900, "slow")],
      monitor({ degradedMs: 500 }),
      "on_failure"
    );
    expect((await up.outcome).capture).toBeUndefined();
    expect((await degraded.outcome).check.result).toBe("degraded");
    expect((await degraded.outcome).capture).toBeUndefined();
  });

  test("always keeps a capture of an up check's response", async () => {
    const { outcome } = run([withResponse(60, "fine")], monitor(), "always");
    expect((await outcome).capture).toEqual({
      body: capturedBody("fine"),
      headers: [{ name: "content-type", value: "text/plain" }],
      monitorId: "m1",
      startedAt: t0,
    });
  });

  test("always keeps a capture of a degraded check's response, which on failure would not", async () => {
    const { outcome } = run(
      [withResponse(900, "slow")],
      monitor({ degradedMs: 500 }),
      "always"
    );
    const { capture, check } = await outcome;
    expect(check.result).toBe("degraded");
    expect(capture?.body).toEqual(capturedBody("slow"));
  });

  test("off keeps no capture, and a check type without a capture mode keeps none", async () => {
    const off = run([unexpected(40, 503)], monitor({ retries: 0 }), "off");
    const none = run([unexpected(40, 503)], monitor({ retries: 0 }));
    expect((await off.outcome).capture).toBeUndefined();
    expect((await none.outcome).capture).toBeUndefined();
  });

  test("a check whose last attempt had no response keeps no capture, even always", async () => {
    const { outcome } = run(
      [unexpected(40, 503), refused(5)],
      monitor({ retries: 1 }),
      "always"
    );
    expect((await outcome).capture).toBeUndefined();
  });
});

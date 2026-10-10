import { describe, expect, test } from "bun:test";
import { retryDelayMs } from "@/shared/domain/checks.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  answerText,
  type DatabaseIo,
  type DatabaseMonitor,
  type DatabaseQuery,
  runDatabaseCheck,
} from "./database.ts";

const url = "postgres://watcher:s3cr%2Ft@db.example.test:6543/app";

function monitor(overrides: Partial<DatabaseMonitor> = {}): DatabaseMonitor {
  return {
    config: { type: "postgres" },
    credentials: { headers: [], url },
    degradedMs: undefined,
    id: "m1",
    retries: 2,
    timeoutMs: 10_000,
    ...overrides,
  };
}

/** One scripted answer of the fake driver: a value after `ms`, or a thrown error after `ms`. */
interface Answer {
  ms: number;
  throws?: unknown;
  value?: unknown;
}

function io(answers: Answer[]) {
  let clock = 1_700_000_000_000;
  const sleeps: number[] = [];
  const queries: DatabaseQuery[] = [];
  const databaseIo: DatabaseIo = {
    now: () => clock,
    queryDatabase: (query) => {
      queries.push(query);
      const answer = answers.shift();
      if (!answer) {
        throw new Error("the fake driver ran out of answers");
      }
      clock += answer.ms;
      return "throws" in answer
        ? Promise.reject(answer.throws)
        : Promise.resolve(answer.value);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  return { io: databaseIo, queries, sleeps };
}

function coded(code: string, message: string, errno?: string | number): Error {
  return Object.assign(new Error(message), { code, errno });
}

describe("one database check", () => {
  test("a Postgres monitor without a query signs in with its connection URL, runs SELECT 1 and is up with the time to the answer", async () => {
    const { io: databaseIo, queries, sleeps } = io([{ ms: 42, value: 1 }]);
    const outcome = await runDatabaseCheck(monitor(), databaseIo);
    expect(outcome).toEqual({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: "m1",
        reason: reasons.ok,
        responseMs: 42,
        result: "up",
        startedAt: 1_700_000_000_000,
        statusCode: undefined,
      },
      detail: undefined,
    });
    expect(queries).toEqual([
      { query: "SELECT 1", timeoutMs: 10_000, type: "postgres", url },
    ]);
    expect(sleeps).toEqual([]);
  });

  test("a MySQL monitor runs SELECT 1 and a Redis monitor sends PING", async () => {
    const mysql = io([{ ms: 3, value: 1 }]);
    await runDatabaseCheck(
      monitor({
        config: { type: "mysql" },
        credentials: { headers: [], url: "mysql://u:p@db.example.test/app" },
      }),
      mysql.io
    );
    expect(mysql.queries[0]?.query).toBe("SELECT 1");
    const redis = io([{ ms: 1, value: "PONG" }]);
    await runDatabaseCheck(
      monitor({
        config: { type: "redis" },
        credentials: { headers: [], url: "redis://:p@cache.example.test" },
      }),
      redis.io
    );
    expect(redis.queries[0]).toMatchObject({ query: "PING", type: "redis" });
  });

  test("the monitor's own query runs as it was written", async () => {
    const { io: databaseIo, queries } = io([{ ms: 5, value: 12 }]);
    await runDatabaseCheck(
      monitor({
        config: { query: "SELECT count(*) FROM jobs", type: "postgres" },
      }),
      databaseIo
    );
    expect(queries[0]?.query).toBe("SELECT count(*) FROM jobs");
  });

  test("an answer equal to the expected value as text is up", async () => {
    const { io: databaseIo } = io([{ ms: 5, value: 12n }]);
    const outcome = await runDatabaseCheck(
      monitor({
        config: {
          expected: "12",
          query: "SELECT count(*) FROM jobs",
          type: "postgres",
        },
      }),
      databaseIo
    );
    expect(outcome.check.result).toBe("up");
  });

  test("an answer other than the expected value fails like an assertion, with what was expected and what came back", async () => {
    const { io: databaseIo } = io([{ ms: 5, value: "degraded" }]);
    const outcome = await runDatabaseCheck(
      monitor({
        config: { expected: "ok", query: "GET health", type: "redis" },
        credentials: { headers: [], url: "redis://cache.example.test" },
        retries: 0,
      }),
      databaseIo
    );
    expect(outcome.check).toMatchObject({
      reason: reasons.assertion_failed,
      result: "down",
    });
    expect(outcome.detail).toMatchObject({
      assertion: undefined,
      params: {
        expected: "ok",
        observed: "degraded",
        reason: "assertion_failed",
      },
    });
  });

  test("an answer that only begins with the expected value is another value", async () => {
    const { io: databaseIo } = io([{ ms: 5, value: 12 }]);
    const outcome = await runDatabaseCheck(
      monitor({ config: { expected: "1", type: "postgres" }, retries: 0 }),
      databaseIo
    );
    expect(outcome.check.reason).toBe(reasons.assertion_failed);
  });

  test("an answer that repeats the URL's password is masked in the failure detail", async () => {
    const { io: databaseIo } = io([{ ms: 5, value: "requirepass s3cr/t" }]);
    const outcome = await runDatabaseCheck(
      monitor({ config: { expected: "ok", type: "postgres" }, retries: 0 }),
      databaseIo
    );
    const params = outcome.detail?.params;
    expect(params?.reason === "assertion_failed" && params.observed).toBe(
      "requirepass [REDACTED]"
    );
  });

  test("an observed value is cut to 200 characters", async () => {
    const { io: databaseIo } = io([{ ms: 5, value: "x".repeat(500) }]);
    const outcome = await runDatabaseCheck(
      monitor({ config: { expected: "y", type: "postgres" }, retries: 0 }),
      databaseIo
    );
    const params = outcome.detail?.params;
    expect(params?.reason === "assertion_failed" && params.observed).toBe(
      "x".repeat(200)
    );
  });

  test("an answer slower than the degraded threshold is degraded", async () => {
    const { io: databaseIo } = io([{ ms: 900, value: 1 }]);
    const outcome = await runDatabaseCheck(
      monitor({ degradedMs: 500 }),
      databaseIo
    );
    expect(outcome.check).toMatchObject({
      responseMs: 900,
      result: "degraded",
    });
  });

  test("a failed attempt is retried after the pause and a later success is up", async () => {
    const { io: databaseIo, sleeps } = io([
      {
        ms: 5,
        throws: coded("ERR_POSTGRES_CONNECTION_CLOSED", "Connection closed"),
      },
      { ms: 7, value: 1 },
    ]);
    const outcome = await runDatabaseCheck(monitor(), databaseIo);
    expect(outcome.check).toMatchObject({
      attempts: 2,
      responseMs: 7,
      result: "up",
    });
    expect(sleeps).toEqual([retryDelayMs]);
  });

  test("a refused connection names the URL's host and port", async () => {
    const { io: databaseIo } = io([
      {
        ms: 2,
        throws: coded("ERR_POSTGRES_CONNECTION_REFUSED", "Failed to connect"),
      },
    ]);
    const outcome = await runDatabaseCheck(monitor({ retries: 0 }), databaseIo);
    expect(outcome.check.reason).toBe(reasons.connection_refused);
    expect(outcome.detail?.params).toEqual({
      host: "db.example.test",
      port: 6543,
      reason: "connection_refused",
    });
  });

  test("a URL without a port names the check type's own", async () => {
    const { io: databaseIo } = io([
      {
        ms: 2,
        throws: coded("ERR_MYSQL_CONNECTION_REFUSED", "Failed to connect"),
      },
    ]);
    const outcome = await runDatabaseCheck(
      monitor({
        config: { type: "mysql" },
        credentials: { headers: [], url: "mysql://u:p@db.example.test/app" },
        retries: 0,
      }),
      databaseIo
    );
    expect(outcome.detail?.params).toEqual({
      host: "db.example.test",
      port: 3306,
      reason: "connection_refused",
    });
  });

  test("the failure detail never holds the connection URL or its password", async () => {
    const { io: databaseIo } = io([
      {
        ms: 3,
        throws: coded(
          "ERR_POSTGRES_CONNECTION_FAILED",
          `could not reach ${url} with s3cr/t`
        ),
      },
    ]);
    const outcome = await runDatabaseCheck(monitor({ retries: 0 }), databaseIo);
    const error = outcome.detail?.error ?? "";
    expect(error).not.toContain(url);
    expect(error).not.toContain("s3cr");
    expect(error).toContain("could not reach");
  });

  test("an attempt past the timeout is a timeout naming the monitor's timeout", async () => {
    const { io: databaseIo } = io([
      {
        ms: 10_000,
        throws: new DOMException("The operation timed out.", "TimeoutError"),
      },
    ]);
    const outcome = await runDatabaseCheck(monitor({ retries: 0 }), databaseIo);
    expect(outcome.check).toMatchObject({
      reason: reasons.timeout,
      responseMs: 10_000,
    });
    expect(outcome.detail?.params).toEqual({
      reason: "timeout",
      timeoutMs: 10_000,
    });
  });

  test("a monitor whose connection URL could not be opened is down without reaching the server", async () => {
    const { io: databaseIo, queries } = io([]);
    const outcome = await runDatabaseCheck(
      monitor({ credentials: undefined, retries: 0 }),
      databaseIo
    );
    expect(outcome.check).toMatchObject({
      reason: reasons.unknown,
      result: "down",
    });
    expect(outcome.detail?.error).toBeTruthy();
    expect(queries).toEqual([]);
  });
});

describe("an answered value as text", () => {
  test("is a string as it is, a number or a boolean as written, a big integer in full", () => {
    expect(answerText("ok")).toBe("ok");
    expect(answerText(1)).toBe("1");
    expect(answerText(1.5)).toBe("1.5");
    expect(answerText(true)).toBe("true");
    expect(answerText(9_007_199_254_740_993n)).toBe("9007199254740993");
  });

  test("is a date in ISO 8601 and bytes as UTF-8", () => {
    expect(answerText(new Date("2026-10-04T08:16:49.755Z"))).toBe(
      "2026-10-04T08:16:49.755Z"
    );
    expect(answerText(new TextEncoder().encode("راقب"))).toBe("راقب");
  });

  test("is null as null, no row as nothing, and anything else as JSON", () => {
    expect(answerText(null)).toBe("null");
    expect(answerText(undefined)).toBe("");
    expect(answerText({ a: 1 })).toBe('{"a":1}');
    expect(answerText([1, 2])).toBe("[1,2]");
    expect(answerText({ big: 2n })).toBe('{"big":"2"}');
  });
});

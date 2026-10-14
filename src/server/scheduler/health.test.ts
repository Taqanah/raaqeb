import { describe, expect, test } from "bun:test";
import {
  type PostgresPool,
  postgresExecutor,
} from "@/server/storage/connection.ts";
import { readChangeCounter } from "@/server/storage/counter.ts";
import {
  exitAfterMs,
  healthCommand,
  healthReport,
  healthResponse,
  healthUrl,
  staleAfterMs,
  tickVerdict,
} from "./health.ts";

const t0 = 1_700_000_000_000;

describe("judging the last tick", () => {
  test("a tick within the stale bound is ok", () => {
    expect(tickVerdict(t0, t0)).toBe("ok");
    expect(tickVerdict(t0, t0 + staleAfterMs - 1)).toBe("ok");
  });

  test("a tick at or past the stale bound is stale, so /health answers 503 first", () => {
    expect(tickVerdict(t0, t0 + staleAfterMs)).toBe("stale");
    expect(tickVerdict(t0, t0 + exitAfterMs - 1)).toBe("stale");
  });

  test("a tick five minutes old is dead, so the process exits for the supervisor", () => {
    expect(tickVerdict(t0, t0 + exitAfterMs)).toBe("dead");
  });

  test("no tick at all is stale", () => {
    expect(tickVerdict(undefined, t0)).toBe("stale");
  });

  test("the stale bound is below the exit bound", () => {
    expect(staleAfterMs).toBeLessThan(exitAfterMs);
  });
});

const answering = { changeCounter: () => Promise.resolve(3) };
const failing = {
  changeCounter: () => Promise.reject(new Error("database gone")),
};
const fresh = { lastTickAt: () => t0 };

describe("the health report", () => {
  test("during onboarding the process is healthy and says so: nothing to tick yet", async () => {
    expect(await healthReport(undefined, undefined, t0)).toEqual({
      ok: true,
      onboarding: true,
    });
  });

  test("with the database answering and a fresh tick, ok", async () => {
    expect(await healthReport(answering, fresh, t0 + 1000)).toEqual({
      database: "ok",
      ok: true,
      scheduler: "ok",
    });
  });

  test("a database that does not answer makes the report not ok, naming the database", async () => {
    expect(await healthReport(failing, fresh, t0 + 1000)).toEqual({
      database: "unreachable",
      ok: false,
      scheduler: "ok",
    });
  });

  test("a database that never answers makes the report not ok within the limit, rather than hanging", async () => {
    const silent = () => new Promise<Iterable<never>>(() => undefined);
    const pool: PostgresPool = {
      execute: silent,
      transaction: (work) => work({ execute: silent }),
    };
    const run = postgresExecutor(pool, pool, 30);
    const started = performance.now();
    expect(
      await healthReport(
        { changeCounter: () => readChangeCounter(run) },
        fresh,
        t0 + 1000
      )
    ).toEqual({ database: "unreachable", ok: false, scheduler: "ok" });
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a stale tick makes the report not ok, naming the scheduler", async () => {
    expect(await healthReport(answering, fresh, t0 + staleAfterMs + 1)).toEqual(
      { database: "ok", ok: false, scheduler: "stale" }
    );
  });

  test("a database with no scheduler beside it reads as stale", async () => {
    expect(await healthReport(answering, undefined, t0)).toEqual({
      database: "ok",
      ok: false,
      scheduler: "stale",
    });
  });
});

describe("the health response", () => {
  test("an ok report is 200 with the report as JSON, never cached", async () => {
    const response = healthResponse({
      database: "ok",
      ok: true,
      scheduler: "ok",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      database: "ok",
      ok: true,
      scheduler: "ok",
    });
  });

  test("a report that is not ok is 503 with the same body shape", async () => {
    const response = healthResponse({
      database: "ok",
      ok: false,
      scheduler: "stale",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      database: "ok",
      ok: false,
      scheduler: "stale",
    });
  });

  test("the onboarding report is 200", () => {
    expect(healthResponse({ ok: true, onboarding: true }).status).toBe(200);
  });
});

describe("where raaqeb health calls", () => {
  test("the bind address and port of the boot settings", () => {
    expect(healthUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000/health");
    expect(healthUrl("localhost", 8080)).toBe("http://localhost:8080/health");
  });

  test("an unspecified bind address is reached on the loopback address of its family", () => {
    expect(healthUrl("0.0.0.0", 3000)).toBe("http://127.0.0.1:3000/health");
    expect(healthUrl("::", 3000)).toBe("http://[::1]:3000/health");
  });

  test("an IPv6 literal is bracketed", () => {
    expect(healthUrl("::1", 3000)).toBe("http://[::1]:3000/health");
    expect(healthUrl("[::1]", 3000)).toBe("http://[::1]:3000/health");
  });
});

describe("the health command", () => {
  const url = "http://127.0.0.1:3000/health";
  const answersWith = (status: number): typeof fetch =>
    ((input: string | URL | Request) => {
      expect(String(input)).toBe(url);
      return Promise.resolve(new Response("{}", { status }));
    }) as typeof fetch;

  test("exits 0 on a 200", async () => {
    expect(await healthCommand(url, answersWith(200))).toBe(0);
  });

  test("exits 1 on a 503", async () => {
    expect(await healthCommand(url, answersWith(503))).toBe(1);
  });

  test("exits 1 when nothing answers", async () => {
    const refusing = ((input: string | URL | Request) =>
      Promise.reject(
        new Error(`ECONNREFUSED ${String(input)}`)
      )) as typeof fetch;
    expect(await healthCommand(url, refusing)).toBe(1);
  });
});

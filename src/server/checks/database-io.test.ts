/**
 * The database check's live adapter: over fake drivers in every run, over a
 * port that refuses or a server that never answers in every run, and over
 * the compose Postgres, MySQL and Redis under `bun run test:postgres`, which
 * sets their URLs and fails when one does not listen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type {
  DatabaseCheckType,
  DatabaseConfig,
} from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { type DatabaseQuery, runDatabaseCheck } from "./database.ts";
import {
  type DatabaseDrivers,
  firstValue,
  liveDrivers,
  queryOnce,
  type RedisOptions,
  type SqlOptions,
} from "./database-io.ts";
import { liveIo } from "./io.ts";

/** Fake drivers that record how they were opened and closed and answer what the test scripts. */
function drivers(answer: () => Promise<unknown>) {
  const opened: (SqlOptions | [string, RedisOptions])[] = [];
  const sent: [string, string[]][] = [];
  const queries: string[] = [];
  let closed = 0;
  const fake: DatabaseDrivers = {
    redis: (url, options) => {
      opened.push([url, options]);
      return {
        close: () => {
          closed += 1;
        },
        send: (command, args) => {
          sent.push([command, args]);
          return answer();
        },
      };
    },
    sql: (options) => {
      opened.push(options);
      return {
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
        unsafe: (query) => {
          queries.push(query);
          return answer();
        },
      };
    },
  };
  return { closed: () => closed, fake, opened, queries, sent };
}

const postgres: DatabaseQuery = {
  query: "SELECT 1",
  timeoutMs: 2500,
  type: "postgres",
  url: "postgres://watcher:pw@db.example.test/app",
};

describe("one query over the drivers", () => {
  test("a Postgres query opens one connection with the URL, the timeout in whole seconds and no named statements, and answers the first value", async () => {
    const { closed, fake, opened, queries } = drivers(() =>
      Promise.resolve([{ a: "first", b: "second" }])
    );
    expect(await queryOnce(postgres, fake)).toBe("first");
    expect(opened).toMatchObject([
      {
        connectionTimeout: 3,
        idleTimeout: 0,
        max: 1,
        maxLifetime: 0,
        prepare: false,
        url: postgres.url,
      },
    ]);
    expect(queries).toEqual([
      "SELECT * FROM (\nSELECT 1\n) AS raaqeb_check LIMIT 1",
    ]);
    expect(closed()).toBe(1);
  });

  test("the password is the URL's own, decoded, and none when the URL has none: never one Bun would read from the environment", async () => {
    const { fake, opened } = drivers(() => Promise.resolve([]));
    await queryOnce(
      { ...postgres, url: "postgres://watcher:s3cr%2Ft@db.example.test/app" },
      fake
    );
    await queryOnce(
      {
        ...postgres,
        type: "mysql",
        url: "mysql://watcher@db.example.test/app",
      },
      fake
    );
    const passwords = opened.map((options) =>
      Array.isArray(options) ? undefined : options.password()
    );
    expect(passwords).toEqual(["s3cr/t", ""]);
  });

  test("a Postgres SELECT or WITH query is asked for its first row alone, its trailing semicolon dropped, and any other statement or one holding a semicolon as it came", async () => {
    const { fake, queries } = drivers(() => Promise.resolve([]));
    for (const query of [
      "select name from items;",
      "  WITH a AS (SELECT 1) SELECT * FROM a ; ",
      "SHOW server_version",
      "SELECT 1; -- a note after the statement",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one query after another
      await queryOnce({ ...postgres, query }, fake);
    }
    expect(queries).toEqual([
      "SELECT * FROM (\nselect name from items\n) AS raaqeb_check LIMIT 1",
      "SELECT * FROM (\nWITH a AS (SELECT 1) SELECT * FROM a\n) AS raaqeb_check LIMIT 1",
      "SHOW server_version",
      // A semicolon inside could close the wrapper's parenthesis early: asked as it came.
      "SELECT 1; -- a note after the statement",
    ]);
  });

  test("a MySQL connection limits every SELECT to one row before it asks the query as it came", async () => {
    const { fake, queries } = drivers(() => Promise.resolve([{ one: 1 }]));
    const answer = await queryOnce(
      {
        ...postgres,
        query: "SELECT a.id, b.id FROM a JOIN b",
        type: "mysql",
        url: "mysql://u:p@db.example.test/app",
      },
      fake
    );
    expect(queries).toEqual([
      "SET SESSION sql_select_limit = 1",
      "SELECT a.id, b.id FROM a JOIN b",
    ]);
    expect(answer).toBe(1);
  });

  test("a MySQL query does not name the prepare option, which Bun's MySQL driver refuses", async () => {
    const { fake, opened } = drivers(() => Promise.resolve([{ one: 1 }]));
    await queryOnce(
      { ...postgres, type: "mysql", url: "mysql://u:p@db.example.test/app" },
      fake
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toHaveProperty("prepare");
  });

  test("a Redis command is split on spaces into the command and its arguments, and the reply is the answer", async () => {
    const { closed, fake, opened, sent } = drivers(() => Promise.resolve("ok"));
    const answer = await queryOnce(
      {
        query: "  GET   health:flag ",
        timeoutMs: 4000,
        type: "redis",
        url: "redis://:pw@cache.example.test",
      },
      fake
    );
    expect(answer).toBe("ok");
    expect(sent).toEqual([["GET", ["health:flag"]]]);
    expect(opened).toEqual([
      [
        "redis://:pw@cache.example.test",
        {
          autoReconnect: false,
          connectionTimeout: 4000,
          enableAutoPipelining: false,
        },
      ],
    ]);
    expect(closed()).toBe(1);
  });

  test("a driver error rejects as it came, and the connection is closed", async () => {
    const error = Object.assign(new Error("denied"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
    });
    const { closed, fake } = drivers(() => Promise.reject(error));
    await expect(queryOnce(postgres, fake)).rejects.toBe(error);
    expect(closed()).toBe(1);
  });

  test("a query past the timeout rejects as a timeout and closes the connection", async () => {
    const { closed, fake } = drivers(() => new Promise(() => undefined));
    const started = performance.now();
    const failure = await queryOnce({ ...postgres, timeoutMs: 50 }, fake).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure instanceof DOMException && failure.name).toBe(
      "TimeoutError"
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(closed()).toBe(1);
  });
});

describe("the first value of a SQL answer", () => {
  test("is the first column of the first row", () => {
    expect(firstValue([{ n: 3, m: 4 }, { n: 5 }])).toBe(3);
  });

  test("is nothing when no row came back", () => {
    expect(firstValue([])).toBeUndefined();
    expect(firstValue([{}])).toBeUndefined();
  });
});

/** A port nothing listens on: bound once, then released. */
function freePort(): number {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

describe("one query over Bun's drivers, with no server", () => {
  const types: DatabaseCheckType[] = ["postgres", "mysql", "redis"];
  const schemes = { mysql: "mysql", postgres: "postgres", redis: "redis" };
  let silent:
    | { readonly port: number; stop: (force: boolean) => void }
    | undefined;

  beforeAll(() => {
    // Accepts and never answers: no greeting, no sign-in, no reply.
    silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
  });
  afterAll(() => {
    silent?.stop(true);
  });

  test("a port that refuses rejects as refused, but for Redis, which Bun reports as closed", async () => {
    const port = freePort();
    const codes = {
      mysql: "ERR_MYSQL_CONNECTION_REFUSED",
      postgres: "ERR_POSTGRES_CONNECTION_REFUSED",
      redis: "ERR_REDIS_CONNECTION_CLOSED",
    };
    for (const type of types) {
      // biome-ignore lint/performance/noAwaitInLoops: one driver at a time keeps the port's refusal clear
      const failure = await queryOnce(
        {
          query: "SELECT 1",
          timeoutMs: 2000,
          type,
          url: `${schemes[type]}://u:p@127.0.0.1:${port}${type === "redis" ? "" : "/app"}`,
        },
        liveDrivers
      ).catch((error: unknown) => error);
      expect(failure).toHaveProperty("code", codes[type]);
    }
  });

  test("a server that never answers is a timeout at the monitor's timeout", async () => {
    // The three drivers wait side by side; each timer still starts with its own query.
    const waits = await Promise.all(
      types.map(async (type) => {
        const started = performance.now();
        const failure = await queryOnce(
          {
            query: type === "redis" ? "PING" : "SELECT 1",
            timeoutMs: 300,
            type,
            url: `${schemes[type]}://u:p@127.0.0.1:${silent?.port}${type === "redis" ? "" : "/app"}`,
          },
          liveDrivers
        ).catch((error: unknown) => error);
        return {
          ms: performance.now() - started,
          name: failure instanceof DOMException && failure.name,
        };
      })
    );
    for (const { ms, name } of waits) {
      expect(name).toBe("TimeoutError");
      expect(ms).toBeLessThan(1500);
    }
  });
});

/** The compose servers, which `bun run test:postgres` names; the Postgres one is the run's own database, read and never written. */
const servers: Record<DatabaseCheckType, string | undefined> = {
  mysql: process.env.RAAQEB_TEST_MYSQL_URL,
  postgres: process.env.RAAQEB_TEST_DATABASE_URL,
  redis: process.env.RAAQEB_TEST_REDIS_URL,
};

function check(
  type: DatabaseCheckType,
  url: string,
  config: Omit<DatabaseConfig, "type"> = {}
): Promise<CheckOutcome> {
  return runDatabaseCheck(
    {
      config: { ...config, type },
      credentials: { headers: [], url },
      degradedMs: undefined,
      id: "live",
      retries: 0,
      timeoutMs: 5000,
    },
    liveIo()
  );
}

/** The same URL with another password. */
function wrongPassword(url: string): string {
  const parsed = new URL(url);
  parsed.password = "not-the-password";
  return parsed.toString();
}

const queries: Record<
  DatabaseCheckType,
  { readonly broken: string; readonly named: string }
> = {
  mysql: { broken: "SELECT nope", named: "SELECT 'watched' AS name" },
  postgres: { broken: "SELECT nope", named: "SELECT 'watched' AS name" },
  redis: { broken: "NOPE", named: "ECHO watched" },
};

/** The same URL with these query options in place of its own. */
function withOptions(url: string, options: string): string {
  const parsed = new URL(url);
  parsed.search = options;
  return parsed.toString();
}

describe.if(servers.postgres !== undefined)(
  "a Postgres server without TLS",
  () => {
    test("is a failed connection, naming the driver's code, when the URL requires TLS", async () => {
      const outcome = await check(
        "postgres",
        withOptions(servers.postgres ?? "", "sslmode=require")
      );
      expect(outcome.check.reason).toBe(reasons.connection_failed);
      expect(outcome.detail?.params).toEqual({
        code: "ERR_POSTGRES_TLS_NOT_AVAILABLE",
        reason: "connection_failed",
      });
    });
  }
);

describe.if(servers.mysql !== undefined)("a MySQL 8 server", () => {
  test("whose certificate is its own is invalid when the URL verifies it", async () => {
    const outcome = await check(
      "mysql",
      withOptions(servers.mysql ?? "", "sslmode=verify-full")
    );
    expect(outcome.check.reason).toBe(reasons.certificate_invalid);
  });

  test("refuses a sign-in over a plain connection as TLS required, Bun keeping the password off it", async () => {
    const outcome = await check("mysql", withOptions(servers.mysql ?? "", ""));
    expect(outcome.check.reason).toBe(reasons.tls_required);
    expect(outcome.detail?.params).toEqual({ reason: "tls_required" });
  });
});

describe.if(servers.postgres !== undefined)(
  "a Postgres URL without a password",
  () => {
    test("signs in with none, even when PGPASSWORD holds the right one", async () => {
      const parsed = new URL(servers.postgres ?? "");
      const password = decodeURIComponent(parsed.password);
      parsed.password = "";
      const before = process.env.PGPASSWORD;
      process.env.PGPASSWORD = password;
      try {
        const outcome = await check("postgres", parsed.toString());
        expect(outcome.check.reason).toBe(reasons.auth_failed);
      } finally {
        if (before === undefined) {
          delete process.env.PGPASSWORD;
        } else {
          process.env.PGPASSWORD = before;
        }
      }
    });
  }
);

for (const type of ["postgres", "mysql", "redis"] as const) {
  const url = servers[type];
  describe.if(url !== undefined)(`a ${type} server`, () => {
    const live = url ?? "";

    test("that answers is up", async () => {
      const outcome = await check(type, live);
      expect(outcome.check).toMatchObject({
        reason: reasons.ok,
        result: "up",
      });
    });

    test("that refuses the password is down as auth failed, the URL nowhere in the detail", async () => {
      const outcome = await check(type, wrongPassword(live));
      expect(outcome.check).toMatchObject({
        reason: reasons.auth_failed,
        result: "down",
      });
      expect(JSON.stringify(outcome)).not.toContain("not-the-password");
    });

    test("whose answer is the expected value is up, and down when it is another", async () => {
      const { named } = queries[type];
      const up = await check(type, live, { expected: "watched", query: named });
      expect(up.check.result).toBe("up");
      const down = await check(type, live, { expected: "other", query: named });
      expect(down.check.reason).toBe(reasons.assertion_failed);
      expect(down.detail?.params).toEqual({
        expected: "other",
        observed: "watched",
        reason: "assertion_failed",
      });
    });

    test("that refuses the query is down as query failed", async () => {
      const outcome = await check(type, live, {
        query: queries[type].broken,
      });
      expect(outcome.check.reason).toBe(reasons.query_failed);
    });
  });
}

describe.if(servers.postgres !== undefined)(
  "a Postgres query of many rows",
  () => {
    test("reads its first row alone: a second row that would fail is never read", async () => {
      const outcome = await check("postgres", servers.postgres ?? "", {
        expected: "1",
        query: "SELECT 1 / (2 - g) FROM generate_series(1, 3) AS g;",
      });
      expect(outcome.check.result).toBe("up");
    });

    test("that ends in a line comment reads its first row as it did unwrapped", async () => {
      const outcome = await check("postgres", servers.postgres ?? "", {
        expected: "1",
        query: "SELECT 1 -- the one row",
      });
      expect(outcome.check.result).toBe("up");
    });
  }
);

describe.if(servers.mysql !== undefined)("a MySQL query", () => {
  test("runs with every SELECT limited to one row", async () => {
    const outcome = await check("mysql", servers.mysql ?? "", {
      expected: "1",
      query: "SELECT @@session.sql_select_limit",
    });
    expect(outcome.check.result).toBe("up");
  });
});

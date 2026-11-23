/**
 * The database check's live adapter: over fake drivers in every run, over a
 * port that refuses or a server that never answers in every run, and over
 * the compose Postgres, MySQL, Redis and MongoDB under `bun run test:postgres`, which
 * sets their URLs and fails when one does not listen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type {
  DatabaseCheckType,
  DatabaseConfig,
} from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  type DatabaseQuery,
  passwordOf,
  runDatabaseCheck,
} from "./database.ts";
import {
  type DatabaseDrivers,
  firstValue,
  liveDrivers,
  queryOnce,
  type RedisOptions,
  type SqlOptions,
} from "./database-io.ts";
import { liveIo } from "./io.ts";
import type { MongoQuery } from "./mongodb.ts";

/** Fake drivers that record how they were opened and closed and answer what the test scripts. */
function drivers(answer: () => Promise<unknown>) {
  const opened: (SqlOptions | [string, RedisOptions] | MongoQuery)[] = [];
  const sent: [string, string[]][] = [];
  const queries: string[] = [];
  const closes: ({ readonly timeout?: number } | undefined)[] = [];
  let cancelled = 0;
  let closed = 0;
  const fake: DatabaseDrivers = {
    mongodb: (query) => {
      opened.push(query);
      return {
        ask: answer,
        close: () => {
          closed += 1;
        },
      };
    },
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
        close: (closeOptions) => {
          closed += 1;
          closes.push(closeOptions);
          return Promise.resolve();
        },
        unsafe: (query) => {
          queries.push(query);
          return Object.assign(answer(), {
            cancel: () => {
              cancelled += 1;
            },
          });
        },
      };
    },
  };
  return {
    cancelled: () => cancelled,
    closed: () => closed,
    closes,
    fake,
    opened,
    queries,
    sent,
  };
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
      Array.isArray(options) || !("password" in options)
        ? undefined
        : options.password()
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

  test("a MongoDB command goes to Raaqeb's own client with the URL and the timeout, and its answer is the answer", async () => {
    const { closed, fake, opened } = drivers(() => Promise.resolve(1));
    const answer = await queryOnce(
      {
        query: '{"ping": 1}',
        timeoutMs: 3000,
        type: "mongodb",
        url: "mongodb://u:pw@db.example.test",
      },
      fake
    );
    expect(answer).toBe(1);
    expect(opened).toEqual([
      {
        command: '{"ping": 1}',
        timeoutMs: 3000,
        url: "mongodb://u:pw@db.example.test",
      },
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

  test("an answered query is never cancelled, and the close does not wait", async () => {
    const { cancelled, closes, fake } = drivers(() => Promise.resolve([]));
    await queryOnce(postgres, fake);
    expect(cancelled()).toBe(0);
    expect(closes).toEqual([{ timeout: 0 }]);
  });

  test("a query past the timeout is cancelled, and the close does not wait", async () => {
    const { cancelled, closes, fake } = drivers(
      () => new Promise(() => undefined)
    );
    await queryOnce({ ...postgres, timeoutMs: 50 }, fake).catch(
      () => undefined
    );
    expect(cancelled()).toBe(1);
    expect(closes).toEqual([{ timeout: 0 }]);
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
  const types = ["postgres", "mysql", "redis"] as const;
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

describe("a connection URL that names a place on the install's own host", () => {
  const folder = `${Bun.env.TMPDIR ?? "/tmp"}/raaqeb-socket-${process.pid}`;
  const opened: string[] = [];
  const listeners: { stop: (force: boolean) => void }[] = [];
  let port = 0;

  beforeAll(async () => {
    await Bun.$`mkdir -p ${folder}`;
    for (const path of [`${folder}/.s.PGSQL.5432`, `${folder}/mysql.sock`]) {
      listeners.push(
        Bun.listen({
          socket: {
            data: () => undefined,
            open: () => {
              opened.push(path);
            },
          },
          unix: path,
        })
      );
    }
    const tcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: () => undefined,
        open: () => {
          opened.push("tcp");
        },
      },
    });
    listeners.push(tcp);
    ({ port } = tcp);
  });
  afterAll(async () => {
    for (const listener of listeners) {
      listener.stop(true);
    }
    await Bun.$`rm -rf ${folder}`;
  });

  test("is down without opening its socket, reading its file or reaching any server", async () => {
    const socket = `${folder}/mysql.sock`;
    const urls = [
      ["postgres", `postgres://u:watch-pw@db.example.test/app?path=${folder}`],
      [
        "postgres",
        `postgres://u:watch-pw@db.example.test/app?SOCKET=${folder}`,
      ],
      ["postgres", `postgres://u:watch-pw@db.example.test/app?host=${folder}`],
      ["postgres", `postgres://u:watch-pw@${encodeURIComponent(folder)}/app`],
      [
        "postgres",
        `postgres://u:watch-pw@db.example.test/app?host=127.0.0.1&port=${port}`,
      ],
      [
        "postgres",
        `postgres://u:watch-pw@127.0.0.1:${port}/app?sslmode=require&sslrootcert=${socket}`,
      ],
      [
        "postgres",
        `postgres://u:watch-pw@127.0.0.1:${port}/app?sslmode=require&sslcert=${socket}&sslkey=${socket}`,
      ],
      ["mysql", `mysql://u:watch-pw@db.example.test/app?path=${socket}`],
      ["mysql", `mysql://u:watch-pw@db.example.test/app?socket=${socket}`],
      ["mysql", `mysql://u:watch-pw@${encodeURIComponent(socket)}/app`],
    ] as const;
    for (const [type, url] of urls) {
      // biome-ignore lint/performance/noAwaitInLoops: one check at a time keeps each listener's count its own
      const outcome = await check(type, url, {}, 1500);
      expect({ opened, url }).toEqual({ opened: [], url });
      expect(outcome.check.result).toBe("down");
      expect(outcome.detail?.error).toContain("connection URL");
    }
  });
});

/** The compose servers, which `bun run test:postgres` names; the Postgres one is the run's own database, read and never written. */
const servers: Record<DatabaseCheckType, string | undefined> = {
  mysql: process.env.RAAQEB_TEST_MYSQL_URL,
  postgres: process.env.RAAQEB_TEST_DATABASE_URL,
  redis: process.env.RAAQEB_TEST_REDIS_URL,
  mongodb: process.env.RAAQEB_TEST_MONGODB_URL,
};

function check(
  type: DatabaseCheckType,
  url: string,
  config: Omit<DatabaseConfig, "type"> = {},
  timeoutMs = 5000
): Promise<CheckOutcome> {
  return runDatabaseCheck(
    {
      config: { ...config, type },
      credentials: { headers: [], url },
      degradedMs: undefined,
      id: "live",
      retries: 0,
      timeoutMs,
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

const queries = {
  mysql: { broken: "SELECT nope", named: "SELECT 'watched' AS name" },
  postgres: { broken: "SELECT nope", named: "SELECT 'watched' AS name" },
  redis: { broken: "NOPE", named: "ECHO watched" },
} as const;

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

describe.if(servers.postgres !== undefined)(
  "a Postgres query past the monitor's timeout",
  () => {
    test("is a timeout, and no longer runs on the server once the check ends", async () => {
      const tag = `raaqeb_slow_${crypto.randomUUID().replaceAll("-", "")}`;
      const outcome = await check(
        "postgres",
        servers.postgres ?? "",
        { query: `SELECT pg_sleep(30) AS ${tag}` },
        500
      );
      expect(outcome.check.reason).toBe(reasons.timeout);
      // The adapter's own driver, the one file outside storage allowed to open a SQL client. The tag is letters, digits and underscores, so it is safe inside the text.
      const watcher = liveDrivers.sql({
        connectionTimeout: 5,
        idleTimeout: 0,
        max: 1,
        maxLifetime: 0,
        password: () => passwordOf(servers.postgres ?? ""),
        url: servers.postgres ?? "",
      });
      const others = `FROM pg_stat_activity WHERE query LIKE '%${tag}%' AND pid <> pg_backend_pid()`;
      try {
        const running = async () =>
          firstValue(
            await watcher.unsafe(`SELECT count(*)::int AS n ${others}`)
          );
        // The server ends a cancelled statement within milliseconds; a second covers a loaded machine.
        const deadline = Date.now() + 1000;
        let left = await running();
        while (left !== 0 && Date.now() < deadline) {
          // biome-ignore lint/performance/noAwaitInLoops: each read waits for the one before
          await Bun.sleep(50);
          left = await running();
        }
        expect(left).toBe(0);
      } finally {
        await watcher.unsafe(`SELECT pg_terminate_backend(pid) ${others}`);
        await watcher.close();
      }
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
});

/**
 * MySQL 8's `caching_sha2_password` signs in without the RSA key only when
 * the server holds the user's password in its cache, which a full sign-in
 * fills and a restart empties; `sha256_password` never has a cache. A user
 * created here is cold until a test signs in as it, which stands for a
 * server just restarted. The compose server's own user stays warm: its
 * healthcheck signs in over TLS every two seconds.
 */
describe.if(servers.mysql !== undefined)(
  "a MySQL 8 server and a connection URL that asks for no TLS",
  () => {
    const created: string[] = [];
    const rootUrl = (() => {
      const parsed = new URL(servers.mysql ?? "mysql://x@y");
      parsed.username = "root";
      parsed.password = "raaqeb";
      return parsed.toString();
    })();

    /** Runs one statement as the server's root over TLS. */
    async function asRoot(statement: string): Promise<void> {
      const root = liveDrivers.sql({
        connectionTimeout: 5,
        idleTimeout: 0,
        max: 1,
        maxLifetime: 0,
        password: () => "raaqeb",
        url: rootUrl,
      });
      try {
        await root.unsafe(statement);
      } finally {
        await root.close({ timeout: 1 });
      }
    }

    /** A user nothing has signed in as since the server started, with its URL. */
    async function freshUser(
      plugin: "caching_sha2_password" | "sha256_password",
      password: string,
      options = ""
    ): Promise<string> {
      const user = `r747_${crypto.randomUUID().slice(0, 8)}`;
      await asRoot(
        `CREATE USER '${user}'@'%' IDENTIFIED WITH ${plugin} BY '${password}'`
      );
      created.push(user);
      await asRoot(`GRANT SELECT ON *.* TO '${user}'@'%'`);
      const parsed = new URL(servers.mysql ?? "");
      parsed.username = user;
      parsed.password = password;
      parsed.search = options;
      return parsed.toString();
    }

    const tls = "sslmode=require";

    afterAll(async () => {
      await Promise.all(
        created.map((user) => asRoot(`DROP USER '${user}'@'%'`))
      );
    });

    test("refuses a password the server has not cached as TLS required, the password never tried, on every check while the cache stays empty", async () => {
      const url = await freshUser("caching_sha2_password", "cold-password");
      const first = await check("mysql", url);
      const second = await check("mysql", url);
      expect(first.check.result).toBe("down");
      expect(first.detail?.params).toEqual({ reason: "tls_required" });
      expect(second.check.reason).toBe(reasons.tls_required);
    });

    test("signs in once a sign-in over TLS has left the password in the server's cache", async () => {
      const url = await freshUser("caching_sha2_password", "warm-password");
      expect((await check("mysql", withOptions(url, tls))).check.result).toBe(
        "up"
      );
      expect((await check("mysql", url)).check.result).toBe("up");
    });

    test("reads a wrong password as TLS required, since the server asks for the key before it says no", async () => {
      const url = await freshUser("caching_sha2_password", "right-password");
      const wrong = new URL(url);
      wrong.password = "wrong-password";
      expect((await check("mysql", wrong.toString())).check.reason).toBe(
        reasons.tls_required
      );
      await check("mysql", withOptions(url, tls));
      expect((await check("mysql", wrong.toString())).check.reason).toBe(
        reasons.tls_required
      );
    });

    test("treats a password of 20 bytes or more like a short one, cold and warm", async () => {
      const long = "a-password-of-more-than-twenty-bytes";
      expect(long.length).toBeGreaterThan(20);
      const url = await freshUser("caching_sha2_password", long);
      expect((await check("mysql", url)).check.reason).toBe(
        reasons.tls_required
      );
      expect((await check("mysql", withOptions(url, tls))).check.result).toBe(
        "up"
      );
      expect((await check("mysql", url)).check.result).toBe("up");
    });

    test("refuses a sha256_password user as TLS required on every check, even after a sign-in over TLS", async () => {
      const url = await freshUser("sha256_password", "sha-password");
      expect((await check("mysql", url)).check.reason).toBe(
        reasons.tls_required
      );
      expect((await check("mysql", withOptions(url, tls))).check.result).toBe(
        "up"
      );
      expect((await check("mysql", url)).check.reason).toBe(
        reasons.tls_required
      );
    });

    test("signs a cold caching_sha2_password user in over TLS, and names a wrong password as auth failed", async () => {
      const url = await freshUser("caching_sha2_password", "tls-password");
      const wrong = new URL(withOptions(url, tls));
      wrong.password = "wrong-password";
      expect((await check("mysql", wrong.toString())).check.reason).toBe(
        reasons.auth_failed
      );
      expect((await check("mysql", withOptions(url, tls))).check.result).toBe(
        "up"
      );
    });
  }
);

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

describe.if(servers.postgres !== undefined)("a Postgres array answer", () => {
  test("is JSON whatever the element type, a uuid or a range among them", async () => {
    const uuids = await check("postgres", servers.postgres ?? "", {
      expected: '["00000000-0000-0000-0000-000000000001"]',
      query: "SELECT ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]",
    });
    expect(uuids.check.result).toBe("up");
    const ranges = await check("postgres", servers.postgres ?? "", {
      expected: '["[1,3)"]',
      query: "SELECT ARRAY['[1,3)']::int8range[]",
    });
    expect(ranges.check.result).toBe("up");
  });
});

describe.if(servers.mysql !== undefined)(
  "a mariadb URL without a database",
  () => {
    test("signs in with no database selected", async () => {
      const parsed = new URL(servers.mysql ?? "");
      parsed.protocol = "mariadb:";
      parsed.pathname = "";
      const outcome = await check("mysql", parsed.toString(), {
        expected: "null",
        query: "SELECT DATABASE()",
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

/** The compose MongoDB servers: one that signs in with SCRAM and takes TLS or not, one with no sign-in that takes TLS alone. */
const mongo = {
  open: process.env.RAAQEB_TEST_MONGODB_TLS_URL,
  signed: process.env.RAAQEB_TEST_MONGODB_URL,
};

/** The signed-in server's URL as another user, with options. */
function mongoAs(user: string, password: string, options = ""): string {
  const parsed = new URL(mongo.signed ?? "");
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${parsed.host}/admin${options}`;
}

describe.if(mongo.signed !== undefined)(
  "a MongoDB server that signs in with SCRAM",
  () => {
    const live = mongo.signed ?? "";

    test("is up for the right password, by SCRAM-SHA-256", async () => {
      const outcome = await check("mongodb", live);
      expect(outcome.check).toMatchObject({ reason: reasons.ok, result: "up" });
    });

    test("signs in a user that has SCRAM-SHA-1 alone, and one that has SCRAM-SHA-256 alone", async () => {
      for (const user of ["sha1", "sha256"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one user at a time names the one that failed
        const outcome = await check("mongodb", mongoAs(user, user));
        expect(outcome.check.result).toBe("up");
      }
    });

    test("refuses a mechanism the user lacks as auth failed", async () => {
      const outcome = await check(
        "mongodb",
        mongoAs("sha256", "sha256", "?authMechanism=SCRAM-SHA-1")
      );
      expect(outcome.check.reason).toBe(reasons.auth_failed);
    });

    test("signs in with each form SASLprep makes the same password", async () => {
      for (const [user, password] of [
        ["IX", "IX"],
        ["IX", "I­X"],
        ["Ⅸ", "IV"],
        ["Ⅸ", "I­V"],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: one form at a time names the one that failed
        const outcome = await check("mongodb", mongoAs(user, password));
        expect(outcome.check.result).toBe("up");
      }
    });

    test("is down as auth failed for a wrong password, the password nowhere in the outcome", async () => {
      const outcome = await check(
        "mongodb",
        mongoAs("raaqeb", "not-the-password")
      );
      expect(outcome.check).toMatchObject({
        reason: reasons.auth_failed,
        result: "down",
      });
      expect(outcome.detail?.params).toEqual({
        code: "18",
        reason: "auth_failed",
      });
      expect(JSON.stringify(outcome)).not.toContain("not-the-password");
    });

    test("is down as auth failed for a user it does not know, as for a wrong password", async () => {
      const outcome = await check("mongodb", mongoAs("nobody-here", "x"));
      expect(outcome.detail?.params).toEqual({
        code: "18",
        reason: "auth_failed",
      });
    });

    test("runs the monitor's command and compares the first value of its reply", async () => {
      const up = await check("mongodb", live, {
        expected: "admin",
        query: '{"dbStats": 1}',
      });
      expect(up.check.result).toBe("up");
      const down = await check("mongodb", live, {
        expected: "other",
        query: '{"dbStats": 1}',
      });
      expect(down.detail?.params).toEqual({
        expected: "other",
        observed: "admin",
        reason: "assertion_failed",
      });
    });

    test("is down as query failed for a command the user may not run", async () => {
      const outcome = await check("mongodb", mongoAs("nobody", "nobody"), {
        query: '{"serverStatus": 1}',
      });
      expect(outcome.check.reason).toBe(reasons.query_failed);
      expect(outcome.detail?.params).toEqual({
        code: "13",
        reason: "query_failed",
      });
    });

    test("refuses a command off the read-only list without sending it", async () => {
      const outcome = await check("mongodb", live, {
        query: '{"dropDatabase": 1}',
      });
      expect(outcome.detail?.params).toEqual({
        code: "ERR_MONGODB_COMMAND_NOT_ALLOWED",
        reason: "query_failed",
      });
    });

    test("signs in over TLS, refusing the test certificate unless the URL allows it", async () => {
      const verified = await check(
        "mongodb",
        mongoAs("raaqeb", "raaqeb", "?tls=true")
      );
      expect(verified.check.reason).toBe(reasons.certificate_invalid);
      const allowed = await check(
        "mongodb",
        mongoAs(
          "raaqeb",
          "raaqeb",
          "?tls=true&tlsAllowInvalidCertificates=true"
        )
      );
      expect(allowed.check.result).toBe("up");
    });
  }
);

describe.if(mongo.open !== undefined)(
  "a MongoDB server that takes TLS alone and no sign-in",
  () => {
    const live = mongo.open ?? "";

    test("is down as TLS required over a plain connection", async () => {
      const outcome = await check("mongodb", live);
      expect(outcome.detail?.params).toEqual({ reason: "tls_required" });
    });

    test("refuses its self-signed certificate for a matching name when only invalid host names are allowed", async () => {
      const named = live.replace("127.0.0.1", "localhost");
      const outcome = await check(
        "mongodb",
        `${named}${named.includes("?") ? "&" : "?"}tls=true&tlsAllowInvalidHostnames=true`
      );
      expect(outcome.check.reason).toBe(reasons.certificate_invalid);
    });

    test("is up over TLS with no user", async () => {
      const outcome = await check(
        "mongodb",
        `${live}${live.includes("?") ? "&" : "?"}tls=true&tlsInsecure=true`
      );
      expect(outcome.check.result).toBe("up");
    });
  }
);

describe("a MongoDB server that cannot be reached", () => {
  test("is down as connection refused at a port nothing listens on", async () => {
    const outcome = await check("mongodb", `mongodb://127.0.0.1:${freePort()}`);
    expect(outcome.detail?.params).toMatchObject({
      reason: "connection_refused",
    });
  });

  test("is down as a timeout at the monitor's timeout when it never answers", async () => {
    const silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
    try {
      const started = performance.now();
      const outcome = await runDatabaseCheck(
        {
          config: { type: "mongodb" },
          credentials: {
            headers: [],
            url: `mongodb://127.0.0.1:${silent.port}`,
          },
          degradedMs: undefined,
          id: "silent",
          retries: 0,
          timeoutMs: 300,
        },
        liveIo()
      );
      expect(outcome.detail?.params).toEqual({
        reason: "timeout",
        timeoutMs: 300,
      });
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      silent.stop(true);
    }
  });
});

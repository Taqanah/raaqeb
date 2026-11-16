import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  databaseServerMissingMessage,
  databaseServers,
  listening,
  mailpitAddresses,
  mailpitMissingMessage,
  missingMessage,
  missingServices,
  portOf,
  postgresUrl,
  takeDatabase,
  testCommand,
} from "./test-postgres.ts";

const scriptPath = `${import.meta.dir}/test-postgres.ts`;
const composeServer = "postgres://raaqeb:raaqeb@localhost:5432";
const checkout = "/home/someone/raaqeb";

/** A port nothing listens on: bound once by a throwaway server, then released. */
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

describe("the Postgres test run", () => {
  test("targets RAAQEB_TEST_DATABASE_URL when it is set", () => {
    const url = "postgres://u:p@db.example:6543/raaqeb";
    expect(postgresUrl({ RAAQEB_TEST_DATABASE_URL: url }, checkout)).toBe(url);
  });

  test("targets a database of the checkout's own on the compose Postgres when RAAQEB_TEST_DATABASE_URL is unset", () => {
    const url = postgresUrl({}, checkout);
    expect(url.startsWith(`${composeServer}/raaqeb_test_`)).toBe(true);
    expect(postgresUrl({}, checkout)).toBe(url);
  });

  test("two checkouts never share a database, so one run never drops the other's tables", () => {
    expect(postgresUrl({}, `${checkout}-second`)).not.toBe(
      postgresUrl({}, checkout)
    );
  });

  test("never targets the compose service's own database unless its URL is passed", () => {
    expect(postgresUrl({}, checkout)).not.toBe(`${composeServer}/raaqeb`);
  });

  test("never targets the boot setting DATABASE_URL, which may name a real database", () => {
    expect(
      postgresUrl(
        { DATABASE_URL: "postgres://raaqeb:pw@db.example/prod" },
        checkout
      )
    ).toBe(postgresUrl({}, checkout));
  });

  test("runs the files it is given, or every test folder when given none", () => {
    expect(testCommand([])).toEqual(["bun", "test", "src", "scripts", "bench"]);
    expect(testCommand(["src/server/storage/storage.test.ts"])).toEqual([
      "bun",
      "test",
      "src/server/storage/storage.test.ts",
    ]);
  });

  test.if(process.env.RAAQEB_TEST_DATABASE_URL !== undefined)(
    "a run takes its database, created when absent, refuses a second run while it holds it, and drops it when done",
    async () => {
      const server = new URL(process.env.RAAQEB_TEST_DATABASE_URL ?? "");
      const name = `raaqeb_test_taken_${process.pid}`;
      server.pathname = `/${name}`;
      const url = server.toString();
      const exists = async () => {
        server.pathname = "/postgres";
        const admin = new SQL(server.toString());
        try {
          return (
            (await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`)
              .length === 1
          );
        } finally {
          await admin.close();
        }
      };
      const drop = await takeDatabase(url);
      expect(drop).toBeDefined();
      expect(await exists()).toBe(true);
      expect(await takeDatabase(url)).toBeUndefined();
      await drop?.();
      expect(await exists()).toBe(false);
      // A database a killed run left behind is taken again.
      const again = await takeDatabase(url);
      expect(again).toBeDefined();
      await again?.();
    }
  );

  test.if(process.env.RAAQEB_TEST_DATABASE_URL !== undefined)(
    "first runs that start at once on a missing database: one takes it, the others are refused, none fails",
    async () => {
      const server = new URL(process.env.RAAQEB_TEST_DATABASE_URL ?? "");
      server.pathname = `/raaqeb_test_race_${process.pid}`;
      const url = server.toString();
      const taken = await Promise.all([1, 2, 3].map(() => takeDatabase(url)));
      const drops = taken.filter((drop) => drop !== undefined);
      expect(drops).toHaveLength(1);
      await drops[0]?.();
    }
  );

  test("finds a Postgres that listens", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
    try {
      expect(
        await listening(
          `postgres://raaqeb:raaqeb@127.0.0.1:${server.port}/raaqeb`
        )
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("finds nothing when the port is closed", async () => {
    expect(
      await listening(`postgres://raaqeb:raaqeb@127.0.0.1:${freePort()}/raaqeb`)
    ).toBe(false);
  });

  test("the failure names the variable and the compose command, never the URL", () => {
    const message = missingMessage(
      "postgres://raaqeb:hunter2@localhost:5432/raaqeb"
    );
    expect(message).toContain("RAAQEB_TEST_DATABASE_URL");
    expect(message).toContain("docker compose up -d");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("localhost:5432");
  });

  test("a missing Postgres fails the run and never skips it", async () => {
    const run = Bun.spawn(["bun", scriptPath], {
      env: {
        ...process.env,
        RAAQEB_TEST_DATABASE_URL: `postgres://raaqeb:hunter2@127.0.0.1:${freePort()}/raaqeb`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("docker compose up -d");
    expect(stderr).not.toContain("hunter2");
  });
});

describe("the Mailpit the Postgres run also needs", () => {
  test("is the compose Mailpit unless the run names another", () => {
    expect(mailpitAddresses({})).toEqual({
      api: "http://127.0.0.1:8025",
      smtp: "smtp://127.0.0.1:1025",
    });
    expect(
      mailpitAddresses({
        RAAQEB_TEST_MAILPIT_API: "http://127.0.0.1:9025",
        RAAQEB_TEST_MAILPIT_SMTP: "smtp://127.0.0.1:2025",
      })
    ).toEqual({ api: "http://127.0.0.1:9025", smtp: "smtp://127.0.0.1:2025" });
  });

  test("the run starts only when Postgres and both of Mailpit's ports listen", () => {
    const url = "postgres://raaqeb:raaqeb@localhost:5432/raaqeb";
    const all = {
      api: true,
      mongodb: true,
      mongodbTls: true,
      mysql: true,
      postgres: true,
      redis: true,
      smtp: true,
    };
    expect(missingServices(url, all)).toEqual([]);
    expect(missingServices(url, { ...all, api: false })).toEqual([
      mailpitMissingMessage(),
    ]);
    expect(missingServices(url, { ...all, smtp: false })).toEqual([
      mailpitMissingMessage(),
    ]);
    expect(missingServices(url, { ...all, postgres: false })).toEqual([
      missingMessage(url),
    ]);
  });

  test("its failure names the compose command", () => {
    expect(mailpitMissingMessage()).toContain("docker compose up -d");
    expect(mailpitMissingMessage()).toContain("Mailpit");
  });

  test("a missing Mailpit fails the run and never skips it, beside a missing Postgres", async () => {
    // Nothing listens at either address, so no version of the script can start the suite from here.
    const run = Bun.spawn(["bun", scriptPath], {
      env: {
        ...process.env,
        RAAQEB_TEST_DATABASE_URL: `postgres://raaqeb:raaqeb@127.0.0.1:${freePort()}/raaqeb`,
        RAAQEB_TEST_MAILPIT_API: `http://127.0.0.1:${freePort()}`,
        RAAQEB_TEST_MAILPIT_SMTP: `smtp://127.0.0.1:${freePort()}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("RAAQEB_TEST_DATABASE_URL");
    expect(stderr).toContain("Mailpit");
  });

  test("a URL with no port is probed at its scheme's own port", () => {
    expect(portOf("postgres://raaqeb@db/raaqeb")).toBe(5432);
    expect(portOf("http://mailpit")).toBe(80);
    expect(portOf("smtp://mailpit")).toBe(25);
    expect(portOf("http://127.0.0.1:8025")).toBe(8025);
  });
});

describe("the MySQL, Redis and MongoDB the database monitors' checks reach", () => {
  test("are the compose services unless the run names others", () => {
    expect(databaseServers({})).toEqual({
      mongodb: "mongodb://raaqeb:raaqeb@127.0.0.1:27017/admin",
      mongodbTls: "mongodb://127.0.0.1:27018",
      mysql: "mysql://raaqeb:raaqeb@127.0.0.1:3306/raaqeb?sslmode=require",
      redis: "redis://:raaqeb@127.0.0.1:6379",
    });
    expect(
      databaseServers({
        RAAQEB_TEST_MONGODB_TLS_URL: "mongodb://tls.example:27020",
        RAAQEB_TEST_MONGODB_URL: "mongodb://u:p@mongo.example:27019",
        RAAQEB_TEST_MYSQL_URL: "mysql://u:p@db.example:3307/x",
        RAAQEB_TEST_REDIS_URL: "redis://cache.example:6380",
      })
    ).toEqual({
      mongodb: "mongodb://u:p@mongo.example:27019",
      mongodbTls: "mongodb://tls.example:27020",
      mysql: "mysql://u:p@db.example:3307/x",
      redis: "redis://cache.example:6380",
    });
  });

  test("the run starts only when both listen, and a missing one names its variable", () => {
    const url = "postgres://raaqeb:raaqeb@localhost:5432/raaqeb";
    const all = {
      api: true,
      mongodb: true,
      mongodbTls: true,
      mysql: true,
      postgres: true,
      redis: true,
      smtp: true,
    };
    expect(missingServices(url, { ...all, mysql: false })).toEqual([
      databaseServerMissingMessage("RAAQEB_TEST_MYSQL_URL"),
    ]);
    expect(missingServices(url, { ...all, redis: false })).toEqual([
      databaseServerMissingMessage("RAAQEB_TEST_REDIS_URL"),
    ]);
    expect(missingServices(url, { ...all, mongodb: false })).toEqual([
      databaseServerMissingMessage("RAAQEB_TEST_MONGODB_URL"),
    ]);
    expect(missingServices(url, { ...all, mongodbTls: false })).toEqual([
      databaseServerMissingMessage("RAAQEB_TEST_MONGODB_TLS_URL"),
    ]);
  });

  test("the failure names the variable and the compose command, never a URL", () => {
    const message = databaseServerMissingMessage("RAAQEB_TEST_MYSQL_URL");
    expect(message).toContain("RAAQEB_TEST_MYSQL_URL");
    expect(message).toContain("docker compose up -d");
    expect(message).not.toContain("raaqeb@");
  });

  test("a URL with no port is probed at its database's own port", () => {
    expect(portOf("mysql://raaqeb@db/raaqeb")).toBe(3306);
    expect(portOf("redis://cache")).toBe(6379);
    // Every scheme a database monitor takes.
    expect(portOf("mariadb://db/raaqeb")).toBe(3306);
    expect(portOf("rediss://cache")).toBe(6379);
    expect(portOf("postgresql://db/raaqeb")).toBe(5432);
    expect(portOf("mongodb://mongo/admin")).toBe(27_017);
  });
});

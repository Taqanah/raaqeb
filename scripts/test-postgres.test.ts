import { describe, expect, test } from "bun:test";
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
} from "./test-postgres.ts";

const scriptPath = new URL("./test-postgres.ts", import.meta.url).pathname;
const composeUrl = "postgres://raaqeb:raaqeb@localhost:5432/raaqeb";

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
    expect(postgresUrl({ RAAQEB_TEST_DATABASE_URL: url })).toBe(url);
  });

  test("targets the compose Postgres when RAAQEB_TEST_DATABASE_URL is unset", () => {
    expect(postgresUrl({})).toBe(composeUrl);
  });

  test("never targets the boot setting DATABASE_URL, which may name a real database", () => {
    expect(
      postgresUrl({ DATABASE_URL: "postgres://raaqeb:pw@db.example/prod" })
    ).toBe(composeUrl);
  });

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

describe("the MySQL and Redis the database monitors' checks reach", () => {
  test("are the compose services unless the run names others", () => {
    expect(databaseServers({})).toEqual({
      mysql: "mysql://raaqeb:raaqeb@127.0.0.1:3306/raaqeb?sslmode=require",
      redis: "redis://:raaqeb@127.0.0.1:6379",
    });
    expect(
      databaseServers({
        RAAQEB_TEST_MYSQL_URL: "mysql://u:p@db.example:3307/x",
        RAAQEB_TEST_REDIS_URL: "redis://cache.example:6380",
      })
    ).toEqual({
      mysql: "mysql://u:p@db.example:3307/x",
      redis: "redis://cache.example:6380",
    });
  });

  test("the run starts only when both listen, and a missing one names its variable", () => {
    const url = "postgres://raaqeb:raaqeb@localhost:5432/raaqeb";
    const all = {
      api: true,
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
  });
});

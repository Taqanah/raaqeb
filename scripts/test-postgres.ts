/**
 * `bun run test:postgres`: the same test files as `bun run test`, run against
 * the compose Postgres, plus the email channel's send through the compose
 * Mailpit and the database monitors' checks against the compose MySQL and
 * Redis. A missing service fails the run and never skips it. The run is named
 * by `RAAQEB_TEST_DATABASE_URL`, its own variable: the boot setting
 * `DATABASE_URL` may name a real database, and the fixture drops every table
 * in the one it targets.
 */

const composeUrl = "postgres://raaqeb:raaqeb@localhost:5432/raaqeb";
const composeCommand = "docker compose up -d";

/** The URL the run targets: RAAQEB_TEST_DATABASE_URL when set, else the compose service. */
export function postgresUrl(
  env: Readonly<Record<string, string | undefined>>
): string {
  return env.RAAQEB_TEST_DATABASE_URL ?? composeUrl;
}

/** The port a URL names, or its scheme's own. */
export function portOf(url: string): number {
  const { port, protocol } = new URL(url);
  return port === "" ? (schemePorts[protocol] ?? 5432) : Number(port);
}

const schemePorts: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
  "mariadb:": 3306,
  "mysql:": 3306,
  "postgres:": 5432,
  "postgresql:": 5432,
  "redis:": 6379,
  "rediss:": 6379,
  "smtp:": 25,
};

/** Whether something accepts a TCP connection at the URL's host and port within the timeout. */
export function listening(url: string, timeoutMs = 2000): Promise<boolean> {
  const { hostname } = new URL(url);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const settle = (answer: boolean) => {
      clearTimeout(timer);
      resolve(answer);
    };
    Bun.connect({
      hostname,
      port: portOf(url),
      socket: {
        connectError: () => settle(false),
        data: () => undefined,
        open: (socket) => {
          settle(true);
          socket.end();
        },
      },
    }).catch(() => settle(false));
  });
}

/** Where the Mailpit run sends and reads: `RAAQEB_TEST_MAILPIT_SMTP` and `RAAQEB_TEST_MAILPIT_API` when set, else the compose service. */
export function mailpitAddresses(
  env: Readonly<Record<string, string | undefined>>
): { readonly api: string; readonly smtp: string } {
  return {
    api: env.RAAQEB_TEST_MAILPIT_API ?? "http://127.0.0.1:8025",
    smtp: env.RAAQEB_TEST_MAILPIT_SMTP ?? "smtp://127.0.0.1:1025",
  };
}

/** The failure printed when Mailpit does not listen. */
export function mailpitMissingMessage(): string {
  return `raaqeb: Mailpit does not listen where the Postgres test run sends email (RAAQEB_TEST_MAILPIT_SMTP and RAAQEB_TEST_MAILPIT_API, or the compose service when unset). Start it with: ${composeCommand}`;
}

/** Where the database monitors' checks reach a MySQL and a Redis: `RAAQEB_TEST_MYSQL_URL` and `RAAQEB_TEST_REDIS_URL` when set, else the compose services. The Postgres they reach is the run's own. */
export function databaseServers(
  env: Readonly<Record<string, string | undefined>>
): { readonly mysql: string; readonly redis: string } {
  return {
    // MySQL 8 signs a password in over TLS or not at all.
    mysql:
      env.RAAQEB_TEST_MYSQL_URL ??
      "mysql://raaqeb:raaqeb@127.0.0.1:3306/raaqeb?sslmode=require",
    redis: env.RAAQEB_TEST_REDIS_URL ?? "redis://:raaqeb@127.0.0.1:6379",
  };
}

/** The failure printed when a database monitor's server does not listen; names the variable, never the URL. */
export function databaseServerMissingMessage(variable: string): string {
  return `raaqeb: nothing listens where the database monitors' checks reach (${variable}, or the compose service when unset). Start it with: ${composeCommand}`;
}

/** What the run cannot start without, as the lines to print: nothing when every service listens. */
export function missingServices(
  url: string,
  up: {
    readonly api: boolean;
    readonly mysql: boolean;
    readonly postgres: boolean;
    readonly redis: boolean;
    readonly smtp: boolean;
  }
): string[] {
  return [
    ...(up.postgres ? [] : [missingMessage(url)]),
    ...(up.smtp && up.api ? [] : [mailpitMissingMessage()]),
    ...(up.mysql
      ? []
      : [databaseServerMissingMessage("RAAQEB_TEST_MYSQL_URL")]),
    ...(up.redis
      ? []
      : [databaseServerMissingMessage("RAAQEB_TEST_REDIS_URL")]),
  ];
}

/**
 * The failure printed when nothing listens. Names the variable and the compose
 * command; never the URL, which may carry a password.
 */
export function missingMessage(url: string): string {
  return `raaqeb: nothing listens where the Postgres test run points (RAAQEB_TEST_DATABASE_URL, ${url.length} characters, or the compose service when unset). Start it with: ${composeCommand}`;
}

if (import.meta.main) {
  const url = postgresUrl(process.env);
  const mailpit = mailpitAddresses(process.env);
  const databases = databaseServers(process.env);
  const [postgres, smtp, api, mysql, redis] = await Promise.all([
    listening(url),
    listening(mailpit.smtp),
    listening(mailpit.api),
    listening(databases.mysql),
    listening(databases.redis),
  ]);
  const missing = missingServices(url, { api, mysql, postgres, redis, smtp });
  if (missing.length > 0) {
    process.stderr.write(`${missing.join("\n")}\n`);
    process.exit(1);
  }
  const run = Bun.spawn(["bun", "test", "src", "scripts", "bench"], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      RAAQEB_TEST_DATABASE_URL: url,
      RAAQEB_TEST_MAILPIT_API: mailpit.api,
      RAAQEB_TEST_MAILPIT_SMTP: mailpit.smtp,
      RAAQEB_TEST_MYSQL_URL: databases.mysql,
      RAAQEB_TEST_REDIS_URL: databases.redis,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await run.exited);
}

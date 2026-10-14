import { describe, expect, test } from "bun:test";
import { closeConnection } from "./connection.ts";
import { fixtureBackend, fixtureUrl } from "./fixture.ts";
import {
  classifyConnectError,
  defaultConnectWindowMs,
  driverUrl,
  isTransactionPooler,
  openPostgres,
  postgresOptions,
} from "./postgres.ts";

const onPostgres = fixtureBackend() === "postgres";
const composeUrl = fixtureUrl() ?? "";

describe("recognising a transaction pooler", () => {
  test("Supavisor on port 6543", () => {
    expect(
      isTransactionPooler(
        "postgres://user:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"
      )
    ).toBe(true);
  });

  test("Neon's pooler host", () => {
    expect(
      isTransactionPooler(
        "postgres://user:pw@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb"
      )
    ).toBe(true);
  });

  test("PgBouncer on its own port 6432, as PlanetScale serves it", () => {
    expect(
      isTransactionPooler(
        "postgres://user:pw@abc123.horizon.psdb.cloud:6432/postgres"
      )
    ).toBe(true);
  });

  test("pgbouncer=true in the query", () => {
    expect(
      isTransactionPooler(
        "postgres://user:pw@db.example.com:5432/app?pgbouncer=true"
      )
    ).toBe(true);
  });

  test("a plain URL is not a pooler", () => {
    expect(
      isTransactionPooler("postgres://raaqeb:raaqeb@localhost:5432/raaqeb")
    ).toBe(false);
    expect(
      isTransactionPooler(
        "postgres://user:pw@ep-cool-name.eu-central-1.aws.neon.tech/neondb"
      )
    ).toBe(false);
  });

  test("a string that is not a URL is not a pooler", () => {
    expect(isTransactionPooler("nonsense")).toBe(false);
  });
});

describe("the URL the driver is given", () => {
  test("drops the pgbouncer marker, which the server would refuse as a setting, and keeps every other part", () => {
    expect(
      driverUrl(
        "postgres://u:p%40ss@db.example.com:6543/app?sslmode=require&pgbouncer=true&application_name=raaqeb"
      )
    ).toBe(
      "postgres://u:p%40ss@db.example.com:6543/app?sslmode=require&application_name=raaqeb"
    );
  });

  test("leaves a URL without the marker exactly as written", () => {
    for (const url of [
      "postgres://raaqeb:raaqeb@localhost:5432/raaqeb",
      "postgresql://u:p@h/d?sslmode=verify-full",
      "nonsense",
    ]) {
      expect(driverUrl(url)).toBe(url);
    }
  });
});

describe("the driver options", () => {
  test("named prepared statements are off for a pooler and on otherwise", () => {
    expect(postgresOptions("postgres://u:p@h:6543/d").prepare).toBe(false);
    expect(postgresOptions("postgres://u:p@h:5432/d").prepare).toBe(true);
  });

  test("the idle and lifetime timers are off so no timer cancels a query", () => {
    const options = postgresOptions("postgres://u:p@h:5432/d");
    expect(options.idleTimeout).toBe(0);
    expect(options.maxLifetime).toBe(0);
  });

  test("one attempt is bounded well inside the retry window", () => {
    const options = postgresOptions("postgres://u:p@h:5432/d");
    expect(options.connectionTimeout).toBeGreaterThan(0);
    expect(options.connectionTimeout * 1000).toBeLessThan(
      defaultConnectWindowMs
    );
  });

  test("the pool is small: a single process on 240 MB", () => {
    expect(postgresOptions("postgres://u:p@h:5432/d").max).toBeLessThanOrEqual(
      4
    );
  });
});

describe("classifying a connection failure", () => {
  const withCode = (code: string): Error =>
    Object.assign(new Error("driver text, never relayed"), { code });

  test("nothing listening is refused", () => {
    expect(
      classifyConnectError(withCode("ERR_POSTGRES_CONNECTION_REFUSED"))
    ).toBe("refused");
    expect(classifyConnectError(withCode("ECONNREFUSED"))).toBe("refused");
  });

  test("a hang is a timeout", () => {
    expect(
      classifyConnectError(withCode("ERR_POSTGRES_CONNECTION_TIMEOUT"))
    ).toBe("timeout");
  });

  test("a wrong password is authentication", () => {
    expect(
      classifyConnectError(
        withCode("ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF2")
      )
    ).toBe("authentication");
    expect(classifyConnectError(withCode("28P01"))).toBe("authentication");
  });

  test("a missing database is database", () => {
    expect(classifyConnectError(withCode("3D000"))).toBe("database");
  });

  test("TLS trouble is tls, and the empty error of a hostname mismatch too", () => {
    expect(
      classifyConnectError(withCode("ERR_POSTGRES_TLS_UPGRADE_FAILED"))
    ).toBe("tls");
    // A TLS hostname mismatch arrives as an empty error object.
    const empty = Object.assign(new Error("mismatch"), { errno: 0 });
    empty.message = "";
    expect(classifyConnectError(empty)).toBe("tls");
  });

  test("anything else is unknown", () => {
    expect(classifyConnectError(new Error("boom"))).toBe("unknown");
    expect(classifyConnectError("not an error")).toBe("unknown");
  });

  test("an empty message alone is not the TLS shape", () => {
    // Only the documented shape (empty message, errno 0) is the mismatch.
    const blank = (errno?: number): Error => {
      const error = new Error("blanked below");
      error.message = "";
      return errno === undefined ? error : Object.assign(error, { errno });
    };
    expect(classifyConnectError(blank())).toBe("unknown");
    expect(classifyConnectError(blank(-111))).toBe("unknown");
  });
});

/**
 * A server speaking just enough of the Postgres protocol to refuse every
 * startup with one SQLSTATE, so a failure the compose Postgres cannot
 * produce on demand is reproducible in the SQLite run too.
 */
function refusingPostgres(sqlstate: string): { url: string; stop: () => void } {
  const encoder = new TextEncoder();
  const fields = [
    ["S", "FATAL"],
    ["V", "FATAL"],
    ["C", sqlstate],
    ["M", "driver text, never relayed"],
  ] as const;
  const body: number[] = [];
  for (const [tag, text] of fields) {
    body.push(tag.charCodeAt(0), ...encoder.encode(text), 0);
  }
  body.push(0);
  // 'E', then the length counting itself, then the fields.
  const errorResponse = new Uint8Array(5 + body.length);
  errorResponse[0] = "E".charCodeAt(0);
  new DataView(errorResponse.buffer).setInt32(1, body.length + 4);
  errorResponse.set(body, 5);
  const sslRequestCode = 80_877_103;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const view = new DataView(
          data.buffer,
          data.byteOffset,
          data.byteLength
        );
        if (data.byteLength === 8 && view.getInt32(4) === sslRequestCode) {
          socket.write("N");
          return;
        }
        socket.write(errorResponse);
        socket.end();
      },
    },
  });
  return {
    stop: () => server.stop(true),
    url: `postgres://u:p@127.0.0.1:${server.port}/raaqeb`,
  };
}

describe("connecting", () => {
  test("nothing listening is reported as refused once the window closes, within one pause of its length", async () => {
    const started = Date.now();
    const result = await openPostgres("postgres://u:p@127.0.0.1:1/raaqeb", {
      windowMs: 300,
    });
    expect(result).toEqual({ failure: "refused", ok: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    // Refusal is immediate here, so the last pause is cut to the deadline.
    expect(Date.now() - started).toBeLessThan(600);
  });

  test("a host name with no address is reported as unresolved, not as refused", async () => {
    // .invalid never resolves (RFC 2606); the driver words it as a refusal.
    const result = await openPostgres(
      "postgres://u:p@no-such-host.invalid/raaqeb",
      {
        windowMs: 300,
      }
    );
    expect(result).toEqual({ failure: "unresolved", ok: false });
  });

  test("a failure that a retry cannot mend stops at once", async () => {
    const fake = refusingPostgres("28P01");
    try {
      const started = Date.now();
      const result = await openPostgres(fake.url, { windowMs: 5000 });
      expect(result).toEqual({ failure: "authentication", ok: false });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      fake.stop();
    }
  });

  test("a URL the driver cannot parse fails at once without retrying", async () => {
    const started = Date.now();
    const result = await openPostgres("nonsense", { windowMs: 5000 });
    expect(result).toEqual({ failure: "malformed", ok: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test.if(onPostgres)(
    "a URL marked pgbouncer=true connects, the marker never reaching the server",
    async () => {
      const url = new URL(composeUrl);
      url.searchParams.set("pgbouncer", "true");
      const result = await openPostgres(url.toString(), { windowMs: 5000 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        await closeConnection(result.connection);
      }
    }
  );

  test.if(onPostgres)(
    "a wrong password is authentication, not a retry",
    async () => {
      const url = new URL(composeUrl);
      url.password = "wrong";
      const started = Date.now();
      const result = await openPostgres(url.toString(), { windowMs: 5000 });
      expect(result).toEqual({ failure: "authentication", ok: false });
      expect(Date.now() - started).toBeLessThan(4000);
    }
  );

  test.if(onPostgres)("a missing database is database", async () => {
    const url = new URL(composeUrl);
    url.pathname = "/no_such_database";
    const result = await openPostgres(url.toString(), { windowMs: 5000 });
    expect(result).toEqual({ failure: "database", ok: false });
  });
});

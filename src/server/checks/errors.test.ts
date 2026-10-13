import { describe, expect, test } from "bun:test";
import { errorMaxLength } from "@/shared/schemas/check.ts";
import { credentialMask, credentialPatterns } from "./capture.ts";
import {
  reasonForDatabaseError,
  reasonForDnsError,
  reasonForDockerError,
  reasonForError,
} from "./errors.ts";

const target = { host: "example.test", port: 443, timeoutMs: 10_000 };

function coded(code: string, message = code): Error {
  const error = new TypeError(message);
  Object.assign(error, { code });
  return error;
}

describe("the reason of a fetch error", () => {
  test("a timeout is the reason timeout with the timeout it hit", () => {
    const error = new DOMException("The operation timed out.", "TimeoutError");
    expect(reasonForError(error, target)).toEqual({
      error: "The operation timed out.",
      params: { reason: "timeout", timeoutMs: 10_000 },
      reason: "timeout",
    });
  });

  test("a name that does not resolve is DNS failed with the host", () => {
    for (const code of [
      "ENOTFOUND",
      "EAI_AGAIN",
      "EAI_NONAME",
      "DNSResolutionFailed",
    ]) {
      expect(reasonForError(coded(code), target)).toMatchObject({
        params: { host: "example.test", reason: "dns_failed" },
        reason: "dns_failed",
      });
    }
  });

  test("a refused connection names the host and port", () => {
    expect(
      reasonForError(coded("ConnectionRefused", "Unable to connect."), target)
    ).toEqual({
      error: "Unable to connect.",
      params: { host: "example.test", port: 443, reason: "connection_refused" },
      reason: "connection_refused",
    });
    expect(reasonForError(coded("ECONNREFUSED"), target)).toMatchObject({
      reason: "connection_refused",
    });
  });

  test("a reset, closed or unreachable connection, or a TLS handshake ended before any certificate, is connection failed with the driver's code", () => {
    for (const code of [
      "ECONNRESET",
      "ConnectionClosed",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
      "FailedToOpenSocket",
      // A TLS handshake the server answered without TLS, as Bun's fetch names it.
      "EPROTO",
    ]) {
      expect(reasonForError(coded(code), target)).toMatchObject({
        params: { code, reason: "connection_failed" },
        reason: "connection_failed",
      });
    }
  });

  test("an expired certificate is its own reason; every other verification failure is certificate invalid with the code", () => {
    expect(
      reasonForError(
        coded("CERT_HAS_EXPIRED", "certificate has expired"),
        target
      )
    ).toEqual({
      error: "certificate has expired",
      params: { reason: "certificate_expired" },
      reason: "certificate_expired",
    });
    for (const code of [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_NOT_YET_VALID",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_UNTRUSTED",
      "HOSTNAME_MISMATCH",
      // A verification code Bun has no name for.
      "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
    ]) {
      expect(reasonForError(coded(code), target)).toMatchObject({
        params: { code, reason: "certificate_invalid" },
        reason: "certificate_invalid",
      });
    }
  });

  test("too many redirects is its own reason", () => {
    expect(
      reasonForError(
        coded("TooManyRedirects", "The response redirected too many times."),
        target
      )
    ).toMatchObject({
      params: { reason: "too_many_redirects" },
      reason: "too_many_redirects",
    });
  });

  test("the error text leaves out Bun's advice to pass verbose to fetch(), which speaks to a developer and not the operator", () => {
    const hint =
      " For more information, pass `verbose: true` in the second argument to fetch()";
    expect(
      reasonForError(
        coded(
          "ERR_TLS_CERT_ALTNAME_INVALID",
          `ERR_TLS_CERT_ALTNAME_INVALID fetching "https://wrong.host.badssl.com/".${hint}`
        ),
        target
      ).error
    ).toBe(
      'ERR_TLS_CERT_ALTNAME_INVALID fetching "https://wrong.host.badssl.com/".'
    );
    expect(
      reasonForError(
        coded(
          "ECONNRESET",
          `The socket connection was closed unexpectedly.${hint}`
        ),
        target
      ).error
    ).toBe("The socket connection was closed unexpectedly.");
  });

  test("the error text leaves out the code Bun writes before its sentence, which the reason already names", () => {
    expect(
      reasonForError(
        coded(
          "ECONNREFUSED",
          "ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
        ),
        target
      ).error
    ).toBe("Unable to connect. Is the computer able to access the url?");
  });

  test("the advice is left out before the text is cut, so a long URL never leaves a piece of it", () => {
    const url = `https://example.test/${"a".repeat(200)}`;
    const { error } = reasonForError(
      coded(
        "SOMETHING_NEW",
        `SOMETHING_NEW fetching "${url}". For more information, pass \`verbose: true\` in the second argument to fetch()`
      ),
      target
    );
    expect(error).toBe(`SOMETHING_NEW fetching "${url}".`);
  });

  test("the error text of a real fetch that redirects too many times is Bun's sentence alone", async () => {
    using server = Bun.serve({
      fetch: (request) => Response.redirect(request.url, 302),
      hostname: "127.0.0.1",
      port: 0,
    });
    const error = await fetch(server.url).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(reasonForError(error, target)).toEqual({
      error: "The response redirected too many times.",
      params: { reason: "too_many_redirects" },
      reason: "too_many_redirects",
    });
  });

  test("anything else is unknown with the raw text beside it, cut to 256 characters", () => {
    expect(reasonForError(new Error("x".repeat(500)), target)).toEqual({
      error: "x".repeat(errorMaxLength),
      params: { reason: "unknown" },
      reason: "unknown",
    });
    expect(reasonForError("a string", target)).toEqual({
      error: "a string",
      params: { reason: "unknown" },
      reason: "unknown",
    });
    expect(reasonForError(coded("SOMETHING_NEW"), target)).toMatchObject({
      reason: "unknown",
    });
  });
});

describe("the reason of a resolver error", () => {
  const query = { name: "example.test", timeoutMs: 10_000 };

  test("a query that ran out of time is a timeout, whether the resolver or a timer said so", () => {
    expect(
      reasonForDnsError(
        coded("ETIMEOUT", "queryA ETIMEOUT example.test"),
        query
      )
    ).toEqual({
      error: "queryA ETIMEOUT example.test",
      params: { reason: "timeout", timeoutMs: 10_000 },
      reason: "timeout",
    });
    const timer = new DOMException("The operation timed out.", "TimeoutError");
    expect(reasonForDnsError(timer, query)).toMatchObject({
      reason: "timeout",
    });
  });

  test("no such name, no record of that type, a server failure or a refused query is DNS failed with the name", () => {
    for (const code of [
      "ENOTFOUND",
      "ENODATA",
      "ESERVFAIL",
      "EREFUSED",
      "ECANCELLED",
      "EBADRESP",
      "ECONNREFUSED",
    ]) {
      expect(reasonForDnsError(coded(code), query)).toEqual({
        error: code,
        params: { host: "example.test", reason: "dns_failed" },
        reason: "dns_failed",
      });
    }
  });

  test("a platform error that is not the resolver's answer, such as a bad resolver address, is unknown with its text", () => {
    expect(
      reasonForDnsError(
        coded("ERR_INVALID_IP_ADDRESS", 'Invalid IP address: "dns.google"'),
        query
      )
    ).toEqual({
      error: 'Invalid IP address: "dns.google"',
      params: { reason: "unknown" },
      reason: "unknown",
    });
  });

  test("an error without a code is unknown with its text, cut to 256 characters", () => {
    expect(reasonForDnsError(new Error("y".repeat(300)), query)).toEqual({
      error: "y".repeat(errorMaxLength),
      params: { reason: "unknown" },
      reason: "unknown",
    });
    expect(reasonForDnsError(42, query)).toMatchObject({
      error: "42",
      reason: "unknown",
    });
  });
});

describe("the reason of a database driver's error", () => {
  const server = { host: "db.example.test", port: 5432, timeoutMs: 10_000 };
  /** A driver error as Bun 1.4.3 throws one: its own code, and the server's in `errno`. */
  const driver = (code: string, errno?: string | number, message = code) =>
    Object.assign(new Error(message), { code, errno });

  test("a connection that ran out of time is a timeout, from the timer or from the driver", () => {
    for (const error of [
      new DOMException("The operation timed out.", "TimeoutError"),
      driver("ERR_POSTGRES_CONNECTION_TIMEOUT"),
      driver("ERR_MYSQL_CONNECTION_TIMEOUT"),
      driver("ERR_REDIS_CONNECTION_TIMEOUT"),
    ]) {
      expect(reasonForDatabaseError(error, server)).toMatchObject({
        params: { reason: "timeout", timeoutMs: 10_000 },
        reason: "timeout",
      });
    }
  });

  test("a refused connection is connection refused with the URL's host and port", () => {
    for (const code of [
      "ERR_POSTGRES_CONNECTION_REFUSED",
      "ERR_MYSQL_CONNECTION_REFUSED",
      "ECONNREFUSED",
    ]) {
      expect(reasonForDatabaseError(driver(code), server)).toMatchObject({
        params: {
          host: "db.example.test",
          port: 5432,
          reason: "connection_refused",
        },
        reason: "connection_refused",
      });
    }
  });

  test("a sign-in the server refused is auth failed with the server's code", () => {
    const cases: [Error, string][] = [
      [driver("ERR_POSTGRES_SERVER_ERROR", "28P01"), "28P01"],
      [driver("ERR_POSTGRES_SERVER_ERROR", "28000"), "28000"],
      [driver("ERR_POSTGRES_SERVER_ERROR", "3D000"), "3D000"],
      [driver("ERR_MYSQL_SERVER_ERROR", 1045), "1045"],
      [driver("ERR_MYSQL_SERVER_ERROR", 1044), "1044"],
      [driver("ERR_MYSQL_SERVER_ERROR", 1049), "1049"],
      [
        driver("ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF2"),
        "ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF2",
      ],
      [
        driver("ERR_REDIS_AUTHENTICATION_FAILED"),
        "ERR_REDIS_AUTHENTICATION_FAILED",
      ],
    ];
    for (const [error, code] of cases) {
      expect(reasonForDatabaseError(error, server)).toMatchObject({
        params: { code, reason: "auth_failed" },
        reason: "auth_failed",
      });
    }
  });

  test("a MySQL server that signs in only over an encrypted connection is TLS required, never a refused password", () => {
    expect(
      reasonForDatabaseError(
        driver("ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED"),
        server
      )
    ).toMatchObject({
      params: { reason: "tls_required" },
      reason: "tls_required",
    });
  });

  test("a query the server refused is query failed with the server's code", () => {
    const cases: [Error, string][] = [
      [driver("ERR_POSTGRES_SERVER_ERROR", "42703"), "42703"],
      [driver("ERR_MYSQL_SERVER_ERROR", 1054), "1054"],
      [driver("ERR_REDIS_SERVER_ERROR"), "ERR_REDIS_SERVER_ERROR"],
    ];
    for (const [error, code] of cases) {
      expect(reasonForDatabaseError(error, server)).toMatchObject({
        params: { code, reason: "query_failed" },
        reason: "query_failed",
      });
    }
  });

  test("a certificate the driver refused is invalid or expired", () => {
    expect(
      reasonForDatabaseError(driver("SELF_SIGNED_CERT_IN_CHAIN", 0), server)
    ).toMatchObject({
      params: {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
        reason: "certificate_invalid",
      },
    });
    expect(
      reasonForDatabaseError(driver("CERT_HAS_EXPIRED"), server).reason
    ).toBe("certificate_expired");
  });

  test("any other driver code, a closed connection or a TLS the server lacks, is connection failed with it", () => {
    for (const code of [
      "ERR_POSTGRES_CONNECTION_CLOSED",
      "ERR_POSTGRES_TLS_NOT_AVAILABLE",
      "ERR_MYSQL_CONNECTION_CLOSED",
      "ERR_REDIS_CONNECTION_CLOSED",
      "ERR_REDIS_INVALID_RESPONSE",
    ]) {
      expect(reasonForDatabaseError(driver(code), server)).toMatchObject({
        params: { code, reason: "connection_failed" },
        reason: "connection_failed",
      });
    }
  });

  test("a TLS name mismatch, which Bun's Postgres driver reports as an empty error, is an invalid certificate", () => {
    expect(
      reasonForDatabaseError(
        Object.assign(new Error("emptied"), { errno: 0, message: "" }),
        server
      )
    ).toMatchObject({
      params: { reason: "certificate_invalid" },
      reason: "certificate_invalid",
    });
  });

  test("an error without a code is unknown with its text", () => {
    expect(reasonForDatabaseError(new Error("odd"), server)).toEqual({
      error: "odd",
      params: { reason: "unknown" },
      reason: "unknown",
    });
  });

  test("the URL and its password are masked in the raw text before its cut", () => {
    const url = "mysql://watcher:hunter2@db.example.test/app";
    const mapped = reasonForDatabaseError(
      driver("ERR_MYSQL_CONNECTION_CLOSED", undefined, `${url} hunter2`),
      server,
      credentialPatterns([url, "hunter2"])
    );
    expect(mapped.error).toBe(`${credentialMask} ${credentialMask}`);
    expect(
      reasonForDatabaseError(driver("X", undefined, "x".repeat(5000)), server)
        .error.length
    ).toBe(errorMaxLength);
  });
});

describe("the reason of a Docker endpoint's error", () => {
  const socket = "/var/run/docker.sock";

  test("a socket that is missing, refused or not the process's to open is connection failed with its code", () => {
    for (const code of ["ENOENT", "ECONNREFUSED", "EACCES"]) {
      expect(
        reasonForDockerError(coded(code, `${code} ${socket}`), socket, 10_000)
      ).toEqual({
        error: `${code} ${socket}`,
        params: { code, reason: "connection_failed" },
        reason: "connection_failed",
      });
    }
  });

  test("a socket that does not answer in time is a timeout", () => {
    const error = new DOMException("The operation timed out.", "TimeoutError");
    expect(reasonForDockerError(error, socket, 3000)).toMatchObject({
      params: { reason: "timeout", timeoutMs: 3000 },
      reason: "timeout",
    });
  });

  test("a URL's errors map as fetch's, naming its host and port, the scheme's port when it names none", () => {
    expect(
      reasonForDockerError(
        coded("ConnectionRefused"),
        "http://proxy.example.test:2375/docker",
        10_000
      ).params
    ).toEqual({
      host: "proxy.example.test",
      port: 2375,
      reason: "connection_refused",
    });
    expect(
      reasonForDockerError(
        coded("ConnectionRefused"),
        "https://proxy.example.test",
        10_000
      ).params
    ).toEqual({
      host: "proxy.example.test",
      port: 443,
      reason: "connection_refused",
    });
    expect(
      reasonForDockerError(coded("ENOTFOUND"), "http://proxy", 10_000).reason
    ).toBe("dns_failed");
  });

  test("an error with no code is unknown with its text", () => {
    expect(reasonForDockerError(new Error("odd"), socket, 10_000)).toEqual({
      error: "odd",
      params: { reason: "unknown" },
      reason: "unknown",
    });
  });
});

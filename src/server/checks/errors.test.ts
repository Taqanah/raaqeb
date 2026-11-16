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
  /** A driver error as Bun 1.4.4 throws one: its own code, and the server's in `errno`. */
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

  test("a server at its connection limit is connection failed with the server's code, since no query ran", () => {
    for (const [code, errno, message] of [
      ["ERR_POSTGRES_SERVER_ERROR", "53300", "sorry, too many clients already"],
      ["ERR_MYSQL_SERVER_ERROR", 1040, "Too many connections"],
    ] as const) {
      expect(
        reasonForDatabaseError(driver(code, errno, message), server)
      ).toMatchObject({
        params: { code: String(errno), reason: "connection_failed" },
        reason: "connection_failed",
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

  test("a MongoDB sign-in the server refused, or one the client could not trust, is auth failed with its code", () => {
    const cases: [Error, string][] = [
      [driver("ERR_MONGODB_AUTHENTICATION_FAILED", "18"), "18"],
      [driver("ERR_MONGODB_AUTHENTICATION_FAILED", "334"), "334"],
      [
        driver("ERR_MONGODB_SASL_SIGNATURE_MISMATCH"),
        "ERR_MONGODB_SASL_SIGNATURE_MISMATCH",
      ],
      [
        driver("ERR_MONGODB_SASL_NONCE_MISMATCH"),
        "ERR_MONGODB_SASL_NONCE_MISMATCH",
      ],
      [
        driver("ERR_MONGODB_SASL_ITERATIONS_TOO_FEW"),
        "ERR_MONGODB_SASL_ITERATIONS_TOO_FEW",
      ],
      [
        driver("ERR_MONGODB_SASL_ITERATIONS_TOO_MANY"),
        "ERR_MONGODB_SASL_ITERATIONS_TOO_MANY",
      ],
      [
        driver("ERR_MONGODB_SASL_INVALID_MESSAGE"),
        "ERR_MONGODB_SASL_INVALID_MESSAGE",
      ],
      [
        driver("ERR_MONGODB_SASL_SERVER_ERROR"),
        "ERR_MONGODB_SASL_SERVER_ERROR",
      ],
      [
        driver("ERR_MONGODB_SASLPREP_PROHIBITED"),
        "ERR_MONGODB_SASLPREP_PROHIBITED",
      ],
    ];
    for (const [error, code] of cases) {
      expect(reasonForDatabaseError(error, server)).toMatchObject({
        params: { code, reason: "auth_failed" },
        reason: "auth_failed",
      });
    }
  });

  test("a MongoDB command the server refused, or one off the read-only list, is query failed with its code", () => {
    expect(
      reasonForDatabaseError(driver("ERR_MONGODB_SERVER_ERROR", "13"), server)
    ).toMatchObject({ params: { code: "13", reason: "query_failed" } });
    expect(
      reasonForDatabaseError(driver("ERR_MONGODB_INVALID_COMMAND"), server)
    ).toMatchObject({
      params: { code: "ERR_MONGODB_INVALID_COMMAND", reason: "query_failed" },
    });
    expect(
      reasonForDatabaseError(driver("ERR_MONGODB_COMMAND_NOT_ALLOWED"), server)
    ).toMatchObject({
      params: {
        code: "ERR_MONGODB_COMMAND_NOT_ALLOWED",
        reason: "query_failed",
      },
    });
  });

  test("an SRV name with no record is DNS failed with the name", () => {
    expect(reasonForDatabaseError(driver("ENODATA"), server)).toMatchObject({
      params: { host: "db.example.test", reason: "dns_failed" },
    });
  });

  test("a MongoDB server that closed a plain connection before its hello is TLS required", () => {
    expect(
      reasonForDatabaseError(driver("ERR_MONGODB_TLS_REQUIRED"), server)
    ).toMatchObject({ params: { reason: "tls_required" } });
  });

  test("an SRV answer the client refused is connection failed with its code, a reply it could not read too", () => {
    for (const code of ["ERR_MONGODB_SRV_INVALID", "ERR_MONGODB_PROTOCOL"]) {
      expect(reasonForDatabaseError(driver(code), server)).toMatchObject({
        params: { code, reason: "connection_failed" },
      });
    }
  });

  test("a certificate that names another host is an invalid certificate with the driver's code", () => {
    expect(
      reasonForDatabaseError(
        Object.assign(
          new Error("Hostname/IP does not match certificate's altnames"),
          { code: "ERR_TLS_CERT_ALTNAME_INVALID", errno: 0 }
        ),
        server
      )
    ).toMatchObject({
      params: {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
        reason: "certificate_invalid",
      },
      reason: "certificate_invalid",
    });
  });

  test("an empty error is unknown, not a certificate", () => {
    expect(
      reasonForDatabaseError(
        Object.assign(new Error("emptied"), { errno: 0, message: "" }),
        server
      )
    ).toMatchObject({ reason: "unknown" });
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

describe("the reason of a fetch error on a request that carried a client certificate", () => {
  test("a connection the server closed during the handshake is the client certificate refused, with the driver's code", () => {
    for (const code of ["ECONNRESET", "ConnectionClosed"]) {
      expect(
        reasonForError(coded(code), target, [], { clientCertificate: true })
      ).toMatchObject({
        params: { code, reason: "client_certificate_refused" },
        reason: "client_certificate_refused",
      });
    }
  });

  test("the same code on a request with none is a connection failure, as it was", () => {
    expect(reasonForError(coded("ECONNRESET"), target)).toMatchObject({
      reason: "connection_failed",
    });
  });

  test("every other error keeps its reason, a server certificate problem and a refused port among them", () => {
    for (const [code, reason] of [
      ["ECONNREFUSED", "connection_refused"],
      ["ENOTFOUND", "dns_failed"],
      ["CERT_HAS_EXPIRED", "certificate_expired"],
      ["SELF_SIGNED_CERT_IN_CHAIN", "certificate_invalid"],
      ["EHOSTUNREACH", "connection_failed"],
    ] as const) {
      expect(
        reasonForError(coded(code), target, [], { clientCertificate: true })
      ).toMatchObject({ reason });
    }
  });
});

describe("the reason of a fetch error on a request that went through a proxy", () => {
  /** Bun 1.4.3's error for a CONNECT the proxy answered with anything but 200. */
  function tunnelRefused(status: number, text: string): Error {
    return Object.assign(
      new Error(`Proxy refused to open a tunnel: ${status} ${text}`),
      { code: "ERR_PROXY_TUNNEL", status, statusText: text }
    );
  }

  test("a tunnel the proxy would not open is the proxy's failure with the status it answered, never unknown", () => {
    expect(
      reasonForError(tunnelRefused(502, "Bad Gateway"), target, [], {
        proxied: true,
      })
    ).toEqual({
      error: "Proxy refused to open a tunnel: 502 Bad Gateway",
      params: { reason: "proxy_failed", status: 502 },
      reason: "proxy_failed",
    });
  });

  test("a tunnel refusal is the proxy's even when the proxy in use was not known, since only a proxy opens one", () => {
    expect(
      reasonForError(
        tunnelRefused(407, "Proxy Authentication Required"),
        target
      )
    ).toMatchObject({
      params: { reason: "proxy_failed", status: 407 },
      reason: "proxy_failed",
    });
  });

  test("a tunnel refusal names any status from 100 to 599", () => {
    for (const status of [100, 599]) {
      const error = Object.assign(new Error("Proxy refused"), {
        code: "ERR_PROXY_TUNNEL",
        status,
      });
      expect(reasonForError(error, target).params).toEqual({
        reason: "proxy_failed",
        status,
      });
    }
  });

  test("a tunnel refusal without a usable status names none", () => {
    for (const status of [undefined, 0, 600, "502"]) {
      const error = Object.assign(new Error("Proxy refused"), {
        code: "ERR_PROXY_TUNNEL",
        status,
      });
      expect(reasonForError(error, target).params).toEqual({
        reason: "proxy_failed",
      });
    }
  });

  test("a refused connection or a name that does not resolve is the proxy's, the only peer the request connected to, and names no status", () => {
    for (const code of ["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND"]) {
      expect(
        reasonForError(coded(code), target, [], { proxied: true })
      ).toEqual({
        error: code,
        params: { reason: "proxy_failed" },
        reason: "proxy_failed",
      });
    }
  });

  test("a timeout, a reset and a certificate problem keep their reasons, since through a tunnel they may be the target's", () => {
    for (const [error, reason] of [
      [new DOMException("timed out", "TimeoutError"), "timeout"],
      [coded("ECONNRESET"), "connection_failed"],
      [coded("CERT_HAS_EXPIRED"), "certificate_expired"],
    ] as const) {
      expect(
        reasonForError(error, target, [], { proxied: true })
      ).toMatchObject({ reason });
    }
  });
});

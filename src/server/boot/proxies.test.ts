import { describe, expect, test } from "bun:test";
import { clientAddress, isProxyEntry, requestOrigin } from "./proxies.ts";

describe("a trusted proxy entry", () => {
  test.each([
    "10.0.0.1",
    "10.0.0.0/8",
    "192.168.1.0/24",
    "0.0.0.0/0",
    "::1",
    "fd00::/8",
    "2001:db8::1/128",
    "::ffff:10.0.0.1",
  ])("accepts %s", (entry) => {
    expect(isProxyEntry(entry)).toBe(true);
  });

  test.each([
    ["a host name", "proxy.internal"],
    ["a port", "10.0.0.1:80"],
    ["an out-of-range octet", "10.0.0.256"],
    ["three octets", "10.0.0"],
    ["a prefix over 32", "10.0.0.0/33"],
    ["a prefix over 128", "::1/129"],
    ["a negative prefix", "10.0.0.0/-1"],
    ["a bare prefix", "/8"],
    ["a bad IPv6", "fd00:::1"],
    ["a URL", "http://10.0.0.1"],
    ["empty", ""],
    ["space inside", "10.0.0.1 /8"],
  ])("refuses %s", (_label, entry) => {
    expect(isProxyEntry(entry)).toBe(false);
  });
});

describe("the client address behind the trusted proxies", () => {
  test("is the socket peer when no proxy is trusted, whatever the forwarded header says", () => {
    expect(clientAddress("203.0.113.9", "1.2.3.4", [])).toBe("203.0.113.9");
  });

  test("is the socket peer when the peer is not a trusted proxy", () => {
    expect(clientAddress("203.0.113.9", "1.2.3.4", ["10.0.0.0/8"])).toBe(
      "203.0.113.9"
    );
  });

  test("walks the forwarded chain from its end past the trusted hops to the first address that is not one", () => {
    expect(
      clientAddress("10.0.0.1", "1.2.3.4, 5.6.7.8, 10.0.0.2", ["10.0.0.0/8"])
    ).toBe("5.6.7.8");
  });

  test("a chain of only trusted hops, or no chain, answers the peer", () => {
    expect(clientAddress("10.0.0.1", "10.0.0.2", ["10.0.0.0/8"])).toBe(
      "10.0.0.1"
    );
    expect(clientAddress("10.0.0.1", null, ["10.0.0.0/8"])).toBe("10.0.0.1");
    expect(clientAddress("10.0.0.1", " , ", ["10.0.0.0/8"])).toBe("10.0.0.1");
  });

  test("a forwarded entry that is not an address stops the walk at the peer", () => {
    expect(clientAddress("10.0.0.1", "evil", ["10.0.0.1"])).toBe("10.0.0.1");
  });

  test("matches IPv6 peers and ranges, and an IPv4-mapped IPv6 peer against an IPv4 range", () => {
    expect(clientAddress("fd00::1", "2001:db8::9", ["fd00::/8"])).toBe(
      "2001:db8::9"
    );
    expect(clientAddress("::ffff:10.0.0.1", "1.2.3.4", ["10.0.0.0/8"])).toBe(
      "1.2.3.4"
    );
  });

  test("is nothing when the peer is unknown", () => {
    expect(clientAddress(undefined, "1.2.3.4", ["10.0.0.0/8"])).toBeUndefined();
  });
});

describe("the origin the client used, behind the trusted proxies", () => {
  const url = "http://127.0.0.1:3000/onboarding/account";

  test("is the request URL's origin when no proxy is trusted, whatever the forwarded headers say", () => {
    expect(
      requestOrigin(url, "203.0.113.9", "https", "status.example.test", [])
    ).toBe("http://127.0.0.1:3000");
  });

  test("is the forwarded scheme and host when the peer is a trusted proxy", () => {
    expect(
      requestOrigin(url, "127.0.0.1", "https", "status.example.test", [
        "127.0.0.1",
      ])
    ).toBe("https://status.example.test");
  });

  test("keeps a forwarded port and takes the first value of a list", () => {
    expect(
      requestOrigin(
        url,
        "10.0.0.2",
        "https, http",
        "status.example.test:8443, other",
        ["10.0.0.0/8"]
      )
    ).toBe("https://status.example.test:8443");
  });

  test("is the request URL's origin when a trusted proxy forwards nothing", () => {
    expect(requestOrigin(url, "127.0.0.1", null, null, ["127.0.0.1"])).toBe(
      "http://127.0.0.1:3000"
    );
  });

  test("takes the forwarded host alone, with the request's scheme", () => {
    expect(
      requestOrigin(url, "127.0.0.1", null, "status.example.test", [
        "127.0.0.1",
      ])
    ).toBe("http://status.example.test");
  });

  test("drops an explicit default port, as an origin does", () => {
    expect(
      requestOrigin(url, "127.0.0.1", "https", "status.example.test:443", [
        "127.0.0.1",
      ])
    ).toBe("https://status.example.test");
    expect(
      requestOrigin(url, "127.0.0.1", "http", "status.example.test:80", [
        "127.0.0.1",
      ])
    ).toBe("http://status.example.test");
  });

  test("lower-cases the forwarded host, as an origin is", () => {
    expect(
      requestOrigin(url, "127.0.0.1", "https", "Status.Example.TEST", [
        "127.0.0.1",
      ])
    ).toBe("https://status.example.test");
  });

  test("is nothing when a forwarded value is not a scheme or a host", () => {
    expect(
      requestOrigin(url, "127.0.0.1", "javascript", "status.example.test", [
        "127.0.0.1",
      ])
    ).toBeUndefined();
    expect(
      requestOrigin(url, "127.0.0.1", "https", "a b/c", ["127.0.0.1"])
    ).toBeUndefined();
    // A host the parser would repair into a host and a path is not a host.
    expect(
      requestOrigin(url, "127.0.0.1", "https", "status.example.test/admin", [
        "127.0.0.1",
      ])
    ).toBeUndefined();
  });

  test("is nothing when the peer is unknown", () => {
    expect(
      requestOrigin(url, undefined, "https", "h", ["127.0.0.1"])
    ).toBeUndefined();
  });
});

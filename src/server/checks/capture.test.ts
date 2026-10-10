import { describe, expect, test } from "bun:test";
import { captureBodyBytes } from "@/shared/schemas/check.ts";
import {
  captureOf,
  credentialMask,
  credentialPatterns,
  isRedactedHeader,
  keepsCapture,
  maskCredentials,
  maskCredentialText,
  redactHeaders,
} from "./capture.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("header redaction in a capture", () => {
  test("set-cookie and any name containing auth, token, key or cookie lose their value", () => {
    for (const name of [
      "Set-Cookie",
      "Authorization",
      "WWW-Authenticate",
      "X-Auth-Token",
      "X-Api-Key",
      "Cookie",
      "x-csrf-token",
      "X-KEY",
    ]) {
      expect(isRedactedHeader(name)).toBe(true);
    }
    for (const name of [
      "Content-Type",
      "Cache-Control",
      "X-Request-Id",
      "Server",
      "Content-Length",
    ]) {
      expect(isRedactedHeader(name)).toBe(false);
    }
  });

  test("the headers are listed by name, lower-cased, and a redacted one keeps no value", () => {
    const headers = new Headers();
    headers.append("Content-Type", "text/html");
    headers.append("Set-Cookie", "session=abc");
    headers.append("X-Api-Key", "secret");
    expect(redactHeaders(headers)).toEqual([
      { name: "content-type", value: "text/html" },
      { name: "set-cookie", value: undefined },
      { name: "x-api-key", value: undefined },
    ]);
  });
});

describe("the capture mode", () => {
  test("off keeps nothing, on failure keeps down checks only, always keeps every check", () => {
    expect(keepsCapture("off", "down")).toBe(false);
    expect(keepsCapture("on_failure", "down")).toBe(true);
    expect(keepsCapture("on_failure", "degraded")).toBe(false);
    expect(keepsCapture("on_failure", "up")).toBe(false);
    expect(keepsCapture("always", "up")).toBe(true);
    expect(keepsCapture("always", "degraded")).toBe(true);
    expect(keepsCapture("always", "down")).toBe(true);
  });
});

describe("a capture", () => {
  test("keeps the first 4 KB of the body and the redacted headers", () => {
    const body = new Uint8Array(10_000).fill(7);
    const capture = captureOf(
      { monitorId: "m1", startedAt: 5 },
      new Headers({ "content-type": "text/plain", authorization: "Bearer x" }),
      body
    );
    expect(capture.body.byteLength).toBe(captureBodyBytes);
    expect(capture.body[0]).toBe(7);
    expect(capture.headers).toEqual([
      { name: "authorization", value: undefined },
      { name: "content-type", value: "text/plain" },
    ]);
    expect(capture.monitorId).toBe("m1");
    expect(capture.startedAt).toBe(5);
  });

  test("a body under the cap is kept whole", () => {
    const capture = captureOf(
      { monitorId: "m1", startedAt: 5 },
      new Headers(),
      new Uint8Array([1, 2, 3])
    );
    expect(Array.from(capture.body)).toEqual([1, 2, 3]);
  });
});

describe("a credential the response repeats", () => {
  const key = { monitorId: "m1", startedAt: 5 };

  test("is masked in the body and in every header value a capture keeps", () => {
    const capture = captureOf(
      key,
      new Headers({ "x-echo": "Bearer tok-secret", "x-other": "plain" }),
      encoder.encode('{"authenticated":true,"token":"tok-secret"}'),
      credentialPatterns(["tok-secret"])
    );
    expect(decoder.decode(capture.body)).toBe(
      `{"authenticated":true,"token":"${credentialMask}"}`
    );
    expect(capture.headers).toEqual([
      { name: "x-echo", value: `Bearer ${credentialMask}` },
      { name: "x-other", value: "plain" },
    ]);
  });

  test("straddling the 4 KB cut leaves no part of itself in the kept body", () => {
    const secret = "straddling-secret";
    for (
      let start = captureBodyBytes - secret.length + 1;
      start < captureBodyBytes;
      start += 1
    ) {
      const before = "x".repeat(start);
      const capture = captureOf(
        key,
        new Headers(),
        encoder.encode(`${before}${secret}${"y".repeat(100)}`),
        credentialPatterns([secret])
      );
      expect(decoder.decode(capture.body)).toBe(
        `${before}${credentialMask}${"y".repeat(100)}`.slice(
          0,
          captureBodyBytes
        )
      );
    }
  });

  test("a mask shorter than its credential lets the body after it fill the 4 KB", () => {
    const secret = "s".repeat(500);
    const capture = captureOf(
      key,
      new Headers(),
      encoder.encode(`${secret}${"z".repeat(captureBodyBytes)}`),
      credentialPatterns([secret])
    );
    expect(decoder.decode(capture.body)).toBe(
      `${credentialMask}${"z".repeat(captureBodyBytes - credentialMask.length)}`
    );
  });

  test("two credentials that overlap become one mask, so neither leaves a part of itself", () => {
    expect(
      maskCredentialText("[abcdef]", credentialPatterns(["abcd", "cdef"]))
    ).toBe(`[${credentialMask}]`);
    expect(
      maskCredentialText(
        "x supersecret123 y",
        credentialPatterns(["123", "supersecret123"])
      )
    ).toBe(`x ${credentialMask} y`);
  });

  test("a credential inside a longer one that ends before it leaves no tail of the longer one", () => {
    expect(
      maskCredentialText(
        "x supersecret123 y",
        credentialPatterns(["secret", "supersecret123"])
      )
    ).toBe(`x ${credentialMask} y`);
  });

  test("occurrences of one credential that overlap each other leave no part of it", () => {
    expect(maskCredentialText("ababab", credentialPatterns(["abab"]))).toBe(
      credentialMask
    );
  });

  test("each occurrence is masked, and two that touch become one mask", () => {
    expect(maskCredentialText("a-tok-b-tok", credentialPatterns(["tok"]))).toBe(
      `a-${credentialMask}-b-${credentialMask}`
    );
    expect(maskCredentialText("toktok", credentialPatterns(["tok"]))).toBe(
      credentialMask
    );
  });

  test("as written inside a JSON string is masked too", () => {
    const secret = 'pa"ss\\word';
    expect(
      maskCredentialText(
        JSON.stringify({ password: secret }),
        credentialPatterns([secret])
      )
    ).toBe(`{"password":"${credentialMask}"}`);
  });

  test("as written inside a JSON string with its slashes escaped, as PHP writes base64, is masked too", () => {
    expect(
      maskCredentialText(
        '{"pair":"b3BzOnBh\\/c3M="}',
        credentialPatterns(["b3BzOnBh/c3M="])
      )
    ).toBe(`{"pair":"${credentialMask}"}`);
  });

  test("outside ASCII is masked by its UTF-8 bytes", () => {
    expect(
      maskCredentialText("كلمة السر: سري", credentialPatterns(["سري"]))
    ).toBe(`كلمة السر: ${credentialMask}`);
  });

  test("an empty credential masks nothing, and a body repeating none is kept byte for byte", () => {
    const binary = new Uint8Array([0xff, 0x00, 0xfe, 0x74, 0x6f, 0x6b]);
    expect(credentialPatterns(["", "tok"])).toHaveLength(1);
    expect(
      Array.from(maskCredentials(binary, credentialPatterns(["", "absent"])))
    ).toEqual(Array.from(binary));
    expect(
      Array.from(maskCredentials(binary, credentialPatterns(["tok"])))
    ).toEqual([0xff, 0x00, 0xfe, ...encoder.encode(credentialMask)]);
  });
});

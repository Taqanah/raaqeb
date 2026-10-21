import { describe, expect, test } from "bun:test";
import {
  cleanHeartbeatMessage,
  heartbeatMessageMaxLength,
  heartbeatTokenSchema,
  heartbeatUrl,
} from "./heartbeat.ts";

const token = "AbCdEfGhIjKlMnOpQrSt-_";

describe("a heartbeat monitor's unique URL", () => {
  test("is the origin, the heartbeat path and the token", () => {
    expect(heartbeatUrl("https://status.example.test", token)).toBe(
      `https://status.example.test/api/heartbeat/${token}`
    );
  });

  test("an origin written with a trailing slash gives the same URL", () => {
    expect(heartbeatUrl("https://status.example.test/", token)).toBe(
      `https://status.example.test/api/heartbeat/${token}`
    );
  });

  test("a token is 22 base64url characters; anything else is not one", () => {
    expect(heartbeatTokenSchema.safeParse(token).success).toBe(true);
    for (const other of [
      "",
      token.slice(1),
      `${token}A`,
      "AbCdEfGhIjKlMnOpQrSt+/",
      "AbCdEfGhIjKlMnOpQrSt%2",
    ]) {
      expect(heartbeatTokenSchema.safeParse(other).success).toBe(false);
    }
  });
});

describe("a failing heartbeat's message", () => {
  test("is one line: control characters and runs of whitespace become one space, and the ends are trimmed", () => {
    expect(cleanHeartbeatMessage("  disk\n\tfull \u0000 on /var\r\n ")).toBe(
      "disk full on /var"
    );
  });

  test("is cut to the longest length kept, counted in characters, never through one", () => {
    expect(cleanHeartbeatMessage("a".repeat(400))).toBe(
      "a".repeat(heartbeatMessageMaxLength)
    );
    // An emoji is two UTF-16 units and one character.
    expect(cleanHeartbeatMessage("😀".repeat(300))).toBe(
      "😀".repeat(heartbeatMessageMaxLength)
    );
  });

  test("a cut that lands after a space leaves no space at the end", () => {
    expect(cleanHeartbeatMessage(`${"a".repeat(255)} bcd`)).toBe(
      "a".repeat(255)
    );
  });

  test("format characters that reorder or hide text are dropped: a right-to-left override, an isolate, a zero-width space", () => {
    expect(cleanHeartbeatMessage("ok\u202Efail\u2066x\u2069\u200Bz")).toBe(
      "okfailxz"
    );
  });

  test("an Arabic message stays as written", () => {
    expect(cleanHeartbeatMessage("فشل النسخ الاحتياطي")).toBe(
      "فشل النسخ الاحتياطي"
    );
  });

  test("an empty or blank message is no message", () => {
    expect(cleanHeartbeatMessage("")).toBeUndefined();
    expect(cleanHeartbeatMessage(" \n\t\u0007 ")).toBeUndefined();
  });
});

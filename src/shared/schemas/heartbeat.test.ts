import { describe, expect, test } from "bun:test";
import { heartbeatTokenSchema, heartbeatUrl } from "./heartbeat.ts";

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

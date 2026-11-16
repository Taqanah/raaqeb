import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { scratchPages, testAddress } from "@/server/pages/fixture.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import {
  hashMetricsToken,
  judge,
  makeMetricsToken,
  metricsTokenHash,
  newMetricsToken,
  readMetrics,
  turnMetricsOff,
} from "./token.ts";

const tokenShape = /^rqm_[A-Za-z0-9_-]{43}$/;

let scratch: Awaited<ReturnType<typeof scratchPages>> | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

async function storage() {
  scratch = await scratchPages();
  return scratch.storage;
}

async function tokenOf(store: Awaited<ReturnType<typeof storage>>) {
  const made = await makeMetricsToken(store);
  if (!made.ok) {
    throw new Error("no token made");
  }
  return made.token;
}

describe("the metrics token", () => {
  test("a token is long, random and marked as Raaqeb's, and its hash is the SHA-256 in hex", () => {
    const first = newMetricsToken();
    expect(first).toMatch(tokenShape);
    expect(newMetricsToken()).not.toBe(first);
    expect(hashMetricsToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  test("the endpoint is off until a token is made", async () => {
    const store = await storage();
    expect(await readMetrics(store)).toEqual({
      address: `${testAddress}/metrics`,
      on: false,
    });
    expect(await judge(store, "Bearer anything")).toBe("off");
    expect(await judge(store, null)).toBe("off");
  });

  test("making a token turns it on and stores its hash, never the token", async () => {
    const store = await storage();
    const token = await tokenOf(store);
    expect((await readMetrics(store)).on).toBe(true);
    expect(await store.settings.get(metricsTokenHash)).toBe(
      hashMetricsToken(token)
    );
  });

  test("only the token in a bearer header is granted", async () => {
    const store = await storage();
    const token = await tokenOf(store);
    expect(await judge(store, `Bearer ${token}`)).toBe("granted");
    expect(await judge(store, `bearer ${token}`)).toBe("granted");
    expect(await judge(store, `Bearer ${token}x`)).toBe("denied");
    expect(await judge(store, `Bearer ${token.slice(0, -1)}`)).toBe("denied");
    expect(await judge(store, "Bearer ")).toBe("denied");
    expect(await judge(store, token)).toBe("denied");
    expect(await judge(store, `Basic ${token}`)).toBe("denied");
    expect(await judge(store, null)).toBe("denied");
  });

  test("making another token stops the old one at once", async () => {
    const store = await storage();
    const old = await tokenOf(store);
    const fresh = await tokenOf(store);
    expect(fresh).not.toBe(old);
    expect(await judge(store, `Bearer ${old}`)).toBe("denied");
    expect(await judge(store, `Bearer ${fresh}`)).toBe("granted");
  });

  test("turning it off forgets the token, and the old one is not granted if it is turned on again", async () => {
    const store = await storage();
    const old = await tokenOf(store);
    expect(await turnMetricsOff(store)).toEqual({ ok: true });
    expect((await readMetrics(store)).on).toBe(false);
    expect(await judge(store, `Bearer ${old}`)).toBe("off");
    await tokenOf(store);
    expect(await judge(store, `Bearer ${old}`)).toBe("denied");
  });

  test("a stored hash that is not a hash reads as off, and a new token repairs it", async () => {
    const store = await storage();
    await store.settings.set(
      defineSetting(metricsTokenHash.key, z.unknown()),
      "not a hash"
    );
    expect(await judge(store, "Bearer x")).toBe("off");
    expect((await readMetrics(store)).on).toBe(false);
    const token = await tokenOf(store);
    expect(await judge(store, `Bearer ${token}`)).toBe("granted");
  });

  test("the address waits for a public address", async () => {
    const store = await storage();
    await store.settings.remove(publicAddress);
    expect((await readMetrics(store)).address).toBeUndefined();
  });

  test("a database that does not answer makes no token and turns nothing off", async () => {
    const store = await storage();
    const broken = {
      settings: {
        ...store.settings,
        get: () => Promise.reject(new Error("down")),
        remove: () => Promise.reject(new Error("down")),
        set: () => Promise.reject(new Error("down")),
      },
    };
    expect(await makeMetricsToken(broken)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await turnMetricsOff(broken)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

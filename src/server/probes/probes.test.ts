import { afterEach, describe, expect, test } from "bun:test";
import { scratchPages, testAddress } from "@/server/pages/fixture.ts";
import { probesMax } from "@/shared/schemas/monitor.ts";
import {
  hashProbeToken,
  makeProbe,
  newProbeToken,
  readProbes,
  removeProbe,
  replaceProbeToken,
} from "./probes.ts";

const tokenShape = /^rqp_[A-Za-z0-9_-]{43}$/;

let scratch: Awaited<ReturnType<typeof scratchPages>> | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

async function storage() {
  scratch = await scratchPages();
  return scratch.storage;
}

describe("a probe token", () => {
  test("is long, random and marked as Raaqeb's, and its hash is the SHA-256 in hex", () => {
    const first = newProbeToken();
    expect(first).toMatch(tokenShape);
    expect(newProbeToken()).not.toBe(first);
    expect(hashProbeToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("the probes an operator manages", () => {
  test("a probe is made with its name and answers its token once; only the token's hash is stored", async () => {
    const store = await storage();
    const made = await makeProbe(store, "  Frankfurt ");
    if (!made.ok) {
      throw new Error("no probe made");
    }
    expect(made.token).toMatch(tokenShape);
    expect(made.probe.name).toBe("Frankfurt");
    expect(
      (await store.probes.byTokenHash(hashProbeToken(made.token)))?.id
    ).toBe(made.probe.id);
    const read = await readProbes(store, 5);
    expect(read).toEqual({
      address: testAddress,
      now: 5,
      ok: true,
      probes: [made.probe],
      refused: [],
    });
    const refused = await readProbes(store, 5, (id) => id === made.probe.id);
    expect(refused.ok && refused.refused).toEqual([made.probe.id]);
    expect(JSON.stringify(read)).not.toContain(made.token);
  });

  test("making a probe moves the change counter, so the scheduler reads its name", async () => {
    const store = await storage();
    const before = await store.changeCounter();
    await makeProbe(store, "Frankfurt");
    expect(await store.changeCounter()).toBeGreaterThan(before);
  });

  test("an install holds at most as many probes as a monitor may name", async () => {
    const store = await storage();
    for (let made = 0; made < probesMax; made += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one probe after another
      await makeProbe(store, `Probe ${made}`);
    }
    expect(await makeProbe(store, "One more")).toEqual({
      ok: false,
      reason: "full",
    });
  });

  test("a new token stops the old one at once", async () => {
    const store = await storage();
    const made = await makeProbe(store, "Frankfurt");
    if (!made.ok) {
      throw new Error("no probe made");
    }
    const renewed = await replaceProbeToken(store, made.probe.id);
    if (!renewed.ok) {
      throw new Error("no token made");
    }
    expect(renewed.token).not.toBe(made.token);
    expect(await store.probes.byTokenHash(hashProbeToken(made.token))).toBe(
      undefined
    );
    expect(
      (await store.probes.byTokenHash(hashProbeToken(renewed.token)))?.id
    ).toBe(made.probe.id);
  });

  test("a new token or a delete for a probe that does not exist is not found", async () => {
    const store = await storage();
    expect(await replaceProbeToken(store, "nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await removeProbe(store, "nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("deleting a probe stops its token and moves the change counter", async () => {
    const store = await storage();
    const made = await makeProbe(store, "Frankfurt");
    if (!made.ok) {
      throw new Error("no probe made");
    }
    const before = await store.changeCounter();
    expect(await removeProbe(store, made.probe.id)).toEqual({ ok: true });
    expect(await store.probes.byTokenHash(hashProbeToken(made.token))).toBe(
      undefined
    );
    expect(await store.changeCounter()).toBeGreaterThan(before);
  });

  test("a database that does not answer is unavailable", async () => {
    const store = await storage();
    await scratch?.cleanup();
    scratch = undefined;
    expect(await makeProbe(store, "Frankfurt")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await readProbes(store, 1)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

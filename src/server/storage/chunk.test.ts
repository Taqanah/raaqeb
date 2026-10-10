import { describe, expect, test } from "bun:test";
import type { Check } from "@/shared/schemas/check.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  ChunkFormatError,
  checkAt,
  chunkVersion,
  decodeChunk,
  encodeChunk,
} from "./chunk.ts";

/** A UTC day's start. */
const day = 1_700_006_400_000;
const dayMs = 86_400_000;

function check(fields: Partial<Check> & Pick<Check, "startedAt">): Check {
  return {
    attempts: 1,
    bytes: 512,
    monitorId: "m",
    reason: reasons.ok,
    responseMs: 120,
    result: "up",
    statusCode: 200,
    ...fields,
  };
}

/** The three checks of the hand-made chunk below. */
const three: Check[] = [
  check({ startedAt: day + 1000 }),
  check({
    bytes: 600,
    reason: reasons.slow,
    responseMs: 900,
    result: "degraded",
    startedAt: day + 21_000,
  }),
  check({
    attempts: 3,
    bytes: 0,
    reason: reasons.timeout,
    responseMs: undefined,
    result: "down",
    startedAt: day + 41_500,
    statusCode: undefined,
  }),
];

/** Version 1's payload for `three`, laid out by hand from the format's comment in chunk.ts. */
const threePayload = new Uint8Array([
  // the check count
  0x03,
  // started-at: offsets 1000, 21000, 41500; deltas 1000, 20000, 20500; delta of deltas 1000, 19000, 500; zigzag 2000, 38000, 1000
  0xd0,
  0x0f, 0xf0, 0xa8, 0x02, 0xe8, 0x07,
  // the response time plus one: 121, 901, 0; deltas 121, 780, -901; zigzag 242, 1560, 1801
  0xf2,
  0x01, 0x98, 0x0c, 0x89, 0x0e,
  // the bytes read: 512, 600, 0; deltas 512, 88, -600; zigzag 1024, 176, 1199
  0x80, 0x08, 0xb0, 0x01, 0xaf, 0x09,
  // the result: up, degraded, down
  0x00, 0x01, 0x02,
  // the reason: ok, slow, timeout
  0x00, 0x09, 0x01,
  // the attempts
  0x01, 0x01, 0x03,
  // the status code, little-endian: 200, 200, none
  0xc8, 0x00, 0xc8, 0x00, 0x00, 0x00,
]);

function chunkOf(version: number, payload: Uint8Array): Uint8Array {
  const compressed = Bun.zstdCompressSync(payload, { level: 3 });
  const chunk = new Uint8Array(1 + compressed.length);
  chunk[0] = version;
  chunk.set(compressed, 1);
  return chunk;
}

function checksOf(chunk: Uint8Array): (Check | undefined)[] {
  const columns = decodeChunk(day, chunk);
  return Array.from(columns.startedAt, (_, index) =>
    checkAt(columns, index, "m")
  );
}

function resultOfKind(kind: number): Check["result"] {
  if (kind === 3) {
    return "down";
  }
  return kind === 4 ? "degraded" : "up";
}

function statusOfKind(kind: number): number {
  return kind === 6 ? 503 : 200;
}

/** A 20-second monitor's day with every kind of check in it, and times that wander. */
function fullDay(): Check[] {
  const checks: Check[] = [];
  let at = day;
  for (let index = 0; at < day + dayMs; index += 1) {
    const kind = index % 97;
    const failed = kind === 3;
    checks.push(
      check({
        attempts: failed ? 11 : 1 + (index % 2),
        bytes: kind === 5 ? 1_048_576 : 400 + ((index * 37) % 300),
        reason: failed ? reasons.timeout : reasons.ok,
        responseMs: kind === 7 ? undefined : 50 + ((index * 53) % 60_000),
        result: resultOfKind(kind),
        startedAt: at,
        statusCode: failed ? undefined : statusOfKind(kind),
      })
    );
    at += 20_000 + ((index * 7919) % 900);
  }
  return checks;
}

describe("the chunk, version 1", () => {
  test("a chunk laid out by hand from the format decodes to its checks", () => {
    expect(checksOf(chunkOf(1, threePayload))).toEqual(three);
  });

  test("the encoder writes the version byte, then zstd over exactly the documented payload", () => {
    const chunk = encodeChunk(day, three);
    expect(chunkVersion).toBe(1);
    expect(chunk[0]).toBe(1);
    expect(new Uint8Array(Bun.zstdDecompressSync(chunk.subarray(1)))).toEqual(
      threePayload
    );
  });

  test("a sealed day decodes to the exact checks that were sealed", () => {
    const checks = fullDay();
    expect(checks.length).toBeGreaterThan(4000);
    expect(checksOf(encodeChunk(day, checks))).toEqual(checks);
  });

  test("a check at the day's first and at its last millisecond, and a day of one check, round-trip", () => {
    const edges = [
      check({ startedAt: day }),
      check({ startedAt: day + dayMs - 1 }),
    ];
    expect(checksOf(encodeChunk(day, edges))).toEqual(edges);
    const one = [check({ startedAt: day + 5 })];
    expect(checksOf(encodeChunk(day, one))).toEqual(one);
  });

  test("the columns carry none as -1 for a response time and 0 for a status code", () => {
    const columns = decodeChunk(day, chunkOf(1, threePayload));
    expect(Array.from(columns.responseMs)).toEqual([120, 900, -1]);
    expect(Array.from(columns.statusCode)).toEqual([200, 200, 0]);
  });
});

describe("what the decoder refuses", () => {
  test("a version this build does not know", () => {
    expect(() => decodeChunk(day, chunkOf(2, threePayload))).toThrow(
      ChunkFormatError
    );
    expect(() => decodeChunk(day, chunkOf(0, threePayload))).toThrow(
      ChunkFormatError
    );
  });

  test("bytes that are not a chunk: none at all, not zstd, a payload cut short, a payload with bytes left over", () => {
    expect(() => decodeChunk(day, new Uint8Array())).toThrow(ChunkFormatError);
    expect(() => decodeChunk(day, new Uint8Array([1, 2, 3, 4]))).toThrow(
      ChunkFormatError
    );
    expect(() =>
      decodeChunk(day, chunkOf(1, threePayload.subarray(0, 30)))
    ).toThrow(ChunkFormatError);
    expect(() =>
      decodeChunk(day, chunkOf(1, new Uint8Array([...threePayload, 0])))
    ).toThrow(ChunkFormatError);
  });

  test("a stored result or reason code this version does not know reads as nothing, not as a check", () => {
    const unknownResult = threePayload.slice();
    unknownResult[20] = 3;
    const unknownReason = threePayload.slice();
    unknownReason[23] = 250;
    const results = decodeChunk(day, chunkOf(1, unknownResult));
    const reasonsRead = decodeChunk(day, chunkOf(1, unknownReason));
    expect(checkAt(results, 0, "m")).toBeUndefined();
    expect([checkAt(results, 1, "m")]).toEqual(three.slice(1, 2));
    expect(checkAt(reasonsRead, 0, "m")).toBeUndefined();
  });
});

describe("what the encoder refuses", () => {
  test("a check outside the day, and checks out of order or sharing a millisecond", () => {
    expect(() => encodeChunk(day, [check({ startedAt: day - 1 })])).toThrow(
      RangeError
    );
    expect(() => encodeChunk(day, [check({ startedAt: day + dayMs })])).toThrow(
      RangeError
    );
    expect(() =>
      encodeChunk(day, [
        check({ startedAt: day + 10 }),
        check({ startedAt: day + 5 }),
      ])
    ).toThrow(RangeError);
    expect(() =>
      encodeChunk(day, [
        check({ startedAt: day + 10 }),
        check({ startedAt: day + 10 }),
      ])
    ).toThrow(RangeError);
  });

  test("a value that does not fit its column: attempts past a byte, a status code past two", () => {
    expect(() =>
      encodeChunk(day, [check({ attempts: 256, startedAt: day })])
    ).toThrow(RangeError);
    expect(() =>
      encodeChunk(day, [check({ startedAt: day, statusCode: 65_536 })])
    ).toThrow(RangeError);
  });
});

describe("what a sealed day costs", () => {
  /** A seeded generator, so the size is the same on every run. */
  function seeded(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  test("a 20-second monitor's day, with times that wander and sizes that vary, packs under 7 bytes a check (ADR-0005)", () => {
    const random = seeded(17);
    const checks: Check[] = [];
    for (let at = day + 3000; at < day + dayMs; at += 20_000) {
      const u = Math.max(random(), 1e-9);
      const noise =
        Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
      checks.push(
        check({
          bytes: Math.round(5120 * (0.97 + 0.06 * random())),
          responseMs: Math.round(Math.exp(Math.log(120) + 0.3 * noise)),
          startedAt: at + Math.floor(50 * random()),
        })
      );
    }
    const chunk = encodeChunk(day, checks);
    expect(chunk.length / checks.length).toBeLessThan(7);
    expect(checksOf(chunk)).toEqual(checks);
  });
});

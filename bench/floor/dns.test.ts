import { describe, expect, test } from "bun:test";
import { dnsAnswer } from "./dns.ts";

/** A query for one name and record type, as a resolver writes it. */
function query(id: number, name: string, type: number): Uint8Array {
  const labels = name
    .split(".")
    .flatMap((label) => [label.length, ...new TextEncoder().encode(label)]);
  return new Uint8Array([
    Math.floor(id / 256),
    id % 256,
    0x01,
    0x00,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    ...labels,
    0,
    Math.floor(type / 256),
    type % 256,
    0,
    1,
  ]);
}

/** A 16-bit field of a message. */
function word(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) * 256 + (bytes[at + 1] ?? 0);
}

describe("the target's DNS answer", () => {
  test("an A question gets one answer with the address, under the query's id", () => {
    const asked = query(0x12_34, "bench.test", 1);
    const answer = dnsAnswer(asked, "192.0.2.10");
    expect(answer).toBeDefined();
    if (!answer) {
      return;
    }
    expect(word(answer, 0)).toBe(0x12_34);
    expect(answer[2] ?? 0).toBeGreaterThanOrEqual(0x80);
    expect(word(answer, 4)).toBe(1);
    expect(word(answer, 6)).toBe(1);
    expect(answer.subarray(12, asked.length)).toEqual(asked.subarray(12));
    expect([...answer.subarray(-4)]).toEqual([192, 0, 2, 10]);
    expect(word(answer, answer.length - 6)).toBe(4);
  });

  test("any other question gets an answer with no records", () => {
    const answer = dnsAnswer(query(7, "bench.test", 15), "192.0.2.10");
    expect(answer && word(answer, 6)).toBe(0);
    expect(answer && word(answer, 4)).toBe(1);
  });

  test("a name whose label runs past the end gets nothing", () => {
    const asked = query(7, "bench.test", 1);
    const broken = new Uint8Array(asked);
    broken[12] = 60;
    expect(dnsAnswer(broken, "192.0.2.10")).toBeUndefined();
  });

  test("bytes too short for a question get nothing", () => {
    expect(dnsAnswer(new Uint8Array(5), "192.0.2.10")).toBeUndefined();
    expect(
      dnsAnswer(query(7, "bench.test", 1).subarray(0, 20), "192.0.2.10")
    ).toBeUndefined();
  });
});

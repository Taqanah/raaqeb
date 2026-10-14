import { describe, expect, test } from "bun:test";
import { withinLimit } from "./deadline.ts";

describe("waiting on the database within a limit", () => {
  test("an answer inside the limit is the answer", async () => {
    expect(await withinLimit(Promise.resolve(7), 1000)).toBe(7);
  });

  test("the database's own error inside the limit is that error", async () => {
    await expect(
      withinLimit(Promise.reject(new Error("no such table")), 1000)
    ).rejects.toThrow("no such table");
  });

  test("a database that never answers fails at the limit, naming it", async () => {
    const started = performance.now();
    await expect(
      withinLimit(new Promise<never>(() => undefined), 30)
    ).rejects.toThrow("did not answer within 30 ms");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("an answer after the limit changes nothing and raises nothing unhandled", async () => {
    const late = new Promise<number>((resolve) => setTimeout(resolve, 60, 1));
    await expect(withinLimit(late, 10)).rejects.toThrow();
    await late;
  });
});

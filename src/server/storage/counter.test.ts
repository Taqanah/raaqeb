import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  type Connection,
  closeConnection,
  type Executor,
  executor,
} from "./connection.ts";
import { bumpChangeCounter, readChangeCounter } from "./counter.ts";
import { connectTo, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";

let open: { connection: Connection; cleanup: () => Promise<void> } | undefined;

async function counter(): Promise<Executor> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  await migrateDatabase(connection);
  return executor(connection);
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

describe("the change counter", () => {
  test("advances by one per bump and answers the new value", async () => {
    const run = await counter();
    expect(await bumpChangeCounter(run)).toBe(1);
    expect(await bumpChangeCounter(run)).toBe(2);
    expect(await readChangeCounter(run)).toBe(2);
  });

  test("a missing counter row is an error, never a zero", async () => {
    const run = await counter();
    await run.run(sql`DELETE FROM change_counter`);
    await expect(bumpChangeCounter(run)).rejects.toThrow("change counter");
    await expect(readChangeCounter(run)).rejects.toThrow("change counter");
  });

  test("bumps that overlap are all counted", async () => {
    const run = await counter();
    const values = await Promise.all(
      Array.from({ length: 10 }, () => bumpChangeCounter(run))
    );
    expect(values.toSorted((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(await readChangeCounter(run)).toBe(10);
  });
});

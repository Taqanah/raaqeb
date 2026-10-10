/**
 * The change counter (CONTEXT.md): one install-wide number that
 * every write able to change public content advances. One row, id 1, seeded
 * by the first migration; the memo is valid while its copy matches.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "./connection.ts";

const rowId = 1;

/** The current value. Throws when the seeded row is gone: a silent zero would keep every memo valid forever. */
export async function readChangeCounter(executor: Executor): Promise<number> {
  const { changeCounter } = executor.tables;
  const rows = await executor.rows<{ value: number }>(
    sql`SELECT ${changeCounter.value} AS value FROM ${changeCounter} WHERE ${changeCounter.id} = ${rowId}`
  );
  return seededValue(rows);
}

/** Advances the counter by one and answers the new value. Throws when the seeded row is gone. */
export async function bumpChangeCounter(executor: Executor): Promise<number> {
  const { changeCounter } = executor.tables;
  const rows = await executor.rows<{ value: number }>(
    sql`UPDATE ${changeCounter} SET ${sql.identifier(changeCounter.value.name)} = ${changeCounter.value} + 1 WHERE ${changeCounter.id} = ${rowId} RETURNING ${changeCounter.value} AS value`
  );
  return seededValue(rows);
}

function seededValue(rows: { value: number }[]): number {
  const [row] = rows;
  if (!row) {
    throw new Error("the change counter row is missing from the database");
  }
  return row.value;
}

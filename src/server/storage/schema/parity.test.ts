import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import {
  SQLiteTable,
  getTableConfig as sqliteTableConfig,
} from "drizzle-orm/sqlite-core";
// biome-ignore lint/performance/noNamespaceImport: the parity test must see every table the file exports
import * as postgres from "./postgres.ts";
// biome-ignore lint/performance/noNamespaceImport: the parity test must see every table the file exports
import * as sqlite from "./sqlite.ts";

/**
 * The parity rule: the two schema files hold the same tables and
 * columns. Each column is reduced to what both dialects can say; the only
 * type pairs allowed are blob/bytea for packed rows and integer/bigint for
 * millisecond timestamps.
 */
interface ColumnShape {
  hasDefault: boolean;
  name: string;
  notNull: boolean;
  primary: boolean;
  storage: string;
}

interface TableShape {
  columns: ColumnShape[];
  name: string;
  primaryKeys: string[][];
}

/** The storage class both dialects share for a declared SQL type. */
function storageClass(sqlType: string): string {
  const type = sqlType.toLowerCase();
  if (type === "bigint" || type === "integer") {
    return "integer";
  }
  if (type === "bytea" || type === "blob") {
    return "blob";
  }
  return type;
}

function shapeOf(
  config: ReturnType<typeof sqliteTableConfig | typeof pgTableConfig>
): TableShape {
  return {
    columns: config.columns
      .map((column) => ({
        // SQLite's integer primary key is the rowid, which Drizzle reports as a default.
        hasDefault: column.primary ? false : column.hasDefault,
        name: column.name,
        notNull: column.notNull,
        primary: column.primary,
        storage: storageClass(column.getSQLType()),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    name: config.name,
    primaryKeys: config.primaryKeys.map((key) =>
      key.columns.map((column) => column.name).toSorted()
    ),
  };
}

function sqliteShapes(module: Record<string, unknown>): TableShape[] {
  return Object.values(module)
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => shapeOf(sqliteTableConfig(table)))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function postgresShapes(module: Record<string, unknown>): TableShape[] {
  return Object.values(module)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => shapeOf(pgTableConfig(table)))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

describe("the two schema files are one schema", () => {
  test("every table and column exists on both backends with the same shape", () => {
    expect(sqliteShapes(sqlite)).toEqual(postgresShapes(postgres));
  });

  test("the schema is not empty, and every export of each file is a table the comparison sees", () => {
    expect(Object.keys(sqlite).length).toBeGreaterThan(0);
    expect(sqliteShapes(sqlite)).toHaveLength(Object.keys(sqlite).length);
    expect(postgresShapes(postgres)).toHaveLength(Object.keys(postgres).length);
  });

  test("a table declared on one backend alone breaks parity", () => {
    const extra = { ...sqlite, orphan: sqlite.settings };
    expect(sqliteShapes(extra)).not.toEqual(postgresShapes(postgres));
  });

  test("a column that differs in nullability breaks parity", () => {
    const drifted = sqliteShapes(sqlite).map((table) => ({
      ...table,
      columns: table.columns.map((column) =>
        column.name === "value" ? { ...column, notNull: false } : column
      ),
    }));
    expect(drifted).not.toEqual(postgresShapes(postgres));
  });

  test("timestamps are 64-bit integers on both backends", () => {
    const exported: unknown[] = Object.values(postgres);
    const timestamps = exported
      .filter((value): value is PgTable => is(value, PgTable))
      .flatMap((table) => {
        const config = pgTableConfig(table);
        return config.columns
          .filter((column) => column.name.endsWith("_at"))
          .map(
            (column) => `${config.name}.${column.name} ${column.getSQLType()}`
          );
      });
    expect(timestamps.length).toBeGreaterThan(0);
    expect(timestamps.filter((column) => !column.endsWith(" bigint"))).toEqual(
      []
    );
    // Only the 64-bit pair and the packed-row pair share a storage class; any other type stays itself.
    expect(storageClass("bigint")).toBe("integer");
    expect(storageClass("integer")).toBe("integer");
    expect(storageClass("bytea")).toBe("blob");
    expect(storageClass("text")).toBe("text");
    expect(storageClass("timestamp")).toBe("timestamp");
  });
});

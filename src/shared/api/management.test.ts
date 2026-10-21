import { describe, expect, test } from "bun:test";
import {
  type ManagementOperation,
  managementOperations,
  managementPrefix,
} from "./management.ts";

const operations: [string, ManagementOperation][] =
  Object.entries(managementOperations);

describe("the management API's operations", () => {
  test("each sits under the one versioned prefix, at a method and path no other has", () => {
    const seen = new Set<string>();
    for (const [name, operation] of operations) {
      expect(`${name}: ${operation.path.startsWith(managementPrefix)}`).toBe(
        `${name}: true`
      );
      const where = `${operation.method} ${operation.path.toLowerCase()}`;
      expect(seen.has(where)).toBe(false);
      seen.add(where);
    }
  });

  test("a read takes no body, a list is a read, and only a write answers 201 or 204", () => {
    for (const [name, operation] of operations) {
      if (operation.method === "get") {
        expect(`${name}: ${operation.body === undefined}`).toBe(
          `${name}: true`
        );
        expect(`${name}: ${operation.status}`).toBe(`${name}: 200`);
      }
      if (operation.list) {
        expect(`${name}: ${operation.method}`).toBe(`${name}: get`);
      }
      if (operation.status === 204) {
        expect(`${name}: ${operation.answer === undefined}`).toBe(
          `${name}: true`
        );
      }
    }
  });

  test("each example is a body its operation accepts", () => {
    for (const [name, operation] of operations) {
      if (operation.example === undefined) {
        continue;
      }
      const parsed = operation.body?.safeParse(operation.example);
      expect(`${name}: ${parsed?.success}`).toBe(`${name}: true`);
    }
  });

  test("every operation that creates or changes a record shows an example body", () => {
    for (const [name, operation] of operations) {
      if (
        operation.body !== undefined &&
        (operation.method === "post" || operation.status === 201)
      ) {
        expect(`${name}: ${operation.example !== undefined}`).toBe(
          `${name}: true`
        );
      }
    }
  });
});

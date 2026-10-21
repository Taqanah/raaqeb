import { describe, expect, test } from "bun:test";
import {
  actionParts,
  auditedFunctions,
  unaudited,
} from "@/shared/domain/audit.ts";

/**
 * Every admin server function that changes something is an audit entry:
 * `permitted` writes one for each POST behind it that answers no refusal,
 * with the action `auditedFunctions` names. The source is read for every
 * POST server function behind a permission, so a new one in neither that
 * table nor `unaudited` fails here, as a missing permission fails
 * -permissions.test.ts.
 */
const routes = `${import.meta.dir}`;
const declaration =
  /const (\w+) = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[permitted\(/g;

async function postsBehindPermission(): Promise<string[]> {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: routes })
  );
  const found: string[] = [];
  for (const file of files.filter((one) => !one.includes(".test."))) {
    // biome-ignore lint/performance/noAwaitInLoops: a few dozen files, read once
    const text = await Bun.file(`${routes}/${file}`).text();
    for (const match of text.matchAll(declaration)) {
      found.push(`${file} ${match[1]}`);
    }
  }
  return found.toSorted((a, b) => a.localeCompare(b));
}

describe("the audit log's coverage", () => {
  test("names every POST server function behind a permission, as audited or as changing nothing kept", async () => {
    const posts = await postsBehindPermission();
    const covered = new Set([...Object.keys(auditedFunctions), ...unaudited]);
    expect(posts.filter((key) => !covered.has(key))).toEqual([]);
  });

  test("names no server function that is gone, and none twice", async () => {
    const posts = new Set(await postsBehindPermission());
    const named = [...Object.keys(auditedFunctions), ...unaudited];
    expect(named.filter((key) => !posts.has(key))).toEqual([]);
    expect(new Set(named).size).toBe(named.length);
  });

  test("gives each audited one an action the log page words", () => {
    for (const [key, action] of Object.entries(auditedFunctions)) {
      expect(`${key}: ${actionParts(action) !== undefined}`).toBe(
        `${key}: true`
      );
    }
  });
});

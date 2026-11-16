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
// Every server function behind a permission, with the options it was made with as written.
const declaration =
  /const (\w+) = createServerFn\(([^)]*)\)\s*\.middleware\(\[permitted\(/g;
// The options this test can read a method from: none (Start's GET) or a literal method.
const readable = /^(?:\{ method: "(GET|POST)" \})?$/;

/** Each server function behind a permission by `file name`, with its method, or `unread` when its options are not a literal this test can read. */
async function behindPermission(): Promise<Map<string, string>> {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: routes })
  );
  const found = new Map<string, string>();
  for (const file of files.filter((one) => !one.includes(".test."))) {
    // biome-ignore lint/performance/noAwaitInLoops: a few dozen files, read once
    const text = await Bun.file(`${routes}/${file}`).text();
    for (const match of text.matchAll(declaration)) {
      const options = readable.exec(match[2] ?? "");
      found.set(
        `${file} ${match[1]}`,
        options ? (options[1] ?? "GET") : "unread"
      );
    }
  }
  return found;
}

async function postsBehindPermission(): Promise<string[]> {
  return [...(await behindPermission())]
    .filter(([, method]) => method === "POST")
    .map(([key]) => key)
    .toSorted((a, b) => a.localeCompare(b));
}

describe("the audit log's coverage", () => {
  test("names every POST server function behind a permission, as audited or as changing nothing kept", async () => {
    const posts = await postsBehindPermission();
    const covered = new Set([...Object.keys(auditedFunctions), ...unaudited]);
    expect(posts.filter((key) => !covered.has(key))).toEqual([]);
  });

  test("reads the method of every server function behind a permission, so a POST is never taken for a GET", async () => {
    const unread = [...(await behindPermission())]
      .filter(([, method]) => method === "unread")
      .map(([key]) => key);
    expect(unread).toEqual([]);
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

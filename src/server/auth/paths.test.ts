import { afterAll, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage } from "@/server/storage/storage.ts";
import { type AuthMail, createAuth } from "./auth.ts";
import { allowedPaths, disabledPaths, unblockablePaths } from "./paths.ts";

// The tripwire for a Better Auth upgrade: disabledPaths subtracts
// from whatever Better Auth mounts, so a new endpoint is live the moment the
// dependency moves unless a list here names it. Both directions are pinned:
// nothing mounted goes untriaged, and nothing listed is stale.

/** A mail that sends nothing; the tests of the recovery paths hand their own. */
const silentMail: AuthMail = {
  code: () => Promise.resolve(),
  resetLink: () => Promise.resolve(),
};

const scratch = await scratchDatabase();
const opened = await openStorage(scratch.location);
if (!opened.ok) {
  throw new Error(opened.message);
}
const auth = createAuth({
  baseURL: "http://raaqeb.test",
  database: opened.storage.authDatabase,
  log: () => undefined,
  mail: silentMail,
  secrets: "1:test-secret-test-secret-test-secret-test",
});
const mounted = [
  ...new Set(
    Object.values(auth.api)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === "string")
  ),
].toSorted((a, b) => a.localeCompare(b));

afterAll(async () => {
  await opened.storage.close();
  await scratch.cleanup();
});

describe("every endpoint Better Auth mounts is triaged", () => {
  test("each mounted path is allowed, disabled or unblockable", () => {
    const accounted = new Set([
      ...allowedPaths,
      ...disabledPaths,
      ...unblockablePaths,
    ]);
    expect(mounted.filter((path) => !accounted.has(path))).toEqual([]);
  });

  test("each listed path still exists upstream, so a rename cannot leave a dead entry and a live route", () => {
    const listed = [...allowedPaths, ...disabledPaths, ...unblockablePaths];
    expect(listed.filter((path) => !mounted.includes(path))).toEqual([]);
  });

  test("the routes with a parameter are exactly the unblockable ones", () => {
    expect(mounted.filter((path) => path.includes(":"))).toEqual(
      [...unblockablePaths].toSorted((a, b) => a.localeCompare(b))
    );
  });

  test("a path is on one list only", () => {
    const all = [...allowedPaths, ...disabledPaths, ...unblockablePaths];
    expect(new Set(all).size).toBe(all.length);
  });

  test("the browser may call sign-in, sign-out, the reset request and reset, the emailed code's send and verify, and the app's and backup codes' verify, nothing else", () => {
    expect([...allowedPaths].toSorted()).toEqual([
      "/request-password-reset",
      "/reset-password",
      "/sign-in/email",
      "/sign-out",
      "/two-factor/send-otp",
      "/two-factor/verify-backup-code",
      "/two-factor/verify-otp",
      "/two-factor/verify-totp",
    ]);
  });
});
